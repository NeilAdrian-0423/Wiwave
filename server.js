import express from 'express';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOMS = ['general', 'room-2', 'room-3'];

if (!fs.existsSync('cert.pem') || !fs.existsSync('key.pem')) {
  console.error('Missing cert.pem / key.pem. Run: npm run cert');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Serve RNNoise + our worklet processor as a single AudioWorklet module.
// rnnoise-sync.js uses `import.meta.url` which is invalid in a classic worklet,
// so we stub it out. The WASM binary is inlined as base64, so no network fetch.
let cachedWorklet = null;
app.get('/worklet.js', (_req, res) => {
  if (!cachedWorklet) {
    const rnnoise = fs
      .readFileSync(
        path.join(__dirname, 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'),
        'utf8',
      )
      .replace('var _scriptDir = import.meta.url;', 'var _scriptDir = "";')
      .replace(/^export default .*$/m, '');
    const processor = fs.readFileSync(path.join(__dirname, 'public/worklet-processor.js'), 'utf8');
    cachedWorklet = rnnoise + '\n' + processor;
  }
  res.type('application/javascript').send(cachedWorklet);
});

app.get('/api/rooms', (_req, res) => {
  res.json(
    ROOMS.map((name) => {
      const members = rooms.get(name);
      const users = members ? [...members.values()].map((m) => m.username) : [];
      return { name, users };
    }),
  );
});

const server = https.createServer(
  {
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem'),
  },
  app,
);

const wss = new WebSocketServer({ server });

// roomName -> Map<id, { ws, username }>
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const members = rooms.get(room);
  if (!members) return;
  for (const [id, m] of members) {
    if (id === exceptId) continue;
    send(m.ws, msg);
  }
}

function sendTo(room, toId, msg) {
  const members = rooms.get(room);
  const m = members?.get(toId);
  if (m) send(m.ws, msg);
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  let room = null;

  const cleanup = () => {
    if (!room) return;
    const members = rooms.get(room);
    if (members) {
      members.delete(id);
      if (members.size === 0) rooms.delete(room);
      else broadcast(room, { type: 'peer-left', id }, id);
    }
    room = null;
  };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (room) return;
      if (!ROOMS.includes(msg.room)) {
        send(ws, { type: 'error', message: 'unknown room' });
        return;
      }
      room = msg.room;
      const username = String(msg.username || 'anon').slice(0, 32);
      if (!rooms.has(room)) rooms.set(room, new Map());
      const members = rooms.get(room);
      const peers = [...members].map(([pid, m]) => ({ id: pid, username: m.username }));
      members.set(id, { ws, username });
      send(ws, { type: 'welcome', id, peers });
      broadcast(room, { type: 'peer-joined', id, username }, id);
      return;
    }

    if (!room) return;

    if (msg.type === 'offer' || msg.type === 'answer') {
      sendTo(room, msg.to, { type: msg.type, from: id, sdp: msg.sdp });
      return;
    }

    if (msg.type === 'ice') {
      sendTo(room, msg.to, { type: 'ice', from: id, candidate: msg.candidate });
      return;
    }

    if (msg.type === 'leave') {
      cleanup();
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`voicechat listening on :${PORT}`);
  const ips = lanAddresses();
  if (ips.length === 0) {
    console.log('  (no LAN interface detected — turn on hotspot first)');
  } else {
    for (const ip of ips) console.log(`  https://${ip}:${PORT}`);
  }
});

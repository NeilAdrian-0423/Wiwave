const rtcConfig = { iceServers: [] }; // LAN only — no STUN needed

const state = {
  ws: null,
  selfId: null,
  username: null,
  room: null,
  localStream: null,    // raw mic
  processedStream: null, // post-worklet, what we send to peers
  audioCtx: null,
  workletNode: null,
  peers: new Map(), // peerId -> { pc, username, audioEl, active }
  muted: false,
  dsp: {
    rnnoise: loadPref('voicechat:rnnoise', true),
    gate: loadPref('voicechat:gate', true),
    threshold: Number(localStorage.getItem('voicechat:threshold') ?? -50),
  },
};

function loadPref(key, fallback) {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

const $ = (sel) => document.querySelector(sel);

// -------- view switching --------

function show(viewId) {
  for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
  $(`#${viewId}`).classList.remove('hidden');
}

// -------- name --------

function initName() {
  const saved = localStorage.getItem('voicechat:name');
  if (saved) {
    state.username = saved;
    $('#name-input').value = saved;
  }

  $('#name-continue').addEventListener('click', () => {
    const v = $('#name-input').value.trim();
    if (!v) return;
    state.username = v;
    localStorage.setItem('voicechat:name', v);
    goToRooms();
  });

  $('#name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#name-continue').click();
  });

  $('#name-change').addEventListener('click', () => show('view-name'));
}

// -------- rooms --------

let roomsPollTimer = null;

async function refreshRooms() {
  let rooms;
  try {
    const res = await fetch('/api/rooms');
    rooms = await res.json();
  } catch {
    return;
  }
  const list = $('#rooms-list');
  list.innerHTML = '';
  for (const r of rooms) {
    const li = document.createElement('li');
    li.addEventListener('click', () => joinRoom(r.name));
    const count = r.users.length;
    const summary = count === 0 ? 'empty' : `${count} · ${r.users.map(escapeHtml).join(', ')}`;
    li.innerHTML = `<div class="room-name">${escapeHtml(r.name)}</div><div class="room-users">${summary}</div>`;
    list.appendChild(li);
  }
}

async function goToRooms() {
  $('#rooms-header-name').textContent = state.username;
  show('view-rooms');
  await refreshRooms();
  clearInterval(roomsPollTimer);
  roomsPollTimer = setInterval(() => {
    if ($('#view-rooms').classList.contains('hidden')) {
      clearInterval(roomsPollTimer);
      roomsPollTimer = null;
      return;
    }
    refreshRooms();
  }, 2000);
}

// -------- room / webrtc --------

async function joinRoom(room) {
  setStatus('requesting microphone…');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    alert('Microphone access was denied: ' + err.message);
    return;
  }

  try {
    await setupDsp(state.localStream);
  } catch (err) {
    console.warn('DSP setup failed, falling back to raw mic:', err);
    state.processedStream = state.localStream;
  }

  state.room = room;
  $('#room-title').textContent = `${room} · ${state.username}`;
  renderPeers();
  show('view-room');
  setStatus('connecting…');

  const ws = new WebSocket(`wss://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room, username: state.username }));
  });
  ws.addEventListener('message', (ev) => onSignal(JSON.parse(ev.data)));
  ws.addEventListener('close', () => setStatus('disconnected'));
  ws.addEventListener('error', () => setStatus('connection error'));
}

async function onSignal(msg) {
  if (msg.type === 'welcome') {
    state.selfId = msg.id;
    setStatus(msg.peers.length === 0 ? 'waiting for others…' : 'connecting to peers…');
    for (const p of msg.peers) await createPeerAsOfferer(p.id, p.username);
    return;
  }

  if (msg.type === 'peer-joined') {
    ensurePeerRecord(msg.id, msg.username);
    renderPeers();
    setStatus(`${msg.username} joined`);
    // the joiner sends us the offer
    return;
  }

  if (msg.type === 'peer-left') {
    removePeer(msg.id);
    renderPeers();
    return;
  }

  if (msg.type === 'offer') {
    await handleOffer(msg.from, msg.sdp);
    return;
  }

  if (msg.type === 'answer') {
    const peer = state.peers.get(msg.from);
    if (peer) await peer.pc.setRemoteDescription(msg.sdp);
    return;
  }

  if (msg.type === 'ice') {
    const peer = state.peers.get(msg.from);
    if (peer) {
      try { await peer.pc.addIceCandidate(msg.candidate); } catch {}
    }
    return;
  }
}

function ensurePeerRecord(id, username) {
  let peer = state.peers.get(id);
  if (!peer) {
    peer = { pc: null, username, active: false };
    state.peers.set(id, peer);
  } else if (username) {
    peer.username = username;
  }
  return peer;
}

function makePC(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);

  const outStream = state.processedStream || state.localStream;
  for (const track of outStream.getTracks()) {
    pc.addTrack(track, outStream);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: e.candidate }));
    }
  };

  pc.ontrack = (e) => {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    if (!peer.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      $('#audio-sink').appendChild(el);
      peer.audioEl = el;
    }
    peer.audioEl.srcObject = e.streams[0];
    peer.active = true;
    renderPeers();
  };

  pc.onconnectionstatechange = () => {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    const s = pc.connectionState;
    peer.active = s === 'connected';
    if (s === 'failed' || s === 'disconnected' || s === 'closed') peer.active = false;
    renderPeers();
  };

  return pc;
}

async function createPeerAsOfferer(id, username) {
  const peer = ensurePeerRecord(id, username);
  peer.pc = makePC(id);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  state.ws.send(JSON.stringify({ type: 'offer', to: id, sdp: peer.pc.localDescription }));
  renderPeers();
}

async function handleOffer(fromId, sdp) {
  const peer = ensurePeerRecord(fromId);
  if (!peer.pc) peer.pc = makePC(fromId);
  await peer.pc.setRemoteDescription(sdp);
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  state.ws.send(JSON.stringify({ type: 'answer', to: fromId, sdp: peer.pc.localDescription }));
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  try { peer.pc?.close(); } catch {}
  peer.audioEl?.remove();
  state.peers.delete(id);
}

function renderPeers() {
  const list = $('#peers-list');
  list.innerHTML = '';

  const selfLi = document.createElement('li');
  selfLi.className = 'self';
  selfLi.innerHTML = `<span class="dot active"></span><span>${escapeHtml(state.username)} <small style="color:var(--text-dim)">(you)</small></span>`;
  list.appendChild(selfLi);

  for (const [id, peer] of state.peers) {
    const li = document.createElement('li');
    li.dataset.peer = id;
    const dot = peer.active ? 'dot active' : 'dot';
    li.innerHTML = `<span class="${dot}"></span><span>${escapeHtml(peer.username || 'anon')}</span>`;
    list.appendChild(li);
  }
}

async function setupDsp(micStream) {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      state.audioCtx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      state.audioCtx = new Ctx();
    }
    await state.audioCtx.audioWorklet.addModule('/worklet.js');
  }
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();

  const src = state.audioCtx.createMediaStreamSource(micStream);
  const node = new AudioWorkletNode(state.audioCtx, 'voice-processor');
  const dst = state.audioCtx.createMediaStreamDestination();
  src.connect(node).connect(dst);

  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'meter') updateMeter(d.db, d.gain);
    if (d.type === 'ready') {
      const rnToggle = $('#dsp-rnnoise');
      if (!d.rnnoise) {
        rnToggle.checked = false;
        rnToggle.disabled = true;
        $('#dsp-rnnoise-note').textContent = `unavailable (${d.reason || 'unknown'})`;
      } else {
        rnToggle.disabled = false;
        $('#dsp-rnnoise-note').textContent = '';
      }
    }
  };

  state.workletNode = node;
  state.processedStream = dst.stream;

  // Push current settings to the worklet
  postDsp('rnnoise', state.dsp.rnnoise);
  postDsp('gate', state.dsp.gate);
  postDsp('threshold', state.dsp.threshold);
}

function postDsp(type, value) {
  state.workletNode?.port.postMessage({ type, value });
}

function updateMeter(db, gain) {
  const bar = $('#meter-bar');
  const thr = $('#meter-threshold');
  if (!bar) return;
  // Map -80..0 dB to 0..100%
  const pct = Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
  bar.style.width = pct + '%';
  bar.classList.toggle('open', gain > 0.5);
  const tPct = Math.max(0, Math.min(100, ((state.dsp.threshold + 80) / 80) * 100));
  thr.style.left = tPct + '%';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function setStatus(s) {
  $('#status').textContent = s;
}

function leave() {
  try { state.ws?.send(JSON.stringify({ type: 'leave' })); } catch {}
  try { state.ws?.close(); } catch {}
  state.ws = null;

  for (const [id] of state.peers) removePeer(id);

  try { state.workletNode?.disconnect(); } catch {}
  state.workletNode = null;
  state.processedStream?.getTracks().forEach((t) => t.stop());
  state.processedStream = null;

  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.room = null;
  state.muted = false;
  $('#mute-btn').classList.remove('muted');
  $('#mute-btn').textContent = 'Mute';
  setStatus('');
  goToRooms();
}

function toggleMute() {
  state.muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  const btn = $('#mute-btn');
  btn.classList.toggle('muted', state.muted);
  btn.textContent = state.muted ? 'Unmute' : 'Mute';
}

// -------- init --------

initName();
$('#leave-btn').addEventListener('click', leave);
$('#mute-btn').addEventListener('click', toggleMute);

// DSP controls
const rnToggle = $('#dsp-rnnoise');
const gateToggle = $('#dsp-gate');
const thrSlider = $('#dsp-threshold');
const thrValue = $('#dsp-threshold-value');

rnToggle.checked = state.dsp.rnnoise;
gateToggle.checked = state.dsp.gate;
thrSlider.value = state.dsp.threshold;
thrValue.textContent = `${state.dsp.threshold} dB`;

rnToggle.addEventListener('change', () => {
  state.dsp.rnnoise = rnToggle.checked;
  localStorage.setItem('voicechat:rnnoise', rnToggle.checked ? '1' : '0');
  postDsp('rnnoise', rnToggle.checked);
});
gateToggle.addEventListener('change', () => {
  state.dsp.gate = gateToggle.checked;
  localStorage.setItem('voicechat:gate', gateToggle.checked ? '1' : '0');
  postDsp('gate', gateToggle.checked);
});
thrSlider.addEventListener('input', () => {
  const v = Number(thrSlider.value);
  state.dsp.threshold = v;
  thrValue.textContent = `${v} dB`;
  localStorage.setItem('voicechat:threshold', String(v));
  postDsp('threshold', v);
});

$('#dsp-toggle').addEventListener('click', () => {
  $('#dsp-panel').classList.toggle('open');
});

window.addEventListener('beforeunload', () => {
  try { state.ws?.send(JSON.stringify({ type: 'leave' })); } catch {}
});

if (state.username) goToRooms();
else show('view-name');

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
  joining: false,
  leaving: false,
  dsp: {
    rnnoise: loadBoolPref('voicechat:rnnoise', true),
    gate: loadBoolPref('voicechat:gate', true),
    threshold: loadThresholdPref(),
  },
};

function loadBoolPref(key, fallback) {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

function loadThresholdPref() {
  const v = Number(localStorage.getItem('voicechat:threshold'));
  return Number.isFinite(v) && v >= -80 && v <= 0 ? v : -50;
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
  const list = $('#rooms-list');
  let rooms;
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) throw new Error(`status ${res.status}`);
    rooms = await res.json();
    if (!Array.isArray(rooms)) throw new Error('bad payload');
  } catch {
    if (!list.querySelector('li:not(.placeholder)')) {
      list.innerHTML = '<li class="placeholder">can\'t reach the server — retrying…</li>';
    }
    return;
  }

  if (rooms.length === 0) {
    list.innerHTML = '<li class="placeholder">no rooms configured.</li>';
    return;
  }

  list.innerHTML = '';
  for (const r of rooms) {
    const li = document.createElement('li');
    li.className = 'room-row';
    li.addEventListener('click', () => joinRoom(r.name));
    const count = r.users.length;
    const occupants = count === 0
      ? '<span class="room-users dim">empty</span>'
      : `<span class="room-users">${escapeHtml(r.users.join(' · '))}</span>`;
    const indicator = count === 0
      ? ''
      : `<span class="room-indicator" aria-label="${count} in this room"></span>`;
    li.innerHTML = `
      <div class="room-main">
        <div class="room-name">${escapeHtml(r.name)}</div>
        <div class="room-meta">${occupants}</div>
      </div>
      ${indicator}
    `;
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
  if (state.joining || state.room) return;
  state.joining = true;

  setStatus('requesting microphone…');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    state.joining = false;
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
  $('#room-title').textContent = room;
  renderPeers();
  show('view-room');
  setStatus('connecting…');

  const ws = new WebSocket(`wss://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room, username: state.username }));
  });
  ws.addEventListener('message', (ev) => {
    try { onSignal(JSON.parse(ev.data)); } catch {}
  });
  ws.addEventListener('close', () => {
    if (state.room && !state.leaving) {
      setStatus('disconnected from server');
      leave();
    } else {
      setStatus('disconnected');
    }
  });
  ws.addEventListener('error', () => setStatus('connection error'));

  state.joining = false;
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

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderPeers() {
  const list = $('#peers-list');
  list.innerHTML = '';

  const selfLi = document.createElement('li');
  selfLi.className = 'peer-chip self active';
  selfLi.innerHTML = `
    <span class="peer-square" aria-hidden="true">${escapeHtml(initials(state.username))}</span>
    <span class="peer-name">${escapeHtml(state.username)}<small class="peer-self-tag">you</small></span>
  `;
  list.appendChild(selfLi);

  for (const [id, peer] of state.peers) {
    const li = document.createElement('li');
    li.className = 'peer-chip' + (peer.active ? ' active' : '');
    li.dataset.peer = id;
    const name = peer.username || 'anon';
    li.innerHTML = `
      <span class="peer-square" aria-hidden="true">${escapeHtml(initials(name))}</span>
      <span class="peer-name">${escapeHtml(name)}</span>
    `;
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
  if (!bar) return;
  const pct = Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
  bar.style.setProperty('--level', pct + '%');
  const open = gain > 0.5;
  bar.classList.toggle('open', state.dsp.gate && open);
  const label = document.querySelector('.meter-state');
  if (label) {
    label.textContent = !state.dsp.gate
      ? 'gate off'
      : (open ? 'gate open' : 'gate closed');
  }
}

function renderThreshold(v) {
  v = Math.max(-80, Math.min(0, Math.round(v)));
  state.dsp.threshold = v;
  const thr = $('#meter-threshold');
  const label = $('#dsp-threshold-value');
  if (thr) {
    thr.style.setProperty('--pos', ((v + 80) / 80 * 100) + '%');
    thr.setAttribute('aria-valuenow', String(v));
    thr.setAttribute('aria-valuetext', `${v} decibels`);
  }
  if (label) label.textContent = (v >= 0 ? '' : '−') + Math.abs(v);
  try { localStorage.setItem('voicechat:threshold', String(v)); } catch {}
  postDsp('threshold', v);
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
  if (state.leaving) return;
  state.leaving = true;

  try { state.ws?.send(JSON.stringify({ type: 'leave' })); } catch {}
  try { state.ws?.close(); } catch {}
  state.ws = null;

  for (const [id] of [...state.peers]) removePeer(id);

  try { state.workletNode?.disconnect(); } catch {}
  state.workletNode = null;
  state.processedStream?.getTracks().forEach((t) => t.stop());
  state.processedStream = null;

  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.room = null;
  state.muted = false;
  setMuteButton(false);

  state.leaving = false;
  goToRooms();
}

function setMuteButton(muted) {
  const btn = $('#mute-btn');
  if (!btn) return;
  btn.classList.toggle('muted', muted);
  const label = btn.querySelector('.btn-label');
  const sub = btn.querySelector('.btn-sub');
  if (label) label.textContent = muted ? 'unmute' : 'mute';
  if (sub) sub.textContent = muted ? 'nobody can hear you' : 'everyone can hear you';
}

function toggleMute() {
  state.muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  setMuteButton(state.muted);
}

// -------- init --------

initName();
$('#leave-btn').addEventListener('click', leave);
$('#mute-btn').addEventListener('click', toggleMute);

// DSP toggles
const rnToggle = $('#dsp-rnnoise');
const gateToggle = $('#dsp-gate');

rnToggle.checked = state.dsp.rnnoise;
gateToggle.checked = state.dsp.gate;

rnToggle.addEventListener('change', () => {
  state.dsp.rnnoise = rnToggle.checked;
  localStorage.setItem('voicechat:rnnoise', rnToggle.checked ? '1' : '0');
  postDsp('rnnoise', rnToggle.checked);
});
gateToggle.addEventListener('change', () => {
  state.dsp.gate = gateToggle.checked;
  localStorage.setItem('voicechat:gate', gateToggle.checked ? '1' : '0');
  postDsp('gate', gateToggle.checked);
  document.getElementById('meter').classList.toggle('inert', !gateToggle.checked);
});
document.getElementById('meter').classList.toggle('inert', !state.dsp.gate);

// Threshold: draggable handle on the meter
renderThreshold(state.dsp.threshold);
{
  const meter = $('#meter');
  const handle = $('#meter-threshold');

  function dbFromClientX(clientX) {
    const rect = meter.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * 80 - 80);
  }

  let dragging = false;
  const startDrag = (e) => {
    if (!state.dsp.gate) return;
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    renderThreshold(dbFromClientX(e.clientX));
    e.preventDefault();
  };
  const moveDrag = (e) => {
    if (!dragging) return;
    renderThreshold(dbFromClientX(e.clientX));
  };
  const endDrag = (e) => {
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
  };
  handle.addEventListener('pointerdown', startDrag);
  handle.addEventListener('pointermove', moveDrag);
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Tap elsewhere on the meter jumps the handle
  meter.addEventListener('pointerdown', (e) => {
    if (!state.dsp.gate) return;
    if (e.target === handle || handle.contains(e.target)) return;
    renderThreshold(dbFromClientX(e.clientX));
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1;
    let v = state.dsp.threshold;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step;
    else if (e.key === 'Home') v = -80;
    else if (e.key === 'End') v = 0;
    else return;
    e.preventDefault();
    renderThreshold(v);
  });
}

$('#dsp-toggle').addEventListener('click', () => {
  $('#dsp-panel').classList.toggle('open');
});

// Mobile browsers often skip `beforeunload`; `pagehide` fires reliably.
function sendLeaveBeacon() {
  try { state.ws?.send(JSON.stringify({ type: 'leave' })); } catch {}
}
window.addEventListener('beforeunload', sendLeaveBeacon);
window.addEventListener('pagehide', sendLeaveBeacon);

// Backgrounding the tab on mobile suspends the AudioContext. Resume when
// the user returns, otherwise the worklet silently stops processing.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.audioCtx?.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }
});

if (state.username) goToRooms();
else show('view-name');

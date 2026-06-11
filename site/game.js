'use strict';

/*
 * Cathedral — HTML/JS port of the 2001 Flash original.
 *
 * Speaks the original XMLSocket protocol (null-terminated XML elements:
 * MOTION / YOURTURN / ALIVE) over a WebSocket, so it interoperates with
 * the SWF running in Ruffle against the same xmlsocket_server + websockify.
 */

const GRID = 25;
const STAGE_W = 780;
const STAGE_H = 500;
const SVGNS = 'http://www.w3.org/2000/svg';

// Original stacking order of the pieces on the SWF timeline (bottom to top).
const DEPTH_ORDER = [15, 17, 19, 22, 23, 25, 27, 26, 28, 21, 0, 20, 24,
                     10, 14, 7, 11, 12, 5, 6, 9, 8, 3, 4, 1, 2, 13, 16, 18];

// ALIVE keepalive every 41 ticks at 12 fps; peer considered gone after 120 ticks.
const ALIVE_SEND_MS = Math.round(41 / 12 * 1000);
const ALIVE_TIMEOUT_MS = Math.round(120 / 12 * 1000);
const DRAG_SEND_MS = 100;

const stage = document.getElementById('stage');
const scaler = document.getElementById('scaler');
const piecesLayer = document.getElementById('pieces');
const endturnBtn = document.getElementById('endturn');
const resetBtn = document.getElementById('resetbtn');
const failnotice = document.getElementById('failnotice');
const opstatus = document.getElementById('opstatus');

let origin = '';            // my name (uppercased, like the SWF)
let target = '';            // opponent name
let selected = -1;          // last grabbed piece (SPACE rotates it)
let zTop = 100;
let ws = null;
let inGame = false;
let lastPeerAlive = 0;
let recvBuf = [];
const turnsound = new Audio('assets/turnsound.mp3');

// ---------- pieces ----------

const state = {};           // id -> {x, y, rot, el}
const resetPositions = PIECES.map(p => ({
  id: p.id, x: Math.round(p.x), y: Math.round(p.y), rot: p.rot,
}));

function normRot(r) {
  r = ((r % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;   // Flash _rotation is -180..180
}

function positionPiece(p) {
  const s = SHAPES[PIECES[p.id].shape];
  p.el.style.left = (p.x - s.rx) + 'px';
  p.el.style.top = (p.y - s.ry) + 'px';
  p.el.style.transform = `rotate(${p.rot}deg)`;
}

function buildPieces() {
  for (const id of DEPTH_ORDER) {
    const def = PIECES.find(p => p.id === id);
    const s = SHAPES[def.shape];
    const el = document.createElementNS(SVGNS, 'svg');
    el.setAttribute('width', s.w);
    el.setAttribute('height', s.h);
    el.setAttribute('viewBox', `0 0 ${s.w} ${s.h}`);
    el.classList.add('piece');
    el.dataset.id = id;
    el.innerHTML = `<g transform="translate(${s.rx} ${s.ry})">${s.paths}</g>`;
    el.style.transformOrigin = `${s.rx}px ${s.ry}px`;
    piecesLayer.appendChild(el);
    state[id] = { id, x: def.x, y: def.y, rot: def.rot, el };
    positionPiece(state[id]);
    el.addEventListener('pointerdown', e => startDrag(e, id));
  }
}

// ---------- dragging ----------

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * STAGE_W / r.width,
    y: (e.clientY - r.top) * STAGE_H / r.height,
  };
}

function startDrag(e, id) {
  e.preventDefault();
  const p = state[id];
  selected = id;
  p.el.style.zIndex = ++zTop;
  p.el.classList.add('dragging');
  const at = stagePoint(e);
  const grabX = at.x - p.x;
  const grabY = at.y - p.y;
  let lastSent = 0;

  const move = ev => {
    const m = stagePoint(ev);
    p.x = m.x - grabX;
    p.y = m.y - grabY;
    positionPiece(p);
    const now = performance.now();
    if (now - lastSent > DRAG_SEND_MS) {
      lastSent = now;
      sendMove(id);
    }
  };
  const up = () => {
    p.el.classList.remove('dragging');
    p.el.removeEventListener('pointermove', move);
    p.el.removeEventListener('pointerup', up);
    p.el.removeEventListener('pointercancel', up);
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
    positionPiece(p);
    sendMove(id);
  };
  p.el.setPointerCapture(e.pointerId);
  p.el.addEventListener('pointermove', move);
  p.el.addEventListener('pointerup', up);
  p.el.addEventListener('pointercancel', up);
}

function rotateSelected() {
  if (selected < 0) return;
  const p = state[selected];
  p.rot = normRot(p.rot + 90);
  positionPiece(p);
  sendMove(selected);
}

document.addEventListener('keydown', e => {
  if (inGame && e.code === 'Space') e.preventDefault();
});
document.addEventListener('keyup', e => {
  if (inGame && e.code === 'Space') rotateSelected();
});

// Rotate on double-click/double-tap too (for touch devices).
piecesLayer.addEventListener('dblclick', e => {
  const el = e.target.closest('.piece');
  if (el) {
    selected = +el.dataset.id;
    rotateSelected();
  }
});

// ---------- networking ----------

function wsUrl() {
  const param = new URLSearchParams(location.search).get('ws');
  if (param) return param;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return scheme + location.host + '/ws';
  }
  return null;   // file:// — offline mode
}

function connect() {
  const url = wsUrl();
  if (!url || !inGame) return;
  try {
    ws = new WebSocket(url);
  } catch {
    ws = null;
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onmessage = ev => {
    const bytes = typeof ev.data === 'string'
      ? new TextEncoder().encode(ev.data)
      : new Uint8Array(ev.data);
    for (const b of bytes) {
      if (b === 0) {
        const text = new TextDecoder().decode(new Uint8Array(recvBuf));
        recvBuf = [];
        if (text.trim()) handleMessage(text);
      } else {
        recvBuf.push(b);
      }
    }
  };
  ws.onclose = () => {
    ws = null;
    if (inGame) setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
}

function wsSend(str) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const bytes = new TextEncoder().encode(str + '\0');
    ws.send(bytes);
  }
}

function xmlEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendMove(id) {
  const p = state[id];
  wsSend(`<MOTION id="${id}" x="${Math.round(p.x)}" y="${Math.round(p.y)}"` +
         ` rot="${Math.round(normRot(p.rot))}" target="${xmlEsc(target)}"` +
         ` origin="${xmlEsc(origin)}" />`);
}

function handleMessage(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'text/xml');
  } catch {
    return;
  }
  const m = doc.documentElement;
  if (!m || m.nodeName === 'parsererror') return;
  // Same filter as the SWF: addressed to me, from my opponent.
  if (m.getAttribute('target') !== origin || m.getAttribute('origin') !== target) return;

  if (m.nodeName === 'MOTION') {
    const p = state[+m.getAttribute('id')];
    if (!p) return;
    p.x = +m.getAttribute('x');
    p.y = +m.getAttribute('y');
    p.rot = +m.getAttribute('rot');
    positionPiece(p);
  } else if (m.nodeName === 'YOURTURN') {
    endturnBtn.classList.remove('dim');
    turnsound.play().catch(() => {});
  } else if (m.nodeName === 'ALIVE') {
    lastPeerAlive = Date.now();
  }
}

// ---------- buttons ----------

endturnBtn.addEventListener('click', () => {
  endturnBtn.classList.add('dim');
  wsSend(`<YOURTURN target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
});

resetBtn.addEventListener('click', () => {
  for (const r of resetPositions) {
    // Like the SWF: reset the opponent's board, then our own via the
    // server echo (the server broadcasts to all clients, including us).
    wsSend(`<MOTION id="${r.id}" x="${r.x}" y="${r.y}" rot="${r.rot}"` +
           ` target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
    wsSend(`<MOTION id="${r.id}" x="${r.x}" y="${r.y}" rot="${r.rot}"` +
           ` target="${xmlEsc(origin)}" origin="${xmlEsc(target)}" />`);
    // Also apply locally so reset works offline.
    const p = state[r.id];
    p.x = r.x;
    p.y = r.y;
    p.rot = r.rot;
    positionPiece(p);
  }
});

// ---------- status ----------

function updateStatus() {
  const peerOk = ws && ws.readyState === WebSocket.OPEN &&
                 Date.now() - lastPeerAlive < ALIVE_TIMEOUT_MS;
  failnotice.style.display = peerOk ? 'none' : 'block';
  opstatus.textContent = peerOk
    ? `${origin} connected to ${target}`
    : 'no opponent connected';
}

// ---------- intro / startup ----------

function startGame() {
  origin = document.getElementById('namefield').value.trim().toUpperCase();
  target = document.getElementById('oppfield').value.trim().toUpperCase();
  inGame = true;
  document.getElementById('intro').hidden = true;
  document.getElementById('game').hidden = false;
  turnsound.load();
  connect();
  setInterval(() => {
    wsSend(`<ALIVE target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
  }, ALIVE_SEND_MS);
  setInterval(updateStatus, 300);
  updateStatus();
}

const playBtn = document.getElementById('playbtn');
playBtn.addEventListener('click', startGame);
playBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter' || e.code === 'Space') startGame();
});
for (const id of ['namefield', 'oppfield']) {
  document.getElementById(id).addEventListener('keyup', e => {
    if (e.code === 'Enter') startGame();
  });
}

const params = new URLSearchParams(location.search);
if (params.get('name')) document.getElementById('namefield').value = params.get('name');
if (params.get('opp')) document.getElementById('oppfield').value = params.get('opp');

// ---------- scale stage to fit window ----------

function rescale() {
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  scaler.style.transform =
    `translate(${-STAGE_W * s / 2}px, ${-STAGE_H * s / 2}px) scale(${s})`;
}
window.addEventListener('resize', rescale);

buildPieces();
rescale();
document.getElementById('namefield').focus();

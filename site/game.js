'use strict';

/*
 * Cathedral — HTML/JS port of the 2001 Flash original.
 *
 * Two modes:
 *  - network ("play"): free-form shared tabletop, speaking the original
 *    XMLSocket protocol (null-terminated MOTION / YOURTURN / ALIVE XML)
 *    over a WebSocket — interoperates with the SWF running in Ruffle.
 *  - vs. computer: full rules enforced by engine.js (legal placement,
 *    territory claims, captures, scoring) against a built-in AI.
 */

const GRID = 25;
const STAGE_W = 780;
const STAGE_H = 500;
const BOARD_X = 250;          // board top-left in stage px
const BOARD_Y = 125;
const SVGNS = 'http://www.w3.org/2000/svg';

// Original stacking order of the pieces on the SWF timeline (bottom to top).
const DEPTH_ORDER = [15, 17, 19, 22, 23, 25, 27, 26, 28, 21, 0, 20, 24,
                     10, 14, 7, 11, 12, 5, 6, 9, 8, 3, 4, 1, 2, 13, 16, 18];

// Building names by shape id (for messages in vs-computer mode).
const SHAPE_NAMES = {
  41: 'cathedral',
  21: 'tavern', 23: 'stable', 25: 'inn', 27: 'bridge', 29: 'square',
  44: 'manor', 31: 'abbey', 35: 'castle', 33: 'infirmary', 37: 'tower', 39: 'academy',
  66: 'tavern', 64: 'stable', 58: 'inn', 52: 'bridge', 62: 'square',
  60: 'manor', 48: 'abbey', 54: 'castle', 56: 'infirmary', 68: 'tower', 50: 'academy',
};
const pieceName = id => SHAPE_NAMES[PIECES[id].shape] || 'building';

// ALIVE keepalive every 41 ticks at 12 fps; peer considered gone after 120 ticks.
const ALIVE_SEND_MS = Math.round(41 / 12 * 1000);
const ALIVE_TIMEOUT_MS = Math.round(120 / 12 * 1000);
const DRAG_SEND_MS = 100;

const stage = document.getElementById('stage');
const scaler = document.getElementById('scaler');
const piecesLayer = document.getElementById('pieces');
const territoryLayer = document.getElementById('territory');
const endturnBtn = document.getElementById('endturn');
const resetBtn = document.getElementById('resetbtn');
const failnotice = document.getElementById('failnotice');
const opstatus = document.getElementById('opstatus');
const gamemsg = document.getElementById('gamemsg');

let mode = null;            // 'net' | 'ai'
let origin = '';            // my name (uppercased, like the SWF)
let target = '';            // opponent name
let rulesWanted = false;    // "enforce the rules" toggle (net mode)
let rulesDecided = false;   // have we seen the peer's stance yet?
let rulesActive = false;    // both sides enforce: engine drives the game
let net = null;             // ENGINE state for rules-enforced net play
let netGameNum = 0;         // cathedral duty alternates; synced via RESET
let myColor = 1;            // 1 green / 2 red (lexicographically first name is green)
let pending = null;         // tentative placement {id, rot, col, row}; commits on End Turn
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

// Glide a piece back to its tray spot (capture returns, pending swaps, …).
function sendHome(p, announce) {
  const orig = resetPositions[p.id];
  p.x = orig.x;
  p.y = orig.y;
  p.rot = orig.rot;
  glidePiece(p);
  if (announce && mode === 'net') sendMove(p.id);
}

function normRot(r) {
  r = ((r % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;   // Flash _rotation is -180..180
}
const normRot360 = r => ((r % 360) + 360) % 360;

function positionPiece(p) {
  const s = SHAPES[PIECES[p.id].shape];
  p.el.style.left = (p.x - s.rx) + 'px';
  p.el.style.top = (p.y - s.ry) + 'px';
  p.el.style.transform = `rotate(${p.rot}deg)`;
}

function glidePiece(p) {       // animated reposition
  p.el.classList.add('moving');
  p.el.style.zIndex = ++zTop;
  positionPiece(p);
  setTimeout(() => p.el.classList.remove('moving'), 400);
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
  if (rotatedView) {  // stage is rotated 90° to fill portrait screens
    return {
      x: (e.clientY - r.top) * STAGE_W / r.height,
      y: (r.right - e.clientX) * STAGE_H / r.width,
    };
  }
  return {
    x: (e.clientX - r.left) * STAGE_W / r.width,
    y: (e.clientY - r.top) * STAGE_H / r.height,
  };
}

const lastTap = { id: -1, t: 0 };

function startDrag(e, id) {
  if (mode === 'ai' && !aiDraggable(id)) return;
  if (mode === 'net' && rulesActive && !netDraggable(id)) return;
  e.preventDefault();
  const p = state[id];
  setSelected(id);
  p.dragFrom = { x: p.x, y: p.y, rot: p.rot };
  p.el.style.zIndex = ++zTop;
  p.el.classList.add('dragging');
  const at = stagePoint(e);
  p.grabX = at.x - p.x;     // on the piece so mid-drag rotation can re-anchor
  p.grabY = at.y - p.y;
  const t0 = performance.now();
  let lastSent = 0;

  const move = ev => {
    const m = stagePoint(ev);
    p.x = m.x - p.grabX;
    p.y = m.y - p.grabY;
    positionPiece(p);
    if (mode === 'net') {
      const now = performance.now();
      if (now - lastSent > DRAG_SEND_MS) {
        lastSent = now;
        sendMove(id);
      }
    }
  };
  const finish = cancelled => {
    p.el.classList.remove('dragging');
    p.el.removeEventListener('pointermove', move);
    p.el.removeEventListener('pointerup', up);
    p.el.removeEventListener('pointercancel', cancel);
    const dragDist = Math.hypot(p.x - p.dragFrom.x, p.y - p.dragFrom.y);
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
    if (mode === 'ai') {
      rulesDrop(p, ai);
    } else if (rulesActive) {
      rulesDrop(p, net);
    } else if (rulesWanted && !rulesDecided) {
      gateDrop(p);
    } else {
      positionPiece(p);
      sendMove(id);
    }
    // Double-tap rotates. Detected from pointer events because canceling
    // pointerdown (above) suppresses dblclick on touch devices.
    const now = performance.now();
    const isTap = !cancelled && dragDist < 8 && now - t0 < 350;
    if (isTap && lastTap.id === id && now - lastTap.t < 400) {
      rotateSelected();
      lastTap.id = -1;
    } else {
      lastTap.id = isTap ? id : -1;
      lastTap.t = now;
    }
  };
  const up = () => finish(false);
  const cancel = () => finish(true);
  p.el.setPointerCapture(e.pointerId);
  p.el.addEventListener('pointermove', move);
  p.el.addEventListener('pointerup', up);
  p.el.addEventListener('pointercancel', cancel);
}

function setSelected(id) {
  if (selected >= 0 && state[selected]) state[selected].el.classList.remove('sel');
  selected = id;
  if (id >= 0) state[id].el.classList.add('sel');
}

// Bounding box of a piece's cells at a rotation, in cell units
// relative to its registration point.
function cellBox(id, rot) {
  const cells = ENGINE.cellsFor(id, rot);
  const is = cells.map(c => c[0]);
  const js = cells.map(c => c[1]);
  return {
    minI: Math.min(...is), maxI: Math.max(...is),
    minJ: Math.min(...js), maxJ: Math.max(...js),
  };
}

function rotateSelected() {
  if (selected < 0) return;
  if (mode === 'ai' && !aiDraggable(selected)) return;
  if (mode === 'net' && rulesActive && !netDraggable(selected)) return;
  const p = state[selected];
  const oldRot = normRot360(p.rot);
  const newRot = normRot360(p.rot + 90);
  // shift the reg point so the piece spins around its visual center
  // (the SWF rotated around the reg point, swinging long pieces wide)
  const b0 = cellBox(selected, oldRot);
  const b1 = cellBox(selected, newRot);
  let nx = p.x + (b0.minI + b0.maxI - b1.minI - b1.maxI) / 2 * GRID;
  let ny = p.y + (b0.minJ + b0.maxJ - b1.minJ - b1.maxJ) / 2 * GRID;
  // a pending board placement may only rotate into another legal position
  const eng = mode === 'ai' ? ai : (rulesActive ? net : null);
  if (eng && pending && pending.id === selected && !p.el.classList.contains('dragging')) {
    // pieces with an even-by-odd footprint land half a cell off-grid;
    // alternate the rounding direction so four rotations come back home
    const up = oldRot === 0 || oldRot === 180;
    const snap = v => (up ? Math.round(v / GRID) : Math.ceil(v / GRID - 0.5)) * GRID;
    nx = BOARD_X + snap(nx - BOARD_X);
    ny = BOARD_Y + snap(ny - BOARD_Y);
    const col = (nx - BOARD_X) / GRID;
    const row = (ny - BOARD_Y) / GRID;
    if (!ENGINE.canPlace(eng, eng.turn, selected, newRot, col, row)) return;
    pending = { id: selected, rot: newRot, col, row };
  }
  if (p.el.classList.contains('dragging')) {   // keep the pointer grab anchored
    p.grabX -= nx - p.x;
    p.grabY -= ny - p.y;
  }
  p.x = nx;
  p.y = ny;
  p.rot = normRot(p.rot + 90);
  positionPiece(p);
  if (mode === 'net') sendMove(selected);
}

document.addEventListener('keydown', e => {
  if (inGame && e.code === 'Space') e.preventDefault();
});
document.addEventListener('keyup', e => {
  if (inGame && e.code === 'Space') rotateSelected();
});

// Buttons activate on pointerup rather than click: touchend is swallowed
// to kill iOS Safari's double-tap zoom (see startup), which also swallows
// the synthesized clicks on touch devices.
function onTap(el, fn) {
  el.addEventListener('pointerup', e => {
    if (e.button === 0) fn();
  });
}

const rotateBtn = document.getElementById('rotatebtn');
onTap(rotateBtn, rotateSelected);
rotateBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter') rotateSelected();
});

// ---------- networking (shared-tabletop mode) ----------

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
  ws.onopen = () => {
    wsSend(`<ALIVE target="${xmlEsc(target)}" origin="${xmlEsc(origin)}"` +
           `${rulesWanted ? ' rules="1"' : ''} />`);
  };
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
    const id = +m.getAttribute('id');
    const p = state[id];
    if (!p) return;
    const isCommit = m.getAttribute('commit') === '1';
    if (isCommit && rulesWanted && !rulesActive && !rulesDecided) engageRules();
    if (rulesActive && isCommit) {
      netCommitFromPeer(p, +m.getAttribute('x'), +m.getAttribute('y'), +m.getAttribute('rot'));
      return;
    }
    if (rulesActive) {
      // live drag preview: only pieces still in the opponent's hand may move
      if (!net.hand.includes(id)) return;
      if (id !== 0 && ENGINE.ownerOf(id) === myColor) return;
    }
    p.x = +m.getAttribute('x');
    p.y = +m.getAttribute('y');
    p.rot = +m.getAttribute('rot');
    positionPiece(p);
  } else if (m.nodeName === 'YOURTURN') {
    if (rulesActive) return;       // turns are implicit when enforcing rules
    endturnBtn.classList.remove('dim');
    turnsound.play().catch(() => {});
  } else if (m.nodeName === 'ALIVE') {
    lastPeerAlive = Date.now();
    if (rulesWanted && !rulesDecided) {
      rulesDecided = true;
      if (m.getAttribute('rules') === '1') {
        engageRules();
      } else {
        msg(`${target} is not enforcing rules — free-form play`);
        setTimeout(() => { if (!rulesActive) msg(''); }, 6000);
      }
    }
  } else if (m.nodeName === 'RESET' && rulesActive) {
    initNetGame(+m.getAttribute('game') || 0);
  }
}

// ---------- vs. computer ----------

const HUMAN = 1;   // green, left side
const COMP = 2;    // red, right side
let ai = null;     // ENGINE state
let aiGameNum = 0; // cathedral-placing duty alternates between games

function aiDraggable(id) {
  if (!ai || ai.phase === 'over' || ai.turn !== HUMAN) return false;
  if (!ai.hand.includes(id)) return false;
  if (ai.phase === 'cathedral') return id === 0;
  return id !== 0 && ENGINE.ownerOf(id) === HUMAN;
}

function refreshLocks() {
  let test = null;
  if (mode === 'ai') test = aiDraggable;
  else if (mode === 'net' && rulesActive) test = netDraggable;
  for (const id of Object.keys(state)) {
    state[id].el.classList.toggle('locked', test ? !test(+id) : false);
  }
}

const withArticle = name => `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;

// Where would this piece land on the grid? (after the drop snap)
function dropInfo(p) {
  const rot = normRot360(p.rot);
  const col0 = (p.x - BOARD_X) / GRID;
  const row0 = (p.y - BOARD_Y) / GRID;
  const cells = ENGINE.cellsFor(p.id, rot).map(([i, j]) => [col0 + i, row0 + j]);
  const inside = cells.filter(([c, r]) => c >= 0 && c < 10 && r >= 0 && r < 10);
  return { rot, col0, row0, cells, inside };
}

function msg(text) {
  gamemsg.textContent = text;
}

function updateAIScore() {
  const sc = ENGINE.score(ai);
  document.getElementById('netscore').textContent =
    `you: ${sc[HUMAN]} · computer: ${sc[COMP]} squares unplaced`;
}

function renderTerritory(eng) {
  territoryLayer.innerHTML = '';
  for (let k = 0; k < 100; k++) {
    if (eng.terr[k] === 0) continue;
    const d = document.createElement('div');
    d.className = `cell t${eng.terr[k]}`;
    d.style.left = (BOARD_X + (k % 10) * GRID) + 'px';
    d.style.top = (BOARD_Y + Math.floor(k / 10) * GRID) + 'px';
    territoryLayer.appendChild(d);
  }
}

// Apply capture/claim events visually; returns a description of captures.
// mineName/theirsName label the owners of captured pieces.
function applyEvents(eng, ev, mineColor, mineName, theirsName) {
  const notes = [];
  for (const id of ev.captured) {
    const p = state[id];
    if (id === 0) {
      p.el.classList.add('gone');
      notes.push('the cathedral is captured — gone for good');
    } else {
      sendHome(p);
      notes.push(`${ENGINE.ownerOf(id) === mineColor ? mineName : theirsName} ${pieceName(id)} was captured`);
    }
  }
  renderTerritory(eng);
  return notes;
}

// Drop handler for both rules modes (vs. computer and rules-enforced net).
// A legal board drop becomes a *pending* placement: still movable, rotatable,
// returnable to the tray, or swappable — End Turn commits it.
function rulesDrop(p, eng) {
  const isNet = mode === 'net';
  const undo = () => {
    p.x = p.dragFrom.x;
    p.y = p.dragFrom.y;
    p.rot = p.dragFrom.rot;
    glidePiece(p);
    if (isNet) sendMove(p.id);
  };
  const { rot, col0, row0, cells, inside } = dropInfo(p);

  if (inside.length === 0) {       // parked in the tray — not a move
    positionPiece(p);
    if (isNet) sendMove(p.id);
    if (pending && pending.id === p.id) {
      pending = null;              // took the tentative placement back
      updateEndTurn();
      msg(eng.phase === 'cathedral'
        ? 'place the cathedral anywhere on the board'
        : 'your turn — place a building');
    }
    return;
  }
  const me = isNet ? myColor : HUMAN;
  if (inside.length < cells.length || !Number.isInteger(col0) || !Number.isInteger(row0) ||
      eng.turn !== me ||
      !ENGINE.canPlace(eng, me, p.id, rot, col0, row0)) {
    undo();
    return;
  }
  // legal: this becomes the pending placement (replacing any previous one)
  if (pending && pending.id !== p.id) {
    sendHome(state[pending.id], true);
  }
  pending = { id: p.id, rot, col: col0, row: row0 };
  positionPiece(p);
  if (isNet) sendMove(p.id);
  updateEndTurn();
  msg('press end turn to confirm — or move, rotate, or take back');
}

function commitPending() {
  const isNet = mode === 'net';
  const eng = isNet ? net : ai;
  const { id, rot, col, row } = pending;
  pending = null;
  const p = state[id];
  const ev = ENGINE.place(eng, id, rot, col, row);
  if (!ev) {                       // defensive: should not happen
    sendHome(p, true);
    updateEndTurn();
    isNet ? netProceed('that placement is no longer legal')
          : proceed('that placement is no longer legal');
    return;
  }
  if (isNet) {
    wsSend(`<MOTION id="${id}" x="${Math.round(p.x)}" y="${Math.round(p.y)}"` +
           ` rot="${Math.round(normRot(p.rot))}" commit="1"` +
           ` target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
    const notes = applyEvents(net, ev, myColor, 'your', `${target}'s`);
    netProceed(notes.join('; '));
  } else {
    const notes = applyEvents(ai, ev, HUMAN, 'your', "the computer's");
    proceed(notes.join('; '));
  }
}

function updateEndTurn() {
  if (mode === 'ai' || rulesActive) {
    endturnBtn.style.display = '';
    endturnBtn.classList.add('confirm');
    endturnBtn.classList.remove('dim');
    endturnBtn.classList.toggle('disabled', !pending);
  }
}

function proceed(prefix) {
  const pre = prefix ? prefix + ' — ' : '';
  updateAIScore();
  refreshLocks();
  updateEndTurn();
  if (ai.phase === 'over') {
    endAIGame();
    return;
  }
  if (ai.turn === COMP) {
    setTimeout(computerMove, 650);
    msg(pre + 'computer is thinking…');
    return;
  }
  // human's turn
  if (ai.phase === 'cathedral') {
    msg(pre + 'place the cathedral anywhere on the board');
    return;
  }
  if (!ENGINE.hasLegalMove(ai, HUMAN)) {
    ENGINE.pass(ai);
    msg(pre + 'you have no legal moves — you pass');
    setTimeout(proceed, 900);
    return;
  }
  msg(pre + (prefix ? 'your turn' : 'your turn — place a building'));
  turnsound.play().catch(() => {});
}

function computerMove() {
  if (ai.phase === 'over') {
    endAIGame();
    return;
  }
  if (ai.phase !== 'cathedral' && !ENGINE.hasLegalMove(ai, COMP)) {
    ENGINE.pass(ai);
    msg('computer has no legal moves — it passes');
    setTimeout(proceed, 900);
    return;
  }
  const placingCathedral = ai.phase === 'cathedral';
  const m = ENGINE.chooseMove(ai, COMP, null, 4000);
  const ev = ENGINE.place(ai, m.id, m.rot, m.col, m.row);
  const p = state[m.id];
  p.x = BOARD_X + m.col * GRID;
  p.y = BOARD_Y + m.row * GRID;
  p.rot = normRot(m.rot);
  glidePiece(p);
  setTimeout(() => {
    const notes = applyEvents(ai, ev, HUMAN, 'your', "the computer's");
    const what = placingCathedral
      ? 'computer placed the cathedral'
      : `computer placed ${withArticle(pieceName(m.id))}`;
    proceed([what, ...notes].join('; '));
  }, 420);
}

function endAIGame() {
  const sc = ENGINE.score(ai);
  let result;
  if (sc[HUMAN] < sc[COMP]) result = 'you win!';
  else if (sc[HUMAN] > sc[COMP]) result = 'the computer wins.';
  else result = "it's a draw.";
  msg(`game over — ${result} press reset for a new game`);
  refreshLocks();
}

function newAIGame() {
  ai = ENGINE.newGame(aiGameNum % 2 === 0 ? COMP : HUMAN);
  aiGameNum++;
  pending = null;
  setSelected(-1);
  for (const r of resetPositions) {
    const p = state[r.id];
    p.x = r.x;
    p.y = r.y;
    p.rot = r.rot;
    p.el.classList.remove('gone');
    positionPiece(p);
  }
  renderTerritory(ai);
  proceed();
}

// ---------- rules-enforced network play ----------
//
// Engaged only when BOTH clients advertise rules="1" in their ALIVE
// keepalives; otherwise the game stays a free-form tabletop (and remains
// compatible with the SWF in Ruffle). Both clients run the same engine in
// lockstep: only legal placements are sent (MOTION with commit="1"), and
// claims/captures/passes are derived identically on each side.

function netOther() { return ENGINE.other(myColor); }
function netPlacer(n) { return n % 2 === 0 ? 1 : 2; }   // green opens game 1

function netDraggable(id) {
  if (!net || net.phase === 'over' || net.turn !== myColor) return false;
  if (!net.hand.includes(id)) return false;
  if (net.phase === 'cathedral') return id === 0;
  return id !== 0 && ENGINE.ownerOf(id) === myColor;
}

function engageRules() {
  rulesDecided = true;
  rulesActive = true;
  myColor = origin <= target ? 1 : 2;
  const left = document.getElementById('youlabel');
  const right = document.getElementById('complabel');
  left.textContent = myColor === 1 ? '▼ YOU ▼' : `▼ ${target} ▼`;
  right.textContent = myColor === 2 ? '▼ YOU ▼' : `▼ ${target} ▼`;
  left.hidden = false;
  right.hidden = false;
  initNetGame(0);
}

function initNetGame(n) {
  netGameNum = n;
  net = ENGINE.newGame(netPlacer(n));
  pending = null;
  setSelected(-1);
  for (const r of resetPositions) {
    const p = state[r.id];
    p.x = r.x;
    p.y = r.y;
    p.rot = r.rot;
    p.el.classList.remove('gone');
    positionPiece(p);
  }
  renderTerritory(net);
  netProceed();
}

function updateNetScore() {
  if (!net) return;
  const sc = ENGINE.score(net);
  document.getElementById('netscore').textContent =
    `you: ${sc[myColor]} · ${target}: ${sc[netOther()]} squares unplaced`;
}

function netProceed(prefix) {
  const parts = prefix ? [prefix] : [];
  updateNetScore();
  updateEndTurn();
  while (net.phase === 'play' && !ENGINE.hasLegalMove(net, net.turn)) {
    parts.push(net.turn === myColor ? 'you have no legal moves — you pass'
                                    : `${target} has no legal moves and passes`);
    ENGINE.pass(net);
  }
  refreshLocks();
  if (net.phase === 'over') {
    const sc = ENGINE.score(net);
    let result;
    if (sc[myColor] < sc[netOther()]) result = 'you win!';
    else if (sc[myColor] > sc[netOther()]) result = `${target} wins.`;
    else result = "it's a draw.";
    parts.push(`game over — ${result} press reset for a new game`);
    msg(parts.join('; '));
    return;
  }
  if (net.phase === 'cathedral') {
    parts.push(net.turn === myColor
      ? 'place the cathedral anywhere on the board'
      : `waiting for ${target} to place the cathedral…`);
  } else if (net.turn === myColor) {
    parts.push(parts.length ? 'your turn' : 'your turn — place a building');
    turnsound.play().catch(() => {});
  } else {
    parts.push(`waiting for ${target}…`);
  }
  msg(parts.join('; '));
}

function gateDrop(p) {
  const { inside } = dropInfo(p);
  if (inside.length === 0) {
    positionPiece(p);
    sendMove(p.id);
    return;
  }
  p.x = p.dragFrom.x;
  p.y = p.dragFrom.y;
  p.rot = p.dragFrom.rot;
  glidePiece(p);
  sendMove(p.id);
  msg(`waiting for ${target || 'opponent'} to connect before the game starts…`);
}

function netCommitFromPeer(p, x, y, rot) {
  const col0 = (x - BOARD_X) / GRID;
  const row0 = (y - BOARD_Y) / GRID;
  const wasCathedral = net.phase === 'cathedral';
  const ev = ENGINE.place(net, p.id, normRot360(rot), col0, row0);
  if (!ev) {
    msg(`out of sync with ${target} — press reset to start a new game`);
    return;
  }
  p.x = x;
  p.y = y;
  p.rot = rot;
  glidePiece(p);
  const notes = applyEvents(net, ev, myColor, 'your', `${target}'s`);
  const what = wasCathedral
    ? `${target} placed the cathedral`
    : `${target} placed ${withArticle(pieceName(p.id))}`;
  netProceed([what, ...notes].join('; '));
}

// ---------- buttons ----------

onTap(endturnBtn, () => {
  if (mode === 'ai' || rulesActive) {
    if (pending) commitPending();
    return;
  }
  endturnBtn.classList.add('dim');
  wsSend(`<YOURTURN target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
});

onTap(resetBtn, () => {
  if (mode === 'ai') {
    newAIGame();
    return;
  }
  if (rulesActive) {
    const n = netGameNum + 1;
    wsSend(`<RESET game="${n}" target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
    initNetGame(n);
    return;
  }
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

// muted by default; an explicit unmute is remembered
let muted = true;
try { muted = localStorage.getItem('cathedral-muted') !== '0'; } catch {}
const muteBtn = document.getElementById('mutebtn');

function renderMute() {
  turnsound.muted = muted;
  muteBtn.classList.toggle('muted', muted);
  muteBtn.querySelector('.lbl').textContent = muted ? 'unmute' : 'mute';
}

onTap(muteBtn, () => {
  muted = !muted;
  try { localStorage.setItem('cathedral-muted', muted ? '1' : '0'); } catch {}
  renderMute();
});
renderMute();

// ---------- status ----------

function updateStatus() {
  if (mode !== 'net') return;
  const peerOk = ws && ws.readyState === WebSocket.OPEN &&
                 Date.now() - lastPeerAlive < ALIVE_TIMEOUT_MS;
  // the game message owns the line above the board; opstatus still shows
  // the connection state bottom-right
  failnotice.style.display = (peerOk || gamemsg.textContent) ? 'none' : 'block';
  opstatus.textContent = peerOk
    ? `${origin} connected to ${target}`
    : 'no opponent connected';
}

// ---------- intro / startup ----------

function enterGameScreen() {
  inGame = true;
  document.getElementById('intro').hidden = true;
  scaler.hidden = false;
  document.getElementById('game').hidden = false;
  turnsound.load();
}

function startGame() {
  if (inGame) return;
  mode = 'net';
  origin = document.getElementById('namefield').value.trim().toUpperCase();
  target = document.getElementById('oppfield').value.trim().toUpperCase();
  const chk = document.getElementById('ruleschk').checked;
  rulesWanted = chk && !!origin && !!target && origin !== target;
  enterGameScreen();
  if (chk && !rulesWanted) {
    msg('rules enforcement needs two distinct names — free-form play');
    setTimeout(() => { if (!rulesActive) msg(''); }, 6000);
  } else if (rulesWanted) {
    msg(`waiting for ${target} to connect…`);
  }
  connect();
  setInterval(() => {
    wsSend(`<ALIVE target="${xmlEsc(target)}" origin="${xmlEsc(origin)}"` +
           `${rulesWanted ? ' rules="1"' : ''} />`);
  }, ALIVE_SEND_MS);
  setInterval(updateStatus, 300);
  updateStatus();
}

function startAIGame() {
  if (inGame) return;
  mode = 'ai';
  enterGameScreen();
  failnotice.style.display = 'none';
  document.getElementById('youlabel').hidden = false;
  document.getElementById('complabel').hidden = false;
  newAIGame();
}

const playBtn = document.getElementById('playbtn');
onTap(playBtn, startGame);
playBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter' || e.code === 'Space') startGame();
});
const aiBtn = document.getElementById('aibtn');
onTap(aiBtn, startAIGame);
aiBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter') startAIGame();
});

// iOS Safari ignores user-scalable=no and double-tap zooms even through
// touch-action: none (while honoring it for pinch, so there's no zooming
// back out). Swallow touchend to stop the gesture: everywhere in-game,
// and on the intro except its form fields and links.
document.getElementById('game').addEventListener('touchend',
  e => e.preventDefault(), { passive: false });
document.getElementById('intro').addEventListener('touchend', e => {
  if (!e.target.closest('input, label, a')) e.preventDefault();
}, { passive: false });
for (const id of ['namefield', 'oppfield']) {
  document.getElementById(id).addEventListener('keyup', e => {
    if (e.code === 'Enter') startGame();
  });
}

const params = new URLSearchParams(location.search);
if (params.get('name')) document.getElementById('namefield').value = params.get('name');
if (params.get('opp')) document.getElementById('oppfield').value = params.get('opp');

// ---------- scale stage to fit window ----------

let rotatedView = false;   // stage turned 90° when that fits the window better

function rescale() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sLand = Math.min(w / STAGE_W, h / STAGE_H);
  const sPort = Math.min(w / STAGE_H, h / STAGE_W);
  rotatedView = sPort > sLand;   // portrait phone: rotate to fill the screen
  if (rotatedView) {
    scaler.style.transform =
      `translate(${STAGE_H * sPort / 2}px, ${-STAGE_W * sPort / 2}px) rotate(90deg) scale(${sPort})`;
  } else {
    scaler.style.transform =
      `translate(${-STAGE_W * sLand / 2}px, ${-STAGE_H * sLand / 2}px) scale(${sLand})`;
  }
}
window.addEventListener('resize', rescale);

// iOS Safari remembers a site's pinch-zoom level and reapplies it shortly
// after load — and since zoom gestures are blocked here, there'd be no way
// back out. It ignores maximum-scale, but rewriting the viewport meta makes
// it re-evaluate and snap to 1x, so pin the scale whenever it drifts.
if (window.visualViewport) {
  const vpMeta = document.querySelector('meta[name="viewport"]');
  const base = vpMeta.getAttribute('content');
  let resetting = false;
  const pinScale = () => {
    // only fight zoom-in; never inflate a page Safari shrank to fit
    if (resetting || visualViewport.scale <= 1.02) return;
    resetting = true;
    vpMeta.setAttribute('content', base + ', minimum-scale=1');
    setTimeout(() => {
      vpMeta.setAttribute('content', base);
      resetting = false;
    }, 100);
  };
  visualViewport.addEventListener('resize', pinScale);
  window.addEventListener('pageshow', () => setTimeout(pinScale, 50));
  setTimeout(pinScale, 300);
}

// Temporary diagnostics: ?vpdebug=1 overlays live viewport numbers.
if (params.get('vpdebug') === '1') {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#000;' +
    'color:#0f0;font:13px monospace;padding:6px;white-space:pre;pointer-events:none';
  document.body.appendChild(d);
  let lastErr = '';
  window.addEventListener('error', e => { lastErr = e.message; });
  setInterval(() => {
    d.textContent =
      `inner   ${window.innerWidth}x${window.innerHeight}\n` +
      `doc     ${document.documentElement.scrollWidth}x` +
              `${document.documentElement.scrollHeight}\n` +
      `vviewp  ${visualViewport.width.toFixed(0)}x${visualViewport.height.toFixed(0)}` +
              `  scale ${visualViewport.scale.toFixed(3)}\n` +
      `screen  ${screen.width}x${screen.height}  dpr ${devicePixelRatio}` +
      (lastErr ? `\nERR ${lastErr}` : '');
  }, 250);
}

buildPieces();
rescale();
if (params.get('ai') === '1') {
  startAIGame();
} else if (!matchMedia('(pointer: coarse)').matches) {
  // focusing on touch devices would pop the keyboard over the intro
  document.getElementById('namefield').focus();
}

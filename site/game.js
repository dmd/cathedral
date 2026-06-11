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
  return {
    x: (e.clientX - r.left) * STAGE_W / r.width,
    y: (e.clientY - r.top) * STAGE_H / r.height,
  };
}

function startDrag(e, id) {
  if (mode === 'ai' && !aiDraggable(id)) return;
  if (mode === 'net' && rulesActive && !netDraggable(id)) return;
  e.preventDefault();
  const p = state[id];
  selected = id;
  p.dragFrom = { x: p.x, y: p.y, rot: p.rot };
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
    if (mode === 'net') {
      const now = performance.now();
      if (now - lastSent > DRAG_SEND_MS) {
        lastSent = now;
        sendMove(id);
      }
    }
  };
  const up = () => {
    p.el.classList.remove('dragging');
    p.el.removeEventListener('pointermove', move);
    p.el.removeEventListener('pointerup', up);
    p.el.removeEventListener('pointercancel', up);
    p.x = Math.round(p.x / GRID) * GRID;
    p.y = Math.round(p.y / GRID) * GRID;
    if (mode === 'ai') {
      aiDrop(p);
    } else if (rulesActive) {
      netDrop(p);
    } else if (rulesWanted && !rulesDecided) {
      gateDrop(p);
    } else {
      positionPiece(p);
      sendMove(id);
    }
  };
  p.el.setPointerCapture(e.pointerId);
  p.el.addEventListener('pointermove', move);
  p.el.addEventListener('pointerup', up);
  p.el.addEventListener('pointercancel', up);
}

function rotateSelected() {
  if (selected < 0) return;
  if (mode === 'ai' && !aiDraggable(selected)) return;
  if (mode === 'net' && rulesActive && !netDraggable(selected)) return;
  const p = state[selected];
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

// Rotate on double-click/double-tap too (for touch devices).
piecesLayer.addEventListener('dblclick', e => {
  const el = e.target.closest('.piece');
  if (el) {
    selected = +el.dataset.id;
    rotateSelected();
  }
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
  opstatus.textContent =
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
      notes.push('the cathedral is captured and removed from the game');
    } else {
      const orig = resetPositions.find(r => r.id === id);
      p.x = orig.x;
      p.y = orig.y;
      p.rot = orig.rot;
      glidePiece(p);
      notes.push(`${ENGINE.ownerOf(id) === mineColor ? mineName : theirsName} ${pieceName(id)} is captured and returned`);
    }
  }
  renderTerritory(eng);
  return notes;
}

function aiDrop(p) {
  const undo = () => {
    p.x = p.dragFrom.x;
    p.y = p.dragFrom.y;
    p.rot = p.dragFrom.rot;
    glidePiece(p);
  };
  const { rot, col0, row0, cells, inside } = dropInfo(p);

  if (inside.length === 0) {       // parked in the tray — not a move
    positionPiece(p);
    return;
  }
  if (inside.length < cells.length || !Number.isInteger(col0) || !Number.isInteger(row0) ||
      ai.turn !== HUMAN) {
    undo();
    return;
  }
  const ev = ENGINE.place(ai, p.id, rot, col0, row0);
  if (!ev) {
    undo();
    return;
  }
  positionPiece(p);
  const notes = applyEvents(ai, ev, HUMAN, 'your', "the computer's");
  updateAIScore();
  refreshLocks();
  proceed(notes.join('; '));
}

function proceed(prefix) {
  const pre = prefix ? prefix + ' — ' : '';
  updateAIScore();
  refreshLocks();
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
  msg(pre + 'your turn — place a building');
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
  const m = ENGINE.chooseMove(ai, COMP);
  const ev = ENGINE.place(ai, m.id, m.rot, m.col, m.row);
  const p = state[m.id];
  p.x = BOARD_X + m.col * GRID;
  p.y = BOARD_Y + m.row * GRID;
  p.rot = normRot(m.rot);
  glidePiece(p);
  setTimeout(() => {
    const notes = applyEvents(ai, ev, HUMAN, 'your', "the computer's");
    const name = pieceName(m.id);
    const what = placingCathedral
      ? 'computer placed the cathedral'
      : `computer placed ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
    proceed([what, ...notes].join('; '));
  }, 420);
}

function endAIGame() {
  const sc = ENGINE.score(ai);
  let result;
  if (sc[HUMAN] < sc[COMP]) result = 'you win!';
  else if (sc[HUMAN] > sc[COMP]) result = 'the computer wins.';
  else result = "it's a draw.";
  msg(`game over — ${result} ` +
      `(you: ${sc[HUMAN]}, computer: ${sc[COMP]} squares unplaced) — ` +
      `press reset for a new game`);
  refreshLocks();
}

function newAIGame() {
  ai = ENGINE.newGame(aiGameNum % 2 === 0 ? COMP : HUMAN);
  aiGameNum++;
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
  endturnBtn.style.display = 'none';
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
    parts.push(`game over — ${result} ` +
               `(you: ${sc[myColor]}, ${target}: ${sc[netOther()]} squares unplaced) — ` +
               `press reset for a new game`);
    msg(parts.join('; '));
    return;
  }
  if (net.phase === 'cathedral') {
    parts.push(net.turn === myColor
      ? 'place the cathedral anywhere on the board'
      : `waiting for ${target} to place the cathedral…`);
  } else if (net.turn === myColor) {
    parts.push('your turn — place a building');
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

function netDrop(p) {
  const undo = () => {
    p.x = p.dragFrom.x;
    p.y = p.dragFrom.y;
    p.rot = p.dragFrom.rot;
    glidePiece(p);
    sendMove(p.id);
  };
  const { rot, col0, row0, cells, inside } = dropInfo(p);
  if (inside.length === 0) {       // parked in the tray — not a move
    positionPiece(p);
    sendMove(p.id);
    return;
  }
  if (inside.length < cells.length || !Number.isInteger(col0) || !Number.isInteger(row0) ||
      net.turn !== myColor) {
    undo();
    return;
  }
  const ev = ENGINE.place(net, p.id, rot, col0, row0);
  if (!ev) {
    undo();
    return;
  }
  positionPiece(p);
  wsSend(`<MOTION id="${p.id}" x="${Math.round(p.x)}" y="${Math.round(p.y)}"` +
         ` rot="${Math.round(normRot(p.rot))}" commit="1"` +
         ` target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
  const notes = applyEvents(net, ev, myColor, 'your', `${target}'s`);
  netProceed(notes.join('; '));
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

endturnBtn.addEventListener('click', () => {
  endturnBtn.classList.add('dim');
  wsSend(`<YOURTURN target="${xmlEsc(target)}" origin="${xmlEsc(origin)}" />`);
});

resetBtn.addEventListener('click', () => {
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

// ---------- status ----------

function updateStatus() {
  if (mode !== 'net') return;
  const peerOk = ws && ws.readyState === WebSocket.OPEN &&
                 Date.now() - lastPeerAlive < ALIVE_TIMEOUT_MS;
  failnotice.style.display = peerOk ? 'none' : 'block';
  opstatus.textContent = peerOk
    ? `${origin} connected to ${target}`
    : 'no opponent connected';
}

// ---------- intro / startup ----------

function enterGameScreen() {
  inGame = true;
  document.getElementById('intro').hidden = true;
  document.getElementById('game').hidden = false;
  turnsound.load();
}

function startGame() {
  mode = 'net';
  origin = document.getElementById('namefield').value.trim().toUpperCase();
  target = document.getElementById('oppfield').value.trim().toUpperCase();
  const chk = document.getElementById('ruleschk').checked;
  rulesWanted = chk && !!origin && !!target && origin !== target;
  enterGameScreen();
  if (chk && !rulesWanted) {
    msg('rules enforcement needs two distinct names — free-form play');
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
  mode = 'ai';
  enterGameScreen();
  endturnBtn.style.display = 'none';
  failnotice.style.display = 'none';
  document.getElementById('youlabel').hidden = false;
  document.getElementById('complabel').hidden = false;
  newAIGame();
}

const playBtn = document.getElementById('playbtn');
playBtn.addEventListener('click', startGame);
playBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter' || e.code === 'Space') startGame();
});
const aiBtn = document.getElementById('aibtn');
aiBtn.addEventListener('click', startAIGame);
aiBtn.addEventListener('keyup', e => {
  if (e.code === 'Enter') startAIGame();
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
if (params.get('ai') === '1') {
  startAIGame();
} else {
  document.getElementById('namefield').focus();
}

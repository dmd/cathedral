'use strict';

/*
 * Cathedral rules engine + computer opponent.
 * Pure logic, no DOM — also loadable in node for testing.
 *
 * Players: 1 = green (left side, p15-p28), 2 = red (right side, p1-p14).
 * Piece 0 is the cathedral (neutral; placed once at game start).
 *
 * Rules implemented per https://eco.3e.org/cathedral/rules.html:
 *  - One player places the cathedral first; the other then makes the first
 *    building move and each alternate move.
 *  - A region enclosed wall-to-wall by one player's buildings (and the board
 *    edge) becomes their territory. Corner-to-corner contact leaks, so
 *    regions are flood-filled with 8-connectivity. The cathedral never
 *    counts as part of a boundary.
 *  - If the enclosed region contains exactly one enemy building (or the
 *    cathedral) it is removed: buildings return to the owner's hand, the
 *    cathedral is gone for the rest of the game. Two or more: no claim.
 *  - No claims on a player's first building move.
 *  - A player with no legal move passes; the game ends when both players
 *    pass in succession. Lowest total of unplaced squares wins.
 */

const ENGINE = (() => {
  const N = 10;

  const ownerOf = id => id === 0 ? 0 : (id < 15 ? 2 : 1);
  const other = p => p === 1 ? 2 : 1;

  function rotCell(i, j, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return [-j - 1, i];
      case 180: return [-i - 1, -j - 1];
      case 270: return [j, -i - 1];
      default:  return [i, j];
    }
  }

  // Precomputed per (id, rot): footprint cells, grid offsets, and the
  // col/row window where the whole piece stays on the board. Everything in
  // the search inner loops reads these instead of recomputing rotations.
  const SIZE = [];      // id -> cell count
  const CELLS = [];     // id -> rot -> [[i,j], ...]
  const WIN = [];       // id -> rot -> {offs, c0, c1, r0, r1}
  for (const p of PIECES) {
    const foot = FOOT[String(p.shape)];
    SIZE[p.id] = foot.length;
    CELLS[p.id] = {};
    WIN[p.id] = {};
    for (const r of [0, 90, 180, 270]) {
      const cells = foot.map(([i, j]) => rotCell(i, j, r));
      let minI = 9, maxI = -9, minJ = 9, maxJ = -9;
      for (const [i, j] of cells) {
        if (i < minI) minI = i;
        if (i > maxI) maxI = i;
        if (j < minJ) minJ = j;
        if (j > maxJ) maxJ = j;
      }
      CELLS[p.id][r] = cells;
      WIN[p.id][r] = {
        offs: cells.map(([i, j]) => j * N + i),
        c0: -minI, c1: N - 1 - maxI,
        r0: -minJ, r1: N - 1 - maxJ,
      };
    }
  }

  const sizeOf = id => SIZE[id];

  const OWNER = new Int8Array(29);          // id -> owning player (0 = cathedral)
  for (const p of PIECES) OWNER[p.id] = ownerOf(p.id);

  function cellsFor(id, rot) {
    return CELLS[id][((rot % 360) + 360) % 360];
  }

  // Distinct rotations per piece (symmetric shapes have fewer than 4).
  const distinctRots = {};
  for (const p of PIECES) {
    const seen = new Set();
    const rots = [];
    for (const r of [0, 90, 180, 270]) {
      const cells = cellsFor(p.id, r);
      const mi = Math.min(...cells.map(c => c[0]));
      const mj = Math.min(...cells.map(c => c[1]));
      const key = cells.map(([i, j]) => `${i - mi},${j - mj}`).sort().join(';');
      if (!seen.has(key)) {
        seen.add(key);
        rots.push(r);
      }
    }
    distinctRots[p.id] = rots;
  }

  function newGame(cathedralPlacer) {
    return {
      grid: new Array(N * N).fill(-1),    // pieceId or -1
      terr: new Array(N * N).fill(0),     // 0 none, 1 green, 2 red
      placed: {},                         // id -> {col, row, rot}
      hand: PIECES.map(p => p.id),        // unplaced piece ids (incl. cathedral)
      cathedralGone: false,
      firstBuildDone: { 1: false, 2: false },
      phase: 'cathedral',                 // 'cathedral' | 'play' | 'over'
      turn: cathedralPlacer,
      passes: 0,
    };
  }

  function cloneState(s) {
    return {
      grid: s.grid.slice(),
      terr: s.terr.slice(),
      placed: { ...s.placed },   // values are never mutated in place, only replaced
      hand: s.hand.slice(),
      cathedralGone: s.cathedralGone,
      firstBuildDone: { ...s.firstBuildDone },
      phase: s.phase,
      turn: s.turn,
      passes: s.passes,
    };
  }

  function canPlace(s, player, id, rot, col, row) {
    if (s.phase === 'over') return false;
    if (!s.hand.includes(id)) return false;
    if (s.phase === 'cathedral' ? id !== 0 : ownerOf(id) !== player) return false;
    const w = WIN[id][((rot % 360) + 360) % 360];
    if (col < w.c0 || col > w.c1 || row < w.r0 || row > w.r1) return false;
    const opp = other(player), base = row * N + col;
    for (const off of w.offs) {
      const k = base + off;
      if (s.grid[k] !== -1 || s.terr[k] === opp) return false;
    }
    return true;
  }

  // Hot-loop placement test: assumes id is in hand, owned by `player`, and
  // rot is one of distinctRots[id]. Appends every legal placement to `out`,
  // or returns true at the first one when `out` is null.
  function shapePlacements(s, player, id, out) {
    const opp = other(player);
    const grid = s.grid, terr = s.terr;
    for (const rot of distinctRots[id]) {
      const w = WIN[id][rot], offs = w.offs;
      for (let row = w.r0; row <= w.r1; row++) {
        const rbase = row * N;
        for (let col = w.c0; col <= w.c1; col++) {
          const base = rbase + col;
          let ok = true;
          for (let x = 0; x < offs.length; x++) {
            const k = base + offs[x];
            if (grid[k] !== -1 || terr[k] === opp) { ok = false; break; }
          }
          if (ok) {
            if (!out) return true;
            out.push({ id, rot, col, row });
          }
        }
      }
    }
    return out ? out.length > 0 : false;
  }

  // Scratch buffers for computeClaims — module-level to avoid reallocating
  // on every simulated placement in the search (this is the hottest path).
  const ccSeen = new Int8Array(N * N);
  const ccStack = new Int32Array(N * N);
  const ccComp = new Int32Array(N * N);

  // Claim check for `player` after their move. Mutates s; returns events.
  function computeClaims(s, player) {
    const ev = { claimedCells: [], captured: [], cathedralCaptured: false };
    const grid = s.grid;
    // seen doubles as the wall mask: walls are pre-marked as visited
    for (let k = 0; k < N * N; k++) {
      const g = grid[k];
      ccSeen[k] = g > 0 && OWNER[g] === player ? 1 : 0;
    }
    for (let start = 0; start < N * N; start++) {
      if (ccSeen[start]) continue;
      // flood one component (8-connected: corner gaps leak)
      let compLen = 0, sp = 0;
      ccStack[sp++] = start;
      ccSeen[start] = 1;
      let enemy = -1, enemyCount = 0;
      while (sp > 0) {
        const k = ccStack[--sp];
        ccComp[compLen++] = k;
        if (grid[k] !== -1 && grid[k] !== enemy) {
          enemy = grid[k];
          enemyCount++;
        }
        const c = k % N, r = (k - c) / N;
        const c0 = c > 0 ? c - 1 : 0, c1 = c < N - 1 ? c + 1 : N - 1;
        const r0 = r > 0 ? r - 1 : 0, r1 = r < N - 1 ? r + 1 : N - 1;
        for (let nr = r0; nr <= r1; nr++) {
          for (let nc = c0; nc <= c1; nc++) {
            const nk = nr * N + nc;
            if (!ccSeen[nk]) {
              ccSeen[nk] = 1;
              ccStack[sp++] = nk;
            }
          }
        }
      }
      if (enemyCount > 1) continue;
      if (enemyCount === 1) {
        const id = enemy;
        // remove it: cathedral is gone for good, buildings go back to hand
        for (let k = 0; k < N * N; k++) {
          if (s.grid[k] === id) s.grid[k] = -1;
        }
        delete s.placed[id];
        if (id === 0) {
          s.cathedralGone = true;
          ev.cathedralCaptured = true;
        } else {
          s.hand.push(id);
        }
        ev.captured.push(id);
      }
      for (let x = 0; x < compLen; x++) {
        // claim the whole enclosed space — including any stale enemy
        // territory whose backing wall was just captured
        const k = ccComp[x];
        if (s.terr[k] !== player) {
          s.terr[k] = player;
          ev.claimedCells.push(k);
        }
      }
    }
    return ev;
  }

  // Place a piece for the player to move. Returns events or null if illegal.
  function place(s, id, rot, col, row) {
    const player = s.turn;
    if (!canPlace(s, player, id, rot, col, row)) return null;
    for (const [i, j] of cellsFor(id, rot)) {
      s.grid[(row + j) * N + (col + i)] = id;
    }
    s.placed[id] = { col, row, rot };
    s.hand = s.hand.filter(h => h !== id);
    s.passes = 0;
    let ev = { claimedCells: [], captured: [], cathedralCaptured: false };
    if (s.phase === 'cathedral') {
      s.phase = 'play';
    } else if (!s.firstBuildDone[player]) {
      s.firstBuildDone[player] = true;     // no claims on the first building move
    } else {
      ev = computeClaims(s, player);
    }
    s.turn = other(player);
    return ev;
  }

  function pass(s) {
    s.passes++;
    s.turn = other(s.turn);
    if (s.passes >= 2) s.phase = 'over';
  }

  function legalMoves(s, player) {
    const moves = [];
    if (s.phase === 'over') return moves;
    if (s.phase === 'cathedral') {
      shapePlacements(s, player, 0, moves);
      return moves;
    }
    const seenShapes = new Set();
    for (const id of s.hand) {
      if (id === 0 || ownerOf(id) !== player) continue;
      const shape = PIECES[id].shape;
      if (seenShapes.has(shape)) continue;   // identical pieces are interchangeable
      seenShapes.add(shape);
      shapePlacements(s, player, id, moves);
    }
    return moves;
  }

  function hasLegalMove(s, player) {
    if (s.phase === 'over') return false;
    if (s.phase === 'cathedral') return true;
    const seenShapes = new Set();
    for (const id of s.hand) {
      if (id === 0 || ownerOf(id) !== player) continue;
      const shape = PIECES[id].shape;
      if (seenShapes.has(shape)) continue;
      seenShapes.add(shape);
      if (shapePlacements(s, player, id, null)) return true;
    }
    return false;
  }

  // Unplaced squares per player (lower is better; 0 = placed everything).
  function score(s) {
    const sq = { 1: 0, 2: 0 };
    for (const id of s.hand) {
      if (id !== 0) sq[ownerOf(id)] += sizeOf(id);
    }
    return sq;
  }

  // ---------- computer opponent ----------

  // Space the player can actually use: empty cells not in enemy territory,
  // counted only within 4-connected regions large enough to fit one of the
  // player's remaining buildings. Fragmented slivers don't count.
  function usableSpace(s, player) {
    const opp = other(player);
    let minSize = Infinity;
    for (const id of s.hand) {
      if (id !== 0 && ownerOf(id) === player) minSize = Math.min(minSize, sizeOf(id));
    }
    if (minSize === Infinity) return 0;
    const open = k => s.grid[k] === -1 && s.terr[k] !== opp;
    const seen = new Array(N * N).fill(false);
    let total = 0;
    for (let start = 0; start < N * N; start++) {
      if (seen[start] || !open(start)) continue;
      const stack = [start];
      seen[start] = true;
      let size = 0;
      while (stack.length) {
        const k = stack.pop();
        size++;
        const c = k % N, r = (k - c) / N;
        if (c + 1 < N && !seen[k + 1] && open(k + 1)) { seen[k + 1] = true; stack.push(k + 1); }
        if (c - 1 >= 0 && !seen[k - 1] && open(k - 1)) { seen[k - 1] = true; stack.push(k - 1); }
        if (r + 1 < N && !seen[k + N] && open(k + N)) { seen[k + N] = true; stack.push(k + N); }
        if (r - 1 >= 0 && !seen[k - N] && open(k - N)) { seen[k - N] = true; stack.push(k - N); }
      }
      if (size >= minSize) total += size;
    }
    return total;
  }

  function capturedSquares(ev) {
    let n = 0;
    for (const id of ev.captured) {
      if (id !== 0) n += sizeOf(id);
    }
    return n;
  }

  // Tactical value of a just-played move (used for move ordering).
  function moveGain(ev, id) {
    let g = 3.0 * sizeOf(id) + 8.0 * ev.claimedCells.length + 7.0 * capturedSquares(ev);
    if (ev.cathedralCaptured) g += 25;
    return g;
  }


  // Multi-source BFS distance from a player's placed buildings through
  // cells the player could still occupy (empty, not enemy territory).
  function bfsDist(s, player) {
    const opp = other(player);
    const dist = new Int16Array(N * N).fill(32767);
    const queue = [];
    for (let k = 0; k < N * N; k++) {
      const id = s.grid[k];
      if (id !== -1 && id !== 0 && ownerOf(id) === player) {
        dist[k] = 0;
        queue.push(k);
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const k = queue[qi];
      const c = k % N, r = (k - c) / N;
      const d = dist[k] + 1;
      for (const nk of [c + 1 < N ? k + 1 : -1, c - 1 >= 0 ? k - 1 : -1,
                        r + 1 < N ? k + N : -1, r - 1 >= 0 ? k - N : -1]) {
        if (nk < 0 || dist[nk] <= d) continue;
        if (s.grid[nk] !== -1 || s.terr[nk] === opp) continue;
        dist[nk] = d;
        queue.push(nk);
      }
    }
    return dist;
  }

  // Who is positioned to control each contested empty cell? (Voronoi-style
  // influence — rewards contesting regions the opponent is walling off.)
  function influence(s, me) {
    const opp = other(me);
    const dMe = bfsDist(s, me), dOpp = bfsDist(s, opp);
    let diff = 0;
    for (let k = 0; k < N * N; k++) {
      if (s.grid[k] !== -1 || s.terr[k] !== 0) continue;
      if (dMe[k] < dOpp[k]) diff++;
      else if (dOpp[k] < dMe[k]) diff--;
    }
    return diff;
  }

  // Squares of remaining buildings lost to the endgame packing contest:
  // greedily pack the player's pieces largest-first into the space still
  // open to them and count what doesn't fit. Unlike a per-piece dead check,
  // this sees the player's own pieces competing for the same room.
  const pkBlocked = new Int8Array(N * N);
  function packLoss(s, player) {
    const opp = other(player);
    for (let k = 0; k < N * N; k++) {
      pkBlocked[k] = s.grid[k] !== -1 || s.terr[k] === opp ? 1 : 0;
    }
    const mine = [];
    for (const id of s.hand) {
      if (id !== 0 && ownerOf(id) === player) mine.push(id);
    }
    mine.sort((a, b) => SIZE[b] - SIZE[a]);
    let loss = 0;
    for (const id of mine) {
      let fitted = false;
      fit:
      for (const rot of distinctRots[id]) {
        const w = WIN[id][rot], offs = w.offs;
        for (let row = w.r0; row <= w.r1; row++) {
          const rbase = row * N;
          for (let col = w.c0; col <= w.c1; col++) {
            const base = rbase + col;
            let ok = true;
            for (let x = 0; x < offs.length; x++) {
              if (pkBlocked[base + offs[x]]) { ok = false; break; }
            }
            if (ok) {
              for (let x = 0; x < offs.length; x++) pkBlocked[base + offs[x]] = 1;
              fitted = true;
              break fit;
            }
          }
        }
      }
      if (!fitted) loss += SIZE[id];
    }
    return loss;
  }

  // Quasi-territory: small unclaimed empty regions whose adjacent buildings
  // all belong to one player (and that don't border the enemy's territory)
  // are already effectively that player's — an enemy piece played inside is
  // a lone intruder that gets captured as soon as the corner leaks are
  // plugged. Crediting them stops the engine from wasting pieces and tempo
  // formally sealing pockets it already controls.
  const qtSeen = new Int8Array(N * N);
  const qtStack = new Int32Array(N * N);
  function quasiTerr(s, me) {
    const grid = s.grid, terr = s.terr;
    qtSeen.fill(0);
    let diff = 0;
    for (let start = 0; start < N * N; start++) {
      if (qtSeen[start] || grid[start] !== -1 || terr[start] !== 0) continue;
      let sp = 0, size = 0, owners = 0;
      qtStack[sp++] = start;
      qtSeen[start] = 1;
      while (sp > 0) {
        const k = qtStack[--sp];
        size++;
        const c = k % N, r = (k - c) / N;
        for (const nk of [c + 1 < N ? k + 1 : -1, c - 1 >= 0 ? k - 1 : -1,
                          r + 1 < N ? k + N : -1, r - 1 >= 0 ? k - N : -1]) {
          if (nk < 0) continue;
          const g = grid[nk];
          if (g === -1) {
            if (terr[nk] !== 0) {
              owners |= terr[nk];   // territory bounds the region like a wall
            } else if (!qtSeen[nk]) {
              qtSeen[nk] = 1;
              qtStack[sp++] = nk;
            }
          } else if (g > 0) {       // the cathedral never counts as a boundary
            owners |= OWNER[g];
          }
        }
      }
      if (size > 10) continue;
      if (owners === 1) diff += me === 1 ? size : -size;
      else if (owners === 2) diff += me === 2 ? size : -size;
    }
    return diff;
  }

  // Positional evaluation of a board from `me`'s point of view.
  function posEval(s, me) {
    const opp = other(me);
    let terrMe = 0, terrOpp = 0, empty = 0;
    for (let k = 0; k < N * N; k++) {
      if (s.terr[k] === me) terrMe++;
      else if (s.terr[k] === opp) terrOpp++;
      if (s.grid[k] === -1) empty++;
    }
    const sc = score(s);
    let v = 8.0 * (terrMe - terrOpp) +
            5.0 * quasiTerr(s, me) +
            3.0 * (sc[opp] - sc[me]) +
            1.5 * (usableSpace(s, me) - usableSpace(s, opp)) +
            1.2 * influence(s, me);
    // The packing contest starts well before the board is full: bulky
    // pieces (esp. 4-square shapes) get stranded if the engine defers them
    // until the gaps are too fragmented. React from mid-game and weight it
    // enough to actually shift move choice. (Reacting even earlier, or
    // also adding a flat bulky-in-hand penalty, both tested worse.)
    if (empty <= 62) {
      v += 4.0 * (packLoss(s, opp) - packLoss(s, me));
    }
    return v;
  }

  // ---------- alpha-beta search ----------

  const BEAM = { 2: 10, 1: 8 };       // deeper interior levels default to 12
  const ROOT_BEAM = 24;
  let searchTimedOut = false;

  // At the deepest level only consider the player's two largest remaining
  // building sizes — keeps the leaf fan-out affordable.
  function restrictToBigShapes(s, player, moves) {
    const sizes = [...new Set(moves.map(m => sizeOf(m.id)))].sort((a, b) => b - a);
    if (sizes.length <= 2) return moves;
    const cutoff = sizes[1];
    return moves.filter(m => sizeOf(m.id) >= cutoff);
  }

  function search(s, depth, me, alpha, beta, deadline) {
    if (s.phase === 'over') {
      const sc = score(s);
      return 1000 * (sc[other(me)] - sc[me]);
    }
    if (depth === 0) return posEval(s, me);
    if (Date.now() > deadline) {
      searchTimedOut = true;
      return posEval(s, me);
    }
    const player = s.turn;
    let moves = legalMoves(s, player);
    const narrow = moves.length < 60;     // endgame: every fitting move matters
    if (depth === 1 && !narrow) moves = restrictToBigShapes(s, player, moves);
    if (!moves.length) {
      const s2 = cloneState(s);
      pass(s2);
      return search(s2, depth - 1, me, alpha, beta, deadline);
    }
    const kids = moves.map(m => {
      const s2 = cloneState(s);
      const ev = place(s2, m.id, m.rot, m.col, m.row);
      const key = moveGain(ev, m.id) +
                  1.5 * (usableSpace(s2, player) - usableSpace(s2, other(player))) +
                  1.2 * influence(s2, player);
      return { s2, key };
    });
    kids.sort((a, b) => b.key - a.key);
    const maximizing = player === me;
    let best = maximizing ? -Infinity : Infinity;
    const beamW = narrow ? kids.length : (BEAM[depth] || 12);
    for (const kid of kids.slice(0, beamW)) {
      const v = search(kid.s2, depth - 1, me, alpha, beta, deadline);
      if (maximizing) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    return best;
  }

  function chooseCathedral(s, rng) {
    rng = rng || Math.random;
    const moves = legalMoves(s, s.turn);
    let best = null, bestV = -Infinity;
    for (const m of moves) {
      let v = 0;
      for (const [i, j] of cellsFor(0, m.rot)) {
        v -= Math.abs(m.col + i - 4.5) + Math.abs(m.row + j - 4.5);
      }
      v += rng() * 3;
      if (v > bestV) {
        bestV = v;
        best = m;
      }
    }
    return best;
  }

  // `noise` adds a random bonus of up to that many eval points to each root
  // move (one territory cell is worth 8). The default 0.3 only breaks ties;
  // larger values make the computer beatable: it starts preferring its
  // second- and third-best moves, like human inaccuracy.
  function chooseMove(s, me, rng, timeBudgetMs, noise) {
    rng = rng || Math.random;
    noise = noise ?? 0.3;
    if (s.phase === 'cathedral') return chooseCathedral(s, rng);
    let moves = legalMoves(s, me);
    if (!moves.length) return null;
    // Never burn a move entirely inside our own territory while open ground
    // exists: territory is banked (the opponent can never build there), so
    // such moves can always be made later — contest the open board instead.
    const outside = moves.filter(m => {
      const base = m.row * N + m.col;
      return WIN[m.id][m.rot].offs.some(off => s.terr[base + off] !== me);
    });
    if (outside.length) moves = outside;
    const deadline = Date.now() + (timeBudgetMs || 2500);
    // Find the opponent's best immediate enclosure/capture as if it were
    // their turn. Moves that contest those cells are the defenses — and
    // they score terribly on every ordering heuristic (no claims, negative
    // influence), so without help the root beam would never search them.
    const threat = new Int8Array(N * N);
    let threatGain = 0;
    {
      const oppMoves = legalMoves(s, other(me));
      let bestEv = null, bestOm = null;
      for (const om of oppMoves) {
        const s2 = cloneState(s);
        s2.turn = other(me);
        const ev = place(s2, om.id, om.rot, om.col, om.row);
        const gain = 8.0 * ev.claimedCells.length + 7.0 * capturedSquares(ev) +
                     (ev.cathedralCaptured ? 25 : 0);
        if (gain > threatGain) {
          threatGain = gain;
          bestEv = ev;
          bestOm = om;
        }
      }
      if (threatGain >= 24 && bestEv) {       // a claim worth ~3+ squares
        for (const k of bestEv.claimedCells) threat[k] = 1;
        const base = bestOm.row * N + bestOm.col;
        for (const off of WIN[bestOm.id][bestOm.rot].offs) threat[base + off] = 1;
      }
    }
    // order root children by tactical gain + positional delta
    const kids = moves.map(m => {
      const s2 = cloneState(s);
      const ev = place(s2, m.id, m.rot, m.col, m.row);
      const key = moveGain(ev, m.id) +
                  1.5 * (usableSpace(s2, me) - usableSpace(s2, other(me))) +
                  1.2 * influence(s2, me);
      const base = m.row * N + m.col;
      const defends = threatGain >= 24 &&
                      WIN[m.id][m.rot].offs.some(off => threat[base + off]);
      return { m, s2, key, defends };
    });
    kids.sort((a, b) => b.key - a.key);
    // Iterative deepening: search ever deeper while the budget lasts,
    // re-ordering root moves by each completed pass. Only completed
    // passes are trusted (a truncated deep pass returns junk bounds).
    let best = kids[0].m;
    let lastPassMs = 0;
    const rootWidth = moves.length < 80 ? kids.length : ROOT_BEAM;
    // the beam plus up to 16 defensive candidates it would have pruned
    let rootKids = kids.slice(0, rootWidth);
    if (rootWidth < kids.length) {
      let extra = 0;
      for (let i = rootWidth; i < kids.length && extra < 16; i++) {
        if (kids[i].defends) {
          rootKids.push(kids[i]);
          extra++;
        }
      }
    }
    for (let depth = 2; depth <= 30; depth++) {
      const remaining = deadline - Date.now();
      if (remaining < lastPassMs * 1.2 + 50) break;   // try deeper; truncation is harmless
      const t0 = Date.now();
      searchTimedOut = false;
      let passBest = null, passBestV = -Infinity, alpha = -Infinity;
      for (const kid of rootKids) {
        const v = search(kid.s2, depth, me, alpha, Infinity, deadline) + rng() * noise;
        if (searchTimedOut) break;     // v is junk: a leaf in this subtree was cut short
        kid.v = v;
        if (v > passBestV) {
          passBestV = v;
          passBest = kid.m;
        }
        if (v > alpha) alpha = v;
        if (Date.now() > deadline) {
          searchTimedOut = true;
          break;
        }
      }
      if (searchTimedOut) {
        if (depth === 2 && passBest) best = passBest;   // better than ordering alone
        break;
      }
      best = passBest;
      rootKids.sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
      lastPassMs = Date.now() - t0;
    }
    return best;
  }

  // ---------- move notation ----------
  //
  // Human-readable, replayable move text: the building name (with a trailing
  // ' to distinguish the second of an identical pair), the piece's top-left
  // occupied square in algebraic coordinates (columns a-j left to right, rows
  // 1-10 top to bottom), and an orientation tag rN for pieces that aren't
  // rotation-symmetric. Examples:
  //   "cathedral e5 r90"   "tavern e5"   "stable' a1 r90"   "academy f3 r270"
  //   "pass"
  // A whole game is just these lines in order, the cathedral placement first.

  const SHAPE_NAME = {
    41: 'cathedral',
    21: 'tavern', 23: 'stable', 25: 'inn', 27: 'bridge', 29: 'square',
    44: 'manor', 31: 'abbey', 35: 'castle', 33: 'infirmary', 37: 'tower', 39: 'academy',
    66: 'tavern', 64: 'stable', 58: 'inn', 52: 'bridge', 62: 'square',
    60: 'manor', 48: 'abbey', 54: 'castle', 56: 'infirmary', 68: 'tower', 50: 'academy',
  };
  const pieceName = id => SHAPE_NAME[PIECES[id].shape] || 'piece';

  // disambiguator: "" for the first piece of a shape/owner, "'" for the
  // second, etc. (only taverns, stables and inns come in identical pairs)
  function dupTag(id) {
    const shape = PIECES[id].shape, owner = ownerOf(id);
    let rank = 0;
    for (const p of PIECES) {
      if (p.shape !== shape || ownerOf(p.id) !== owner) continue;
      if (p.id === id) break;
      rank++;
    }
    return "'".repeat(rank);
  }

  function coveredCells(id, rot, col, row) {
    return cellsFor(id, rot).map(([i, j]) => [col + i, row + j]);
  }
  // top-left occupied square: smallest row, then smallest column
  function topLeftCell(cells) {
    let best = cells[0];
    for (const c of cells) {
      if (c[1] < best[1] || (c[1] === best[1] && c[0] < best[0])) best = c;
    }
    return best;
  }
  const sqText = (c, r) => String.fromCharCode(97 + c) + (r + 1);

  function moveToText(id, rot, col, row) {
    const [tc, tr] = topLeftCell(coveredCells(id, rot, col, row));
    let t = pieceName(id) + dupTag(id) + ' ' + sqText(tc, tr);
    if (distinctRots[id].length > 1) t += ' r' + (((rot % 360) + 360) % 360);
    return t;
  }

  // Parse move text against the state it applies to. Returns
  // { id, rot, col, row } or { pass: true } or null if it is not a legal move
  // in s. Identical pieces are interchangeable, so the disambiguator is
  // optional on input; orientation may be omitted for symmetric pieces.
  function textToMove(s, text) {
    text = String(text).trim().toLowerCase();
    if (text === 'pass') return { pass: true };
    const m = text.match(/^([a-z]+)('*)\s+([a-j])(10|[1-9])(?:\s+r(\d+))?$/);
    if (!m) return null;
    const name = m[1], tag = m[2];
    const col = m[3].charCodeAt(0) - 97, row = +m[4] - 1;
    const rotGiven = m[5] != null ? (((+m[5]) % 360) + 360) % 360 : null;
    const player = s.turn;
    // An untagged name means the canonical first copy (dupTag ""); a trailing
    // ' means the second. Matching the exact tag keeps decoding deterministic
    // regardless of hand order, so two networked clients never disagree on
    // which physical piece a move refers to.
    const cands = [];
    for (const id of s.hand) {
      if (pieceName(id) !== name) continue;
      if (s.phase === 'cathedral') { if (id !== 0) continue; }
      else if (id === 0 || ownerOf(id) !== player) continue;
      if (dupTag(id) !== tag) continue;
      cands.push(id);
    }
    for (const id of cands) {
      const rots = rotGiven != null ? [rotGiven] : distinctRots[id];
      for (const rot of rots) {
        // the anchor is target square minus the shape's own top-left offset,
        // so the piece's top-left occupied cell lands exactly on (col,row)
        const [oi, oj] = topLeftCell(cellsFor(id, rot));
        const c0 = col - oi, r0 = row - oj;
        if (canPlace(s, player, id, rot, c0, r0)) return { id, rot, col: c0, row: r0 };
      }
    }
    return null;
  }

  // Apply a line of move text to s (mutating it like place/pass). Returns the
  // place() events, {passed:true}, or null if the line is not a legal move.
  function applyText(s, text) {
    const mv = textToMove(s, text);
    if (!mv) return null;
    if (mv.pass) { pass(s); return { passed: true }; }
    return place(s, mv.id, mv.rot, mv.col, mv.row);
  }

  // Rebuild a state by replaying a record (array of lines, or a newline- or
  // semicolon-separated string). `cathedralPlacer` is the player (1 or 2) who
  // placed the cathedral — the first line. Returns the final state, or throws
  // on the first illegal line.
  function replay(cathedralPlacer, record) {
    const lines = Array.isArray(record)
      ? record : String(record).split(/[\n;]+/);
    const s = newGame(cathedralPlacer);
    let n = 0;
    for (let line of lines) {
      line = line.trim();
      if (!line || line[0] === '#') continue;   // blank/comment lines ignored
      if (applyText(s, line) === null) {
        throw new Error(`illegal move at line ${n + 1}: "${line}"`);
      }
      n++;
    }
    return s;
  }

  return {
    N, ownerOf, other, cellsFor, sizeOf, distinctRots,
    newGame, cloneState, canPlace, place, pass,
    legalMoves, hasLegalMove, score,
    chooseMove, chooseCathedral,
    pieceName, moveToText, textToMove, applyText, replay,
  };
})();

if (typeof module !== 'undefined') module.exports = ENGINE;

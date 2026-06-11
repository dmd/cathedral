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
  const footOf = id => FOOT[String(PIECES[id].shape)];
  const sizeOf = id => footOf(id).length;

  function rotCell(i, j, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return [-j - 1, i];
      case 180: return [-i - 1, -j - 1];
      case 270: return [j, -i - 1];
      default:  return [i, j];
    }
  }

  function cellsFor(id, rot) {
    return footOf(id).map(([i, j]) => rotCell(i, j, rot));
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
      cathedralPlacer,
      passes: 0,
    };
  }

  function cloneState(s) {
    return {
      grid: s.grid.slice(),
      terr: s.terr.slice(),
      placed: Object.fromEntries(Object.entries(s.placed).map(([k, v]) => [k, { ...v }])),
      hand: s.hand.slice(),
      cathedralGone: s.cathedralGone,
      firstBuildDone: { ...s.firstBuildDone },
      phase: s.phase,
      turn: s.turn,
      cathedralPlacer: s.cathedralPlacer,
      passes: s.passes,
    };
  }

  function canPlace(s, player, id, rot, col, row) {
    if (s.phase === 'over') return false;
    if (!s.hand.includes(id)) return false;
    if (s.phase === 'cathedral' ? id !== 0 : ownerOf(id) !== player) return false;
    const opp = other(player);
    for (const [i, j] of cellsFor(id, rot)) {
      const c = col + i, r = row + j;
      if (c < 0 || c >= N || r < 0 || r >= N) return false;
      const k = r * N + c;
      if (s.grid[k] !== -1) return false;
      if (s.terr[k] === opp) return false;
    }
    return true;
  }

  // Claim check for `player` after their move. Mutates s; returns events.
  function computeClaims(s, player) {
    const ev = { claimedCells: [], captured: [], cathedralCaptured: false };
    const isWall = new Array(N * N);
    for (let k = 0; k < N * N; k++) {
      isWall[k] = s.grid[k] !== -1 && ownerOf(s.grid[k]) === player;
    }
    const seen = new Array(N * N).fill(false);
    for (let start = 0; start < N * N; start++) {
      if (seen[start] || isWall[start]) continue;
      // flood one component (8-connected: corner gaps leak)
      const comp = [];
      const stack = [start];
      seen[start] = true;
      while (stack.length) {
        const k = stack.pop();
        comp.push(k);
        const c = k % N, r = (k - c) / N;
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) {
            if (!dc && !dr) continue;
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nc >= N || nr < 0 || nr >= N) continue;
            const nk = nr * N + nc;
            if (!seen[nk] && !isWall[nk]) {
              seen[nk] = true;
              stack.push(nk);
            }
          }
        }
      }
      const enemies = new Set();
      for (const k of comp) {
        if (s.grid[k] !== -1) enemies.add(s.grid[k]);
      }
      if (enemies.size > 1) continue;
      if (enemies.size === 1) {
        const id = [...enemies][0];
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
      for (const k of comp) {
        // claim the whole enclosed space — including any stale enemy
        // territory whose backing wall was just captured
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
      for (const rot of distinctRots[0]) {
        for (let col = 0; col < N; col++) {
          for (let row = 0; row < N; row++) {
            if (canPlace(s, player, 0, rot, col, row)) moves.push({ id: 0, rot, col, row });
          }
        }
      }
      return moves;
    }
    const seenShapes = new Set();
    for (const id of s.hand) {
      if (id === 0 || ownerOf(id) !== player) continue;
      const shape = PIECES[id].shape;
      if (seenShapes.has(shape)) continue;   // identical pieces are interchangeable
      seenShapes.add(shape);
      for (const rot of distinctRots[id]) {
        for (let col = 0; col < N; col++) {
          for (let row = 0; row < N; row++) {
            if (canPlace(s, player, id, rot, col, row)) moves.push({ id, rot, col, row });
          }
        }
      }
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
      for (const rot of distinctRots[id]) {
        for (let col = 0; col < N; col++) {
          for (let row = 0; row < N; row++) {
            if (canPlace(s, player, id, rot, col, row)) return true;
          }
        }
      }
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

  // Squares of remaining buildings that no longer fit anywhere — as good as
  // lost for the final score.
  function deadSquares(s, player) {
    let dead = 0;
    const seenShapes = new Set();
    for (const id of s.hand) {
      if (id === 0 || ownerOf(id) !== player) continue;
      const shape = PIECES[id].shape;
      if (seenShapes.has(shape)) continue;
      seenShapes.add(shape);
      let fits = false;
      outer:
      for (const rot of distinctRots[id]) {
        for (let col = 0; col < N && !fits; col++) {
          for (let row = 0; row < N; row++) {
            if (canPlace(s, player, id, rot, col, row)) {
              fits = true;
              break outer;
            }
          }
        }
      }
      if (!fits) {
        // count every remaining copy of this shape
        for (const id2 of s.hand) {
          if (id2 !== 0 && ownerOf(id2) === player && PIECES[id2].shape === shape) {
            dead += sizeOf(id2);
          }
        }
      }
    }
    return dead;
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
            3.0 * (sc[opp] - sc[me]) +
            1.5 * (usableSpace(s, me) - usableSpace(s, opp)) +
            1.2 * influence(s, me);
    // late game is a packing contest: buildings that can no longer fit
    // anywhere are lost points
    if (empty <= 45) {
      v += 3.0 * (deadSquares(s, opp) - deadSquares(s, me));
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

  function chooseMove(s, me, rng, timeBudgetMs) {
    rng = rng || Math.random;
    if (s.phase === 'cathedral') return chooseCathedral(s, rng);
    const moves = legalMoves(s, me);
    if (!moves.length) return null;
    const deadline = Date.now() + (timeBudgetMs || 2500);
    // order root children by tactical gain + positional delta
    const kids = moves.map(m => {
      const s2 = cloneState(s);
      const ev = place(s2, m.id, m.rot, m.col, m.row);
      const key = moveGain(ev, m.id) +
                  1.5 * (usableSpace(s2, me) - usableSpace(s2, other(me))) +
                  1.2 * influence(s2, me);
      return { m, s2, key };
    });
    kids.sort((a, b) => b.key - a.key);
    // Iterative deepening: search ever deeper while the budget lasts,
    // re-ordering root moves by each completed pass. Only completed
    // passes are trusted (a truncated deep pass returns junk bounds).
    let best = kids[0].m;
    let lastPassMs = 0;
    const rootWidth = moves.length < 80 ? kids.length : ROOT_BEAM;
    for (let depth = 2; depth <= 30; depth++) {
      const remaining = deadline - Date.now();
      if (remaining < lastPassMs * 1.2 + 50) break;   // try deeper; truncation is harmless
      const t0 = Date.now();
      searchTimedOut = false;
      let passBest = null, passBestV = -Infinity, alpha = -Infinity;
      for (const kid of kids.slice(0, rootWidth)) {
        const v = search(kid.s2, depth, me, alpha, Infinity, deadline) + rng() * 0.3;
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
      kids.sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
      lastPassMs = Date.now() - t0;
    }
    return best;
  }

  return {
    N, ownerOf, other, cellsFor, sizeOf, distinctRots,
    newGame, cloneState, canPlace, place, pass,
    legalMoves, hasLegalMove, score,
    chooseMove, chooseCathedral,
  };
})();

if (typeof module !== 'undefined') module.exports = ENGINE;

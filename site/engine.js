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
        if (s.terr[k] === 0) {
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

  function countUsable(s, player) {
    const opp = other(player);
    let n = 0;
    for (let k = 0; k < N * N; k++) {
      if (s.grid[k] === -1 && s.terr[k] !== opp) n++;
    }
    return n;
  }

  function capturedSquares(ev) {
    let n = 0;
    for (const id of ev.captured) {
      if (id !== 0) n += sizeOf(id);
    }
    return n;
  }

  // Static value of a candidate move for `me`, after simulating it on a clone.
  function staticEval(s, me, move) {
    const sim = cloneState(s);
    const ev = place(sim, move.id, move.rot, move.col, move.row);
    const opp = other(me);
    let v = 0;
    v += 3.0 * sizeOf(move.id);                       // big buildings first
    v += 8.0 * ev.claimedCells.length;                // claimed territory
    v += 7.0 * capturedSquares(ev);                   // enemy building removed
    if (ev.cathedralCaptured) v += 25;
    v += 1.2 * (countUsable(sim, me) - countUsable(sim, opp));
    // don't build inside your own territory while open space remains
    let ownTerr = 0, openLeft = 0;
    for (const [i, j] of cellsFor(move.id, move.rot)) {
      if (s.terr[(move.row + j) * N + (move.col + i)] === me) ownTerr++;
    }
    for (let k = 0; k < N * N; k++) {
      if (s.grid[k] === -1 && s.terr[k] === 0) openLeft++;
    }
    if (openLeft > 8) v -= 2.0 * ownTerr;
    // mild centrality preference early in the game
    if (Object.keys(s.placed).length < 6) {
      for (const [i, j] of cellsFor(move.id, move.rot)) {
        v += 0.15 * (4.5 - Math.abs(move.col + i - 4.5)) +
             0.15 * (4.5 - Math.abs(move.row + j - 4.5));
      }
    }
    return { v, sim };
  }

  // Best reply value the opponent could get on the given board.
  function bestReplyGain(sim, opp) {
    const me = other(opp);
    let best = -Infinity;
    for (const m of legalMoves(sim, opp)) {
      const s2 = cloneState(sim);
      const ev = place(s2, m.id, m.rot, m.col, m.row);
      let g = 3.0 * sizeOf(m.id) + 8.0 * ev.claimedCells.length + 7.0 * capturedSquares(ev);
      if (ev.cathedralCaptured) g += 25;
      g += 1.2 * (countUsable(s2, opp) - countUsable(s2, me));
      if (g > best) best = g;
    }
    return best === -Infinity ? 0 : best;
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

  function chooseMove(s, me, rng) {
    rng = rng || Math.random;
    if (s.phase === 'cathedral') return chooseCathedral(s, rng);
    const moves = legalMoves(s, me);
    if (!moves.length) return null;
    const scored = moves.map(m => ({ m, ...staticEval(s, me, m) }));
    scored.sort((a, b) => b.v - a.v);
    const K = Math.min(12, scored.length);
    const opp = other(me);
    let best = null, bestV = -Infinity;
    for (let i = 0; i < K; i++) {
      const { m, v, sim } = scored[i];
      const total = v - 0.85 * bestReplyGain(sim, opp) + rng() * 0.4;
      if (total > bestV) {
        bestV = total;
        best = m;
      }
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

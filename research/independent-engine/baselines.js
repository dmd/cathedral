'use strict';
// Reference opponents for developing/testing an AI. Pure functions of the
// RULES module + state. No search — easy to beat once your AI is decent.
var BASELINES = (function () {
  function capturedSquares(R, ev) {
    let n = 0; for (const id of ev.captured) if (id !== 0) n += R.sizeOf(id); return n;
  }
  // uniform random legal move
  function random(R, s, me, rng) {
    const mv = R.legalMoves(s, me);
    return mv.length ? mv[Math.floor(rng() * mv.length)] : null;
  }
  // one-ply greedy: maximise immediate territory claimed + captures + size
  function greedy(R, s, me, rng) {
    const mv = R.legalMoves(s, me);
    if (!mv.length) return null;
    if (s.phase === 'cathedral') {
      let best = mv[0], bv = -1e9;
      for (const m of mv) {
        let v = 0;
        for (const [i, j] of R.cellsFor(0, m.rot)) v -= Math.abs(m.col + i - 4.5) + Math.abs(m.row + j - 4.5);
        v += rng() * 0.5;
        if (v > bv) { bv = v; best = m; }
      }
      return best;
    }
    let best = mv[0], bv = -1e9;
    for (const m of mv) {
      const s2 = R.cloneState(s);
      const ev = R.place(s2, m.id, m.rot, m.col, m.row);
      const v = 8 * ev.claimedCells.length + 7 * capturedSquares(R, ev) + 3 * R.sizeOf(m.id) + rng() * 0.3;
      if (v > bv) { bv = v; best = m; }
    }
    return best;
  }
  return { random, greedy };
})();
if (typeof module !== 'undefined') module.exports = BASELINES;

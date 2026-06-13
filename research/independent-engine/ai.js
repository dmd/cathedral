'use strict';
/*
 * Cathedral engine — design notes
 * ================================
 *
 * The game is scored on UNPLACED squares (lower wins), so the engine maximises
 * (my placeable potential) - (opp placeable potential), everything expressed
 * from the root player's point of view.
 *
 * SEARCH
 *  - Iterative-deepening minimax with alpha-beta. The root perspective is held
 *    fixed: we maximise on the root's turns and minimise on the opponent's.
 *  - Move ordering drives everything. At every node, all legal moves are scored
 *    by a "shallow" heuristic — number of territory cells claimed, squares
 *    captured, and piece size — computed by actually applying the move (so the
 *    very valuable claim/capture moves bubble to the front). The best `limit`
 *    moves (8–18, smaller deeper down) are then searched; the rest are pruned.
 *  - Iterative deepening naturally searches deeper in the endgame, where the
 *    branching factor collapses and exact packing matters most. (Empirically,
 *    on the opening the branching factor is ~400 and depth past ~2–3 adds
 *    little — a strong evaluation, applied at shallow depth with good ordering,
 *    is what wins; so the budget is spent mostly on a wide, well-ordered ply.)
 *  - A pass is handled explicitly so terminal/forced-pass states score right.
 *
 * EVALUATION (leaf; each term is my-value minus opp-value)
 *  - placedSquares (w=10): squares already on the board. Locked-in progress —
 *    the dominant term, since unplaced squares are exactly the score.
 *  - placePotential (w=6): for each still-unplaced distinct shape, its size if
 *    that shape can STILL be legally placed somewhere on the board. This is the
 *    forward-looking forecast: room that is gone (you can no longer fit a piece)
 *    is room that will cost you its squares at game end. Largest pieces are
 *    checked first; identical duplicates are approximated from the first copy.
 *  - territory (w=1.5): owned territory cells — land the opponent can never
 *    build on, and the mechanism for walling space off / capturing.
 *  - largestPlaceable (w=2): size of the biggest piece you can still place.
 *    Getting locked out of your 4-/5-square pieces is the main way to lose, so
 *    this guards against it explicitly on top of the potential sum.
 *
 * CATHEDRAL PLACEMENT: the neutral cathedral is placed centrally, splitting the
 * board so neither side gets a clean half to wall off. (The cathedral placer is
 * structurally a tempo down — the opponent moves first — so this just avoids
 * making it worse.)
 *
 * Why captures matter: enclosing a region with exactly one enemy building
 * returns it to their hand (raising their unplaced count now) AND hands you the
 * whole region as territory. The shallow ordering weights captures heavily so
 * the search finds them, and the leaf rewards the resulting placed/territory
 * swing.
 *
 * Time: a fraction (~0.78) of budgetMs is used as a hard deadline, checked
 * between root moves and inside the search, leaving comfortable headroom.
 */

var AI = (function () {
  var N = 10;

  // ---- fast helpers operating on a state ----

  function ownerSquaresPlaced(s, player) {
    // squares of this player's pieces currently on the board
    var n = 0;
    for (var id in s.placed) {
      id = +id;
      if (id === 0) continue;
      if (RULES.ownerOf(id) === player) n += RULES.sizeOf(id);
    }
    return n;
  }

  // Count territory cells per player.
  function territoryCounts(s) {
    var t1 = 0, t2 = 0, terr = s.terr;
    for (var k = 0; k < 100; k++) {
      var v = terr[k];
      if (v === 1) t1++; else if (v === 2) t2++;
    }
    return [t1, t2];
  }

  function canPlaceAny(s, player, id) {
    var rots = RULES.distinctRots[id];
    for (var ri = 0; ri < rots.length; ri++) {
      var rot = rots[ri];
      var cells = RULES.cellsFor(id, rot);
      for (var row = 0; row < N; row++) {
        for (var col = 0; col < N; col++) {
          if (RULES.canPlace(s, player, id, rot, col, row)) return true;
        }
      }
    }
    return false;
  }

  // Placement potential: for each still-unplaced distinct shape this player
  // owns, add its size if it can still be legally placed somewhere. Bigger
  // pieces are checked first so we can stop early per shape. This estimates the
  // additional squares the player can realistically still place — the core
  // forward-looking term, since the game is scored on unplaced squares.
  // Also returns largestPlaceable as a side output.
  function placePotential(s, player, out) {
    var pot = 0, largest = 0, seen = {};
    // iterate hand sorted by descending size for stable early behaviour
    for (var i = 0; i < s.hand.length; i++) {
      var id = s.hand[i];
      if (id === 0 || RULES.ownerOf(id) !== player) continue;
      var shape = PIECES[id].shape;
      if (seen[shape]) {
        // a duplicate identical shape: if the first copy is placeable, assume
        // the duplicate is too (cheap approximation, usually true early)
        if (seen[shape] === 2) pot += RULES.sizeOf(id);
        continue;
      }
      var sz = RULES.sizeOf(id);
      if (canPlaceAny(s, player, id)) {
        pot += sz;
        if (sz > largest) largest = sz;
        seen[shape] = 2;   // placeable
      } else {
        seen[shape] = 1;   // not placeable
      }
    }
    if (out) out.largest = largest;
    return pot;
  }

  // ---- leaf evaluation, from `root`'s perspective ----

  var _po = { largest: 0 };

  function evaluate(s, root) {
    var opp = root === 1 ? 2 : 1;

    var placedMe = ownerSquaresPlaced(s, root);
    var placedOpp = ownerSquaresPlaced(s, opp);

    var terr = territoryCounts(s);
    var terrMe = terr[root - 1], terrOpp = terr[opp - 1];

    var potMe = placePotential(s, root, _po);
    var bigMe = _po.largest;
    var potOpp = placePotential(s, opp, _po);
    var bigOpp = _po.largest;

    var score = 0;
    // placed squares are locked in; potential forecasts the rest; territory and
    // big-piece placeability guard against being walled out of room.
    score += 10.0 * (placedMe - placedOpp);
    score += 6.0 * (potMe - potOpp);
    score += 1.5 * (terrMe - terrOpp);
    score += 2.0 * (bigMe - bigOpp);
    return score;
  }

  // ---- shallow per-move ordering score (cheap, no recursion) ----

  function shallowScore(s, player, m, ev) {
    var cap = 0;
    for (var i = 0; i < ev.captured.length; i++)
      if (ev.captured[i] !== 0) cap += RULES.sizeOf(ev.captured[i]);
    var v = 0;
    v += 8 * ev.claimedCells.length;
    v += 12 * cap;
    v += 4 * RULES.sizeOf(m.id);
    return v;
  }

  // Generate scored, ordered candidate moves for `player`.
  function orderedCandidates(s, player, limit, rng) {
    var moves = RULES.legalMoves(s, player);
    if (!moves.length) return moves;
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var s2 = RULES.cloneState(s);
      var ev = RULES.place(s2, m.id, m.rot, m.col, m.row);
      var sc = shallowScore(s, player, m, ev) + (rng ? rng() * 0.05 : 0);
      scored.push({ m: m, sc: sc, s2: s2 });
    }
    scored.sort(function (a, b) { return b.sc - a.sc; });
    if (limit && scored.length > limit) scored.length = limit;
    return scored;
  }

  var startTime = 0, budget = 0, timedOut = false;
  function timeUp() {
    if (timedOut) return true;
    if (Date.now() - startTime >= budget) { timedOut = true; return true; }
    return false;
  }

  // Minimax with alpha-beta (root perspective fixed; maximise on root's turns,
  // minimise on the opponent's).
  function minimax(s, toMove, root, depth, alpha, beta, rng) {
    if (s.phase === 'over' || depth <= 0) return evaluate(s, root);
    if (timeUp()) return evaluate(s, root);

    var maximizing = (toMove === root);
    var limit = depth >= 3 ? 8 : (depth === 2 ? 12 : 18);
    var cands = orderedCandidates(s, toMove, limit, rng);
    var opp = toMove === 1 ? 2 : 1;

    if (!cands.length) {
      var s2 = RULES.cloneState(s);
      RULES.pass(s2);
      if (s2.phase === 'over') return evaluate(s2, root);
      return minimax(s2, opp, root, depth - 1, alpha, beta, rng);
    }

    var best;
    if (maximizing) {
      best = -Infinity;
      for (var i = 0; i < cands.length; i++) {
        var v = minimax(cands[i].s2, opp, root, depth - 1, alpha, beta, rng);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
        if (timeUp()) break;
      }
    } else {
      best = Infinity;
      for (var j = 0; j < cands.length; j++) {
        var v2 = minimax(cands[j].s2, opp, root, depth - 1, alpha, beta, rng);
        if (v2 < best) best = v2;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
        if (timeUp()) break;
      }
    }
    return best;
  }

  // ---- cathedral placement ----

  function chooseCathedral(s, me, rng) {
    var moves = RULES.legalMoves(s, me);
    if (!moves.length) return null;
    var best = moves[0], bv = -1e9;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      // prefer central placement (cathedral in the middle splits the board)
      var v = 0;
      var cells = RULES.cellsFor(0, m.rot);
      for (var c = 0; c < cells.length; c++) {
        var ci = m.col + cells[c][0], cj = m.row + cells[c][1];
        v -= Math.abs(ci - 4.5) + Math.abs(cj - 4.5);
      }
      v += rng() * 0.3;
      if (v > bv) { bv = v; best = m; }
    }
    return best;
  }

  // ---- main entry ----

  function chooseMove(s, me, rng, budgetMs) {
    startTime = Date.now();
    budget = Math.max(15, (budgetMs || 300) * 0.78);
    timedOut = false;

    if (s.phase === 'cathedral') return chooseCathedral(s, me, rng);
    if (s.phase === 'over') return null;

    var rootMoves = orderedCandidates(s, me, 0, rng); // all, ordered
    if (!rootMoves.length) return null;
    var opp = me === 1 ? 2 : 1;

    // iterative deepening. Widen the root when the position is small (endgame),
    // since exhaustive packing matters most then and the tree is cheap.
    var bestMove = rootMoves[0].m;
    var rootLimit = rootMoves.length <= 60 ? 24 : 16;
    for (var depth = 1; depth <= 8; depth++) {
      var cands = rootMoves.length > rootLimit ? rootMoves.slice(0, rootLimit) : rootMoves;
      var alpha = -Infinity, beta = Infinity;
      var localBest = -Infinity, localMove = bestMove;
      var completed = true;
      for (var i = 0; i < cands.length; i++) {
        var v = minimax(cands[i].s2, opp, me, depth - 1, alpha, beta, rng);
        if (timeUp()) { completed = false; break; }
        if (v > localBest) { localBest = v; localMove = cands[i].m; }
        if (localBest > alpha) alpha = localBest;
      }
      if (completed) bestMove = localMove;
      else { if (localBest > -Infinity) bestMove = localMove; break; }
      if (timeUp()) break;
    }
    return bestMove;
  }

  return { chooseMove: chooseMove };
})();
if (typeof module !== 'undefined') module.exports = AI;

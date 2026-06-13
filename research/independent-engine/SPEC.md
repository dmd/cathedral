# Build a Cathedral-playing AI (from scratch)

You are designing a game-playing AI for **Cathedral**, a two-player abstract
territory game. You have the exact rules (as a code module, `rules.js`) and
nothing else — there is no existing AI to look at, and you should not try to
find one. Build the strongest engine you can from first principles.

Work ONLY inside this directory (`/tmp/cathedral-challenge`). Do not read or
import anything from elsewhere on the machine; the point of this exercise is an
independent design.

## The game

- Board is 10x10 cells. Cells are referenced as a flat index `k = row*10 + col`,
  with `col` and `row` each 0..9.
- Two players: **1** (blue, piece ids 15..28) and **2** (orange, piece ids
  1..14). Piece **0** is the **cathedral** (neutral).
- Each player owns one each of buildings of sizes 1..5 squares, plus duplicates
  of the three smallest. Piece sizes are given by their shape (see `RULES.sizeOf`).
- **Goal:** place as many of your buildings as possible. At the end, your score
  is the total number of squares of your *unplaced* buildings. **Lower is
  better; fewer unplaced squares wins.**

### Turn order
1. One player (the "cathedral placer") places the cathedral anywhere on the
   board on the first move.
2. The *other* player then makes the first building move, and players alternate
   thereafter.
3. A player who has **no legal move must pass**. When **both players pass in
   succession**, the game is over.

### Placing
- A piece is placed at a position+rotation; all its cells must be empty and not
  on the opponent's territory, and on the board.
- Identical copies of a shape are interchangeable.

### Territory and capture (the heart of the game)
- After your move, any empty region **enclosed wall-to-wall by your buildings
  and/or the board edge** becomes **your territory**. Enclosure uses
  **8-connectivity** for the *empty region*: a region leaks out through a
  diagonal (corner-to-corner) gap, so to seal a region your walls must touch
  edge-to-edge. The **cathedral never counts as a wall** for enclosure.
- If an enclosed region contains **exactly one** enemy building (or the
  cathedral), that piece is **captured**: a building returns to its owner's hand
  (to be replayed later); the cathedral is removed permanently. The whole
  enclosed region (including where the captured piece sat) becomes your
  territory.
- If an enclosed region contains **two or more** enemy buildings, **nothing** is
  claimed or captured there.
- **No claims happen on a player's first building move.**
- You may never place onto the opponent's territory (but you may place onto your
  own).

These rules are implemented exactly in `rules.js`; trust the code as the source
of truth. `RULES.place(...)` returns the events (claims/captures) of a move.

## The RULES API (in `rules.js`, global `RULES`)

State object `s` has: `grid` (Int? array length 100: pieceId or -1),
`terr` (length 100: 0 none / 1 / 2), `placed` (id -> {col,row,rot}),
`hand` (array of unplaced piece ids, includes 0 until the cathedral is placed),
`cathedralGone` (bool), `firstBuildDone` ({1,2}), `phase`
('cathedral' | 'play' | 'over'), `turn` (1 or 2), `passes`.

Functions:
- `RULES.newGame(placer)` -> fresh state (placer = who places the cathedral).
- `RULES.cloneState(s)` -> deep-ish copy safe to mutate.
- `RULES.legalMoves(s, player)` -> array of `{id, rot, col, row}` (identical
  shapes deduplicated). In the cathedral phase, returns the cathedral placements.
- `RULES.hasLegalMove(s, player)` -> bool.
- `RULES.canPlace(s, player, id, rot, col, row)` -> bool.
- `RULES.place(s, id, rot, col, row)` -> events `{claimedCells:[k...],
  captured:[id...], cathedralCaptured:bool}` and MUTATES s (uses s.turn as the
  mover, advances turn). Returns null if illegal.
- `RULES.pass(s)` -> mutates s (advance turn, increment passes; two in a row ends).
- `RULES.score(s)` -> `{1: unplacedSquares, 2: unplacedSquares}`.
- `RULES.ownerOf(id)`, `RULES.other(p)`, `RULES.sizeOf(id)`,
  `RULES.cellsFor(id, rot)` (-> array of [i,j] cell offsets),
  `RULES.distinctRots[id]` (-> array of the distinct rotations for that piece),
  `RULES.N` (= 10).
- Notation (handy for debugging): `RULES.moveToText`, `RULES.textToMove`,
  `RULES.replay`, `RULES.pieceName`.

`rng` passed to you is a deterministic `() => float in [0,1)`. Use it for any
randomness so games are reproducible.

## Your task

Replace `ai.js` with your engine. Define a global `AI` with:

```js
var AI = {
  chooseMove: function (state, me, rng, budgetMs) {
    // return a move {id, rot, col, row} for player `me` (== state.turn),
    // or null to pass. In the cathedral phase return a cathedral placement
    // {id:0, rot, col, row}. Respect the time budget (budgetMs).
  }
};
if (typeof module !== 'undefined') module.exports = AI;
```

Constraints:
- Pure browser-safe JS in `ai.js`: you may use `Math`, `Date.now()`, the `rng`,
  and the globals `RULES`, `PIECES`, `FOOT`, `SHAPES`. No `require`, no Node-only
  APIs, no external libraries.
- **Respect `budgetMs`** — return well within it (it may be as low as ~150ms in
  testing and a few seconds in real play). Don't block longer.
- Never return an illegal move (validate with `RULES.canPlace` if unsure).

## How to test

```
node harness.js greedy 30 300     # vs the one-ply greedy baseline
node harness.js random 30 300     # vs random
node harness.js self 20 300       # your AI vs itself (sanity / timing)
```

Goals, in order:
1. Beat `random` ~100%.
2. Beat `greedy` decisively (aim for a large win margin and a much lower average
   unplaced-squares count).
3. Self-play should look sane: games finish, move times stay within budget, and
   results are roughly balanced between colors.

Think about what actually wins Cathedral: controlling space, walling off
territory, denying the opponent room, capturing, and — late — packing your
remaining (especially bulky) pieces before the board fragments. Search depth
helps, but a good position evaluation matters more. Iterate against the
baselines and measure. When done, leave `ai.js` as your best engine and write a
short note (in a comment at the top of `ai.js`) describing your approach.

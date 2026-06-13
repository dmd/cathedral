# Cathedral engine — design notes & session log

This documents the computer opponent in `site/engine.js` (the rules + AI),
the supporting features built around it, what was tried, and where to go next
(notably **learned evaluation**). It's written so a future session can pick the
work back up without re-deriving everything or repeating dead ends.

The game: two players place polyomino "buildings" on a 10×10 board. Enclosing
empty regions wall‑to‑wall claims **territory**; enclosing exactly one enemy
building (or the cathedral) **captures** it. The score is the total squares of
your *unplaced* buildings — **lower wins**. Full rules are in `site/rules.html`
and re‑stated in `research/independent-engine/SPEC.md`.

---

## File map

| File | What |
|------|------|
| `site/engine.js` | Pure rules engine + AI (`ENGINE`). No DOM; loadable in node. |
| `site/data.js` | Generated piece geometry (`SHAPES`, `PIECES`, `FOOT`). |
| `site/game.js` | UI: dragging, vs‑computer + network play, moves modal. |
| `tests/engine-test.js` | Rules unit tests + AI soak (invariants, timing). |
| `tests/ai-match.js` | **Head‑to‑head between two engine builds** at equal budget. The main A/B tool. |
| `tests/notation-test.js` | Move‑notation round‑trip + replay tests. |
| `tests/netsync-test.js` | Two simulated network clients stay byte‑identical (lockstep). |
| `tests/strand.js` | Diagnostic: which piece sizes get stranded (endgame packing). |
| `tests/vs-weak.js` | Engine vs a random‑opening opponent (does it punish bad play?). |
| `research/independent-engine/` | The blind‑rebuild experiment (held‑out opponent). |

Run anything headless with `node tests/<file>.js`. The engine has no deps.

---

## Engine architecture (`site/engine.js`)

### State
`newGame(placer)` → `{ grid[100] (pieceId or -1), terr[100] (0/1/2),
placed{id→{col,row,rot}}, hand[ids], cathedralGone, firstBuildDone{1,2},
phase('cathedral'|'play'|'over'), turn, passes }`. Flat index `k = row*10+col`.
Player 1 = blue (ids 15–28), player 2 = orange (ids 1–14), cathedral = id 0.

### Move generation (fast)
Footprints, grid offsets and on‑board placement windows are **precomputed per
(id, rot)** (`SIZE`, `CELLS`, `WIN`, `OWNER`). `shapePlacements` /
`legalMoves` / `canPlace` read these instead of recomputing rotations.
Identical shapes are deduplicated in `legalMoves` (the two taverns etc. are
interchangeable). `computeClaims` does the 8‑connected flood fill for
territory/capture using reusable module‑level typed scratch buffers (it is the
hottest path — called on every simulated placement). **A real bug fixed early:**
the original generator only scanned anchors in `[0,9]`, but some rotations have
all cells at negative offsets, so legal placements along two board edges were
invisible — the AI literally couldn't see them, and sometimes passed with legal
moves available.

### Evaluation — `posEval(s, me)` (from `me`'s point of view)
Linear combination of features (each is *my value − opponent value*):

```
v = 8.0 * (territory cells)
  + 5.0 * quasiTerr            // empty regions already de-facto controlled
  + 3.0 * (opp unplaced sq − my unplaced sq)   // the locked-in score
  + 1.5 * (usableSpace diff)   // 4-connected open room that fits a remaining piece
  + 1.2 * influence            // Voronoi: who is closer to each contested empty cell
  + (empty<=62 ? 4.0 * (packLoss(opp) − packLoss(me)) : 0)
```

- **quasiTerr**: a small empty region whose adjacent buildings are all one
  player's (and that doesn't touch enemy territory) is already effectively
  theirs — an enemy piece inside is a lone intruder, captured once the corner
  leaks are plugged. Crediting it stopped the engine wasting a tavern formally
  sealing pockets it already owned.
- **usableSpace**: only counts 4‑connected open regions big enough to fit one
  of your remaining pieces (fragmented slivers don't count).
- **influence**: multi‑source BFS distance from each player's buildings through
  cells they could still occupy; rewards contesting regions the opponent is
  walling off.
- **packLoss**: greedily packs your remaining pieces largest‑first into the
  space still open to you and counts what won't fit. Engages from mid‑game
  (`empty<=62`) because bulky pieces — **size‑4 especially** — get stranded if
  deferred until the gaps fragment. (Per‑piece "does this shape fit somewhere"
  overcounts; greedy packing sees your own pieces competing for the same room.)

### Search — `search()` + `chooseMove()`
- **Iterative‑deepening alpha‑beta**, fixed root perspective, under a wall‑clock
  deadline. Only *completed* depth passes are trusted (a truncated deep pass
  returns junk bounds; there's an explicit guard for that at the root).
- **Beam**: `BEAM = {2:10, 1:8}`, deeper interior levels default to 12;
  `ROOT_BEAM = 24`. Endgame (`moves.length < 60`) is "narrow" → no beaming,
  every fitting move searched.
- **Move ordering is the workhorse** (see Insights). Every child is applied
  (clone+place) and scored by the *rich* key: `moveGain` (claims, captures,
  size) + `1.5*usableSpace diff` + `1.2*influence`. This full place‑based key
  is used at **every** node, not just the root.
- **Threat‑aware root**: before choosing, simulate the opponent's best immediate
  enclosure/capture; if it's worth ~3+ squares, force the moves that contest the
  threatened region into the root search regardless of heuristic rank — those
  defensive moves score terribly on every ordering heuristic and would otherwise
  never be searched.
- **Weakly‑dominant pruning**: never play a piece *wholly* inside your own
  territory while open ground exists (those cells are banked forever, so the
  move is always deferrable). Applied at the root.

### Difficulty (`site/game.js`, currently **hard‑only**)
Difficulty = think‑time + **root eval noise** (a random bonus up to N eval
points added to each root move's value; one territory cell ≈ 8). Noise is what
makes low levels beatable — it makes the AI prefer its 2nd/3rd‑best moves, like
human inaccuracy. Calibrated: ±18 was within noise (no effect), ±60 a real
handicap. The hard level uses 4000 ms and 0.3 noise (tie‑break only). The
easy/medium entries, the ⭐ level button, and the level message annotations are
**commented out** (search `LEVELS`, `levelbtn`); uncomment to restore.

---

## Features built around the engine

### Move notation & replay (`ENGINE.moveToText/textToMove/applyText/replay`)
Human‑readable, replayable: `building[''] square [rN]`, e.g.
`academy f3 r270`, `tavern e5`, `pass`. Square = the piece's top‑left occupied
cell (columns a–j, rows 1–10). A trailing `'` disambiguates the second of an
identical pair; decode is **exact‑tag** (deterministic regardless of hand order,
so two networked clients never disagree on which physical piece a move means).
`replay(placer, record)` rebuilds any position; it **skips `#` comment lines**
and **derives forced passes** (the record holds only placements — a player with
no legal move is passed automatically, exactly as live play does).

### Hidden moves list (desktop `m`)
Press `m` for a copy‑pasteable game record, headed by the cathedral placer so it
round‑trips through `replay`. Capturing moves get a commented note
(`#   captures orange abbey` / `#   captures cathedral`). Built for sharing,
debugging, and handing positions to a fresh model.

### Network protocol (semantic, rules‑enforced)
Two browsers stay in **lockstep** over a dumb WebSocket relay, exchanging
committed moves *in notation* (`MOVE`), decoded against each client's own
engine; claims/captures/passes are derived identically on each side. `DRAG` is a
cosmetic preview of the opponent sliding a piece. Free‑form tabletop play and
the old Flash/SWF interop were removed (rules are always enforced now).
`tests/netsync-test.js` proves byte‑identical lockstep across 1600+ moves
incl. captures with zero desyncs. **Still wants a live two‑device smoke test**
for the DOM/animation paths (untested headlessly).

---

## How to validate a change

The bar for any AI change is **head‑to‑head at the production budget**, not a
hunch. Typical loop:

```
cp site/engine.js /tmp/engine-base.js      # snapshot the champion
# ...edit site/engine.js...
node tests/engine-test.js                  # rules still pass, timing OK
node tests/ai-match.js site/engine.js /tmp/engine-base.js 24 800   # quick A/B
node tests/ai-match.js site/engine.js /tmp/engine-base.js 16 4000  # production gate
```

`ai-match.js <A> <B> [games] [budgetMs] [seed]` alternates colors and cathedral
placer for fairness and reports W/L/D plus average unplaced squares (the
"harder to beat" signal — often more reliable than the win count over small
samples). **Conclusions can flip between budgets** — always gate at the real
4000 ms before shipping (learned this the hard way; see below).

---

## Session history — what worked (with evidence)

In rough order, each validated head‑to‑head vs the prior build:

1. **Faster search core + edge‑placement bug fix** (`adb0498`, `5956d68`):
   ~10× faster primitives (precomputed footprints, typed claim buffers, cheaper
   cloning) → ~2 extra plies. Fixed the edge‑blindness generation bug. Net
   11–5 vs the original at 2500 ms.
2. **4 s think time** for hard (`7f0cdcd`): the engine scales with budget.
3. **Greedy packing endgame eval** (`ad40d9e`) then **engage it earlier /
   weight 4** (`ec00e7b`): replaced a per‑piece "dead" check; targets the
   size‑4 stranding directly. ~57% win share across budgets, consistently
   ~1.3–1.5 fewer stranded squares/game.
4. **Never fill own territory while open ground exists** (`fd99193`): a
   user‑spotted tempo leak. 9–5–2 at 4000 ms.
5. **Threat‑aware root candidates** (`bd8980d`): the big one — the engine had
   let the opponent enclose a whole corner because defensive moves never made
   the root beam. 10–5–1 at 4000 ms, avg score 2.7 vs 7.3.
6. **Quasi‑territory eval** (`45ccfe9`): stop wasting pieces formally sealing
   already‑controlled pockets. 9–7 at 4000 ms.

Plus non‑AI polish: colorblind‑safe palette (blue `#0072B2` / orange `#D55E00`,
cathedral gray), yellow selection highlight, home‑screen split + name
canonicalization, black app icon, etc.

## Rejected experiments (don't re‑try blindly)

- **Cheap per‑child move ordering** (locality heuristic instead of the full
  place‑based key): won at 250 ms but **lost at 2500 ms** — beam pruning
  compounds ordering errors with depth, so ordering quality dominates once
  passes complete. The rich key at every node is essential.
- **In‑tree (not just root) territory‑filter** and **bulky‑in‑hand eval
  penalty stacked on packLoss**: both tested worse (the latter double‑counts).
- **Wider beams**, **higher placement‑reward weight**, several **eval
  reweightings**: neutral or worse.
- **Wider beam on opponent‑reply nodes**: 6–10, rejected.

## The exact endgame solver (negative result)

Built a full **exact minimax to the end of the game** (alpha‑beta + flagged
transposition table + the weakly‑dominant territory reduction). Verified
correct: 185 endgame positions matched brute‑force minimax exactly. But
head‑to‑head it was a **wash** (18–21 at 800 ms, 11–13 at 4000 ms) and
triggering it *earlier* made it **worse** (7–16). Why: the endgame is exactly
where the heuristic search is already near‑optimal (small branching → it reaches
near‑terminal depth on its own), and exact minimax doesn't exploit a weaker
opponent's mistakes. **Not shipped.** (Dev code was in `/tmp`, not committed.)

## The independent‑engine experiment

A subagent built a Cathedral engine **from scratch, blind to this one**, given
only a rules‑only module (`rules.js`, the AI stripped out and verified absent)
plus baselines and a spec. Results vs this engine, equal budget:

| budget | challenger W | engine W | draws | avg unplaced (ch/eng) |
|--------|--------------|----------|-------|-----------------------|
| 300 ms | 9 | 10 | 5 | 5.4 / 4.0 |
| 1000 ms | 3 | 20 | 1 | 11.9 / 1.8 |

It reached **parity at 300 ms** but this engine **dominates once there's time to
search** (it scales with compute; the challenger's deliberately‑shallow design
doesn't). Independently, the challenger rediscovered the same key insight: rich
place‑based move ordering beats depth, and static move pre‑filtering backfires.
The challenger is preserved in `research/independent-engine/` as a **held‑out
test opponent** (useful for validating future eval work — it's not derived from
this engine).

---

## Key insights

- **Move ordering > search depth.** With ~400‑move early branching, a strong
  evaluation applied at a wide, well‑ordered *shallow* ply beats deeper search.
  Two independent designs converged on this. Corollary: the leverage is in the
  *evaluation*, not in going deeper.
- **The score‑differential is the objective.** Lower unplaced squares wins;
  average unplaced squares is the most reliable strength signal in A/B tests.
- **Defensive moves are invisible to ordering heuristics** (no claim, negative
  influence, lost space) — they must be force‑included, or the engine walks into
  enclosures.
- **Budgets change conclusions.** Gate at the real 4000 ms.
- **Architecture ceiling.** Alpha‑beta + hand‑crafted linear eval tops out
  around here; an independent rebuild matched (at low budget) rather than beat
  it. Significant further strength likely needs a *different* approach, not more
  weight tuning.

---

## Where to go next: learned evaluation

The most promising untried lever. The eval is a linear combination of cheap
features; it has **never been systematically optimized** (weights were
hand‑tuned one at a time) and is missing features that usually matter.

Concrete options, easiest → most ambitious:

1. **Systematic self‑play weight optimization.** Treat the eval weight vector as
   parameters; fitness = head‑to‑head win share vs the current champion via
   `tests/ai-match.js`. Use coordinate ascent or CMA‑ES. Infra already exists
   (deterministic `rng`, the match harness as fitness, the independent
   challenger as a held‑out opponent to avoid overfitting to self‑play).
2. **New features, then re‑optimize.** Candidates: explicit *enclosure‑threat*
   counts (squares I/opponent could enclose next move), piece **mobility**
   (legal‑move count), connectivity of own buildings, an explicit
   placement‑potential term (the challenger weighted "sum of sizes of
   still‑placeable shapes" heavily — similar to `usableSpace`/`packLoss` but
   distinct). New features are where weight‑tuning plateaus usually break.
3. **Trained evaluation.** Learn the eval from self‑play: log
   `(features → final score differential)` and fit linear/logistic weights, or
   TD(λ) updates along games, or a tiny NN. **Watch:** the eval runs at every
   leaf, so it must stay fast (a slow NN eval erases the search); validate
   against diverse opponents (the challenger, random‑opening via
   `tests/vs-weak.js`) not just self‑play; and remember depth barely helps, so
   the win must come from eval quality at shallow ply.

If the goal is "harder *for a specific human*" rather than stronger in the
abstract: collect lost games (the `m` moves list → `ENGINE.replay`), find
recurring human mistakes, and weight the eval to punish them. The
self‑play‑parity result doesn't bound how hard the engine can be made for a
given player.

### Caveats / loose ends
- The semantic **network protocol needs a live two‑device test** (headless
  lockstep passes; DOM/animation paths unverified).
- `/tmp` is ephemeral — anything not committed is lost when the container is
  reclaimed. The independent‑engine artifacts were copied into
  `research/independent-engine/`; `rules.js` there is a **frozen snapshot** of
  the engine's rules at experiment time and will drift from `site/engine.js`.

# Independent-engine experiment (frozen artifact)

A Cathedral engine built by a subagent **from scratch, blind to `site/engine.js`**,
given only the rules (`rules.js`, with all AI stripped out and verified absent),
two baselines, and `SPEC.md`. See `../../engine.md` → "The independent-engine
experiment" for context and results.

- `ai.js` — the challenger engine (global `AI.chooseMove(state, me, rng, budgetMs)`).
- `rules.js` — **frozen snapshot** of the engine's rules+notation at experiment
  time (AI removed). Will drift from `site/engine.js`; regenerate by stripping
  the section between the "computer opponent" and "move notation" markers.
- `baselines.js` — random + one-ply greedy reference opponents.
- `harness.js` — `node harness.js [random|greedy|self] [games] [budgetMs]`.
- `vs-engine.js` — challenger vs the live `site/engine.js`:
  `node research/independent-engine/vs-engine.js [games] [budgetMs]`.
- `SPEC.md` — the from-scratch task/rules given to the subagent.

Result: parity at 300 ms (9-10-5), engine dominates at 1000 ms (20-3). Useful
as a **held-out opponent** for validating future evaluation work (it is not
derived from `site/engine.js`).

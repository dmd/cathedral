'use strict';
// Engine vs a weak opponent: random legal moves for the first N plies, then
// greedy-by-ordering (no search). Measures how well the engine converts
// against bad play:  node tests/vs-weak.js <engine.js> [games] [budgetMs] [randPlies]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine(file) {
  const ctx = { module: undefined, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site', 'data.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return vm.runInContext('ENGINE', ctx);
}
function mkRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const [, , file, gamesArg, budgetArg, randArg, weakBudgetArg] = process.argv;
const E = loadEngine(file || path.join(__dirname, '..', 'site', 'engine.js'));
const GAMES = +gamesArg || 20;
const BUDGET = +budgetArg || 800;
const RAND_PLIES = +randArg || 12;
const WEAK_BUDGET = +weakBudgetArg || 1;   // 1ms = greedy; higher = real search

let win = 0, loss = 0, draw = 0, engSq = 0, weakSq = 0, worst = -1;
for (let g = 0; g < GAMES; g++) {
  const rng = mkRng(40000 + g);
  const engineColor = g % 2 === 0 ? 1 : 2;
  const weakColor = engineColor === 1 ? 2 : 1;
  const s = E.newGame((g >> 1) % 2 === 0 ? 1 : 2);
  let weakMoves = 0, moves = 0;
  while (s.phase !== 'over' && moves < 200) {
    const p = s.turn;
    if (s.phase !== 'cathedral' && !E.hasLegalMove(s, p)) { E.pass(s); continue; }
    let m;
    if (p === engineColor) {
      m = E.chooseMove(E.cloneState(s), p, rng, BUDGET);
    } else if (weakMoves < RAND_PLIES || s.phase === 'cathedral') {
      const legal = E.legalMoves(s, p);
      m = legal[Math.floor(rng() * legal.length)];
      weakMoves++;
    } else {
      // tiny budget = ordering-only choice (greedy), still no blunder-noise
      m = E.chooseMove(E.cloneState(s), p, rng, WEAK_BUDGET);
      weakMoves++;
    }
    if (!m) { E.pass(s); continue; }
    if (!E.place(s, m.id, m.rot, m.col, m.row)) { console.error('illegal'); process.exit(1); }
    moves++;
  }
  const sc = E.score(s);
  const e = sc[engineColor], wk = sc[weakColor];
  engSq += e; weakSq += wk;
  worst = Math.max(worst, e);
  if (e < wk) win++; else if (wk < e) loss++; else draw++;
  console.log(`game ${g}: engine=${e} weak=${wk} ${e < wk ? 'engine wins' : wk < e ? 'WEAK WINS' : 'draw'}`);
}
console.log(`\nengine ${path.basename(file || 'engine.js')} vs weak(rand ${RAND_PLIES} plies): ` +
            `${win}W ${loss}L ${draw}D, avg engine=${(engSq / GAMES).toFixed(1)} ` +
            `weak=${(weakSq / GAMES).toFixed(1)}, worst engine score=${worst}`);

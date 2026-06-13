'use strict';
// Diagnostic: measure which piece sizes get stranded (left in hand, not
// captured) at game end. If big pieces are disproportionately stranded, the
// engine is deferring its awkward pieces until they no longer fit.
//   node /tmp/strand.js <engine.js> [games] [budgetMs]
const fs = require('fs'), path = require('path'), vm = require('vm');
function load(file) {
  const ctx = { module: undefined, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site', 'data.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return { E: vm.runInContext('ENGINE', ctx), PIECES: vm.runInContext('PIECES', ctx), FOOT: vm.runInContext('FOOT', ctx) };
}
function mkRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

const file = process.argv[2] || path.join(__dirname, '..', 'site', 'engine.js');
const GAMES = +process.argv[3] || 30;
const BUDGET = +process.argv[4] || 800;
const { E, PIECES, FOOT } = load(file);
const sizeOf = id => FOOT[String(PIECES[id].shape)].length;
const ownerOf = id => id === 0 ? 0 : (id < 15 ? 2 : 1);

// histogram: piece size -> [count left in hand, count total existing]
const left = {}, total = {};
let games = 0, strandedBig = 0;   // games where a side stranded a 5-sq piece
for (let g = 0; g < GAMES; g++) {
  const rng = mkRng(70000 + g);
  const s = E.newGame(g % 2 === 0 ? 1 : 2);
  let moves = 0;
  while (s.phase !== 'over' && moves < 200) {
    const p = s.turn;
    if (s.phase !== 'cathedral' && !E.hasLegalMove(s, p)) { E.pass(s); continue; }
    const m = E.chooseMove(E.cloneState(s), p, rng, BUDGET);
    if (!m) { E.pass(s); continue; }
    E.place(s, m.id, m.rot, m.col, m.row); moves++;
  }
  games++;
  // count existing pieces (everything except captured-and-gone; in this
  // headless run nothing is permanently lost except a captured cathedral)
  for (const pc of PIECES) {
    if (pc.id === 0) continue;
    const sz = sizeOf(pc.id);
    total[sz] = (total[sz] || 0) + 1;
  }
  let bigThisGame = false;
  for (const id of s.hand) {
    if (id === 0) continue;
    const sz = sizeOf(id);
    left[sz] = (left[sz] || 0) + 1;
    if (sz >= 5) bigThisGame = true;
  }
  if (bigThisGame) strandedBig++;
}
console.log(`engine ${path.basename(file)}  ${games} games @ ${BUDGET}ms`);
console.log('size | left-in-hand / total existing  (stranding rate)');
for (const sz of Object.keys(total).map(Number).sort((a,b)=>a-b)) {
  const l = left[sz] || 0, t = total[sz];
  console.log(`  ${sz}  |   ${String(l).padStart(3)} / ${String(t).padStart(3)}    ${(100*l/t).toFixed(1)}%`);
}
console.log(`games where a side stranded a 5-square piece: ${strandedBig}/${games} (${(100*strandedBig/games).toFixed(0)}%)`);

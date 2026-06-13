'use strict';
// Head-to-head: the independent challenger (ai.js, using RULES) vs the
// existing engine (engine.js, ENGINE). Both share identical rules; ENGINE is
// the referee that applies moves. Colors and placer alternate for fairness.
//   node vs-engine.js [games] [budgetMs]
const fs = require('fs'), vm = require('vm');
const ctx = { module: undefined, console, Date, Math };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/data.js','utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../../site/engine.js','utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/rules.js','utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/ai.js','utf8'), ctx);
const ENGINE = vm.runInContext('ENGINE', ctx);
const AI = vm.runInContext('AI', ctx);
function mkRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
const GAMES = +process.argv[2] || 24;
const BUDGET = +process.argv[3] || 1000;
let cw=0, ew=0, draw=0, cSq=0, eSq=0, cMax=0, eMax=0;
for (let g=0; g<GAMES; g++) {
  const chColor = g%2===0 ? 1 : 2;            // challenger's color this game
  const placer = (g>>1)%2===0 ? 1 : 2;
  const s = ENGINE.newGame(placer);
  const rng = { 1: mkRng(7000+g*2), 2: mkRng(7000+g*2+1) };
  let n=0;
  while (s.phase!=='over' && n<200) {
    const p = s.turn;
    if (s.phase!=='cathedral' && !ENGINE.hasLegalMove(s,p)) { ENGINE.pass(s); continue; }
    const t0 = Date.now();
    let m;
    if (p === chColor) { m = AI.chooseMove(ENGINE.cloneState(s), p, rng[p], BUDGET); cMax = Math.max(cMax, Date.now()-t0); }
    else { m = ENGINE.chooseMove(ENGINE.cloneState(s), p, rng[p], BUDGET, 0.3); eMax = Math.max(eMax, Date.now()-t0); }
    if (!m) { ENGINE.pass(s); continue; }
    if (!ENGINE.place(s, m.id, m.rot, m.col, m.row)) { console.error('illegal move by', p===chColor?'challenger':'engine', m); process.exit(1); }
    n++;
  }
  const sc = ENGINE.score(s);
  const c = sc[chColor], e = sc[chColor===1?2:1];
  cSq+=c; eSq+=e;
  if (c<e) cw++; else if (e<c) ew++; else draw++;
  console.log(`game ${g}: challenger(${chColor===1?'blue':'orange'})=${c} engine=${e} ${c<e?'CHALLENGER':e<c?'engine':'draw'}`);
}
console.log(`\nbudget=${BUDGET}ms  challenger ${cw}W  engine ${ew}W  draws ${draw}`);
console.log(`avg unplaced: challenger=${(cSq/GAMES).toFixed(1)} engine=${(eSq/GAMES).toFixed(1)} | max move challenger=${cMax}ms engine=${eMax}ms`);

'use strict';
// Play your AI against a baseline (or itself). Colors and cathedral-placing
// duty alternate so neither side gets a systematic edge.
//   node harness.js [random|greedy|self] [games] [budgetMs]
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { module: undefined, console, Date, Math };
vm.createContext(ctx);
for (const f of ['data.js', 'rules.js', 'baselines.js', 'ai.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx);
const R = vm.runInContext('RULES', ctx);
const AI = vm.runInContext('AI', ctx);
const BASE = vm.runInContext('BASELINES', ctx);
function mkRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
const oppName = process.argv[2] || 'greedy';
const GAMES = +process.argv[3] || 20;
const BUDGET = +process.argv[4] || 300;
const opp = oppName === 'self' ? null : BASE[oppName];
if (oppName !== 'self' && !opp) { console.error('unknown opponent:', oppName); process.exit(2); }
let win=0,loss=0,draw=0,sqA=0,sqB=0,maxMs=0;
for (let g=0; g<GAMES; g++) {
  const aiColor = g%2===0 ? 1 : 2;
  const placer = (g>>1)%2===0 ? 1 : 2;
  const s = R.newGame(placer);
  const rng = {1:mkRng(1000+g*2), 2:mkRng(1000+g*2+1)};
  let n=0;
  while (s.phase!=='over' && n<200) {
    const p = s.turn;
    if (s.phase!=='cathedral' && !R.hasLegalMove(s,p)) { R.pass(s); continue; }
    const isAI = (p===aiColor) || oppName==='self';
    const t0 = Date.now();
    const m = isAI ? AI.chooseMove(R.cloneState(s), p, rng[p], BUDGET)
                   : opp(R, R.cloneState(s), p, rng[p]);
    if (p===aiColor) maxMs = Math.max(maxMs, Date.now()-t0);
    if (!m) { R.pass(s); continue; }
    if (!R.place(s, m.id, m.rot, m.col, m.row)) { console.error('illegal move', isAI?'AI':'opp', m); process.exit(1); }
    n++;
  }
  const sc = R.score(s);
  const a = sc[aiColor], b = sc[aiColor===1?2:1];
  sqA+=a; sqB+=b;
  if (a<b) win++; else if (b<a) loss++; else draw++;
}
console.log(`AI vs ${oppName}: ${win}W ${loss}L ${draw}D / ${GAMES} | avg unplaced AI=${(sqA/GAMES).toFixed(1)} opp=${(sqB/GAMES).toFixed(1)} | AI max move ${maxMs}ms`);

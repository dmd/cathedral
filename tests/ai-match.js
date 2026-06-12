'use strict';
// Head-to-head AI match between two engine builds:
//   node tests/ai-match.js <engineA.js> <engineB.js> [games] [budgetMs] [seed]
// Both engines must implement the same rules; engine A's rules functions are
// authoritative for applying moves. Colors and cathedral placer alternate so
// neither side gets a systematic first-move advantage.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine(file) {
  const ctx = { module: undefined, console };
  vm.createContext(ctx);
  const data = fs.readFileSync(path.join(__dirname, '..', 'site', 'data.js'), 'utf8');
  vm.runInContext(data, ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return vm.runInContext('ENGINE', ctx);
}

function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const [, , fileA, fileB, gamesArg, budgetArg, seedArg] = process.argv;
if (!fileA || !fileB) {
  console.error('usage: node tests/ai-match.js <engineA.js> <engineB.js> [games] [budgetMs] [seed]');
  process.exit(2);
}
const GAMES = +gamesArg || 20;
const BUDGET = +budgetArg || 300;
const SEED = +seedArg || 12345;

const A = loadEngine(fileA);
const B = loadEngine(fileB);

let winA = 0, winB = 0, draw = 0, sqA = 0, sqB = 0;

for (let g = 0; g < GAMES; g++) {
  // alternate which engine is green and who places the cathedral
  const engines = g % 2 === 0 ? { 1: A, 2: B } : { 1: B, 2: A };
  const placer = (g >> 1) % 2 === 0 ? 1 : 2;
  const s = A.newGame(placer);
  const rng = { 1: mkRng(SEED + g * 2), 2: mkRng(SEED + g * 2 + 1) };
  let moves = 0;
  while (s.phase !== 'over' && moves < 200) {
    const p = s.turn;
    // each engine passes per its own move generator (baseline misses some
    // edge placements; that is part of its real-world behavior)
    if (s.phase !== 'cathedral' && !engines[p].hasLegalMove(s, p)) {
      A.pass(s);
      continue;
    }
    const m = engines[p].chooseMove(A.cloneState(s), p, rng[p], BUDGET);
    if (!m) {
      A.pass(s);
      continue;
    }
    if (!A.place(s, m.id, m.rot, m.col, m.row)) {
      console.error(`game ${g}: engine for player ${p} produced an illegal move`, m);
      process.exit(1);
    }
    moves++;
  }
  const sc = A.score(s);
  const aColor = g % 2 === 0 ? 1 : 2;
  const a = sc[aColor], b = sc[aColor === 1 ? 2 : 1];
  sqA += a; sqB += b;
  if (a < b) winA++;
  else if (b < a) winB++;
  else draw++;
  console.log(`game ${g}: A(${aColor === 1 ? 'green' : 'red'})=${a} B=${b} ` +
              `${a < b ? 'A wins' : b < a ? 'B wins' : 'draw'} (${moves} moves)`);
}

console.log(`\nA=${path.basename(fileA)}  B=${path.basename(fileB)}  budget=${BUDGET}ms`);
console.log(`A wins ${winA}, B wins ${winB}, draws ${draw}  ` +
            `(avg unplaced squares A=${(sqA / GAMES).toFixed(1)} B=${(sqB / GAMES).toFixed(1)})`);

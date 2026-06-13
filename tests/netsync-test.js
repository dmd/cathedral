'use strict';
// Lockstep test for the semantic network protocol: two simulated clients
// each keep their own engine state and communicate ONLY by passing the
// mover's notation string to the peer, who decodes it against its own state.
// After every move the two states must be byte-identical (grid ids included,
// since capture logic distinguishes pieces). This is the headless analogue of
// two browsers playing — node tests/netsync-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { module: undefined, console };
vm.createContext(ctx);
for (const f of ['site/data.js', 'site/engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const E = vm.runInContext('ENGINE', ctx);
function mkRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

let fail = 0;
function check(name, cond){ if(!cond){ console.log(`FAIL  ${name}`); fail++; } }

function identical(a, b) {
  if (a.turn !== b.turn || a.phase !== b.phase || a.passes !== b.passes) return false;
  if (a.cathedralGone !== b.cathedralGone) return false;
  for (let k = 0; k < 100; k++) if (a.grid[k] !== b.grid[k] || a.terr[k] !== b.terr[k]) return false;
  if (a.hand.slice().sort((x,y)=>x-y).join(',') !== b.hand.slice().sort((x,y)=>x-y).join(',')) return false;
  return true;
}

let games = 0, totalMoves = 0, desyncs = 0, captures = 0;
for (let g = 0; g < 60; g++) {
  // both clients agree on placer and colors from the (canonical) names
  const placer = (g % 2) + 1;
  const A = E.newGame(placer), B = E.newGame(placer);
  // distinct rng per color so the mover's own choice is independent
  const rng = { 1: mkRng(4000 + g * 2), 2: mkRng(4000 + g * 2 + 1) };
  let n = 0, ok = true;
  while (A.phase !== 'over' && n < 200 && ok) {
    const p = A.turn;
    if (A.phase !== 'cathedral' && !E.hasLegalMove(A, p)) {
      E.pass(A); E.pass(B);                      // forced pass, derived on both
      if (!identical(A, B)) { ok = false; desyncs++; }
      continue;
    }
    // the client whose turn it is chooses from ITS OWN state
    const mv = E.chooseMove(E.cloneState(A), p, rng[p], 120);
    if (!mv) { E.pass(A); E.pass(B); continue; }
    const text = E.moveToText(mv.id, mv.rot, mv.col, mv.row);
    // mover applies locally
    const evA = E.place(A, mv.id, mv.rot, mv.col, mv.row);
    // peer decodes the notation against its own (identical) state and applies
    const ev = E.applyText(B, text);
    if (ev === null || ev.passed) { ok = false; desyncs++; console.log(`  game ${g} move ${n}: peer could not apply "${text}"`); break; }
    if (evA && evA.captured.length) captures++;
    totalMoves++;
    if (!identical(A, B)) {
      ok = false; desyncs++;
      console.log(`  game ${g} move ${n}: desync after "${text}"`);
      break;
    }
    n++;
  }
  games++;
}
check(`lockstep over ${games} games / ${totalMoves} moves, ${captures} with captures`, desyncs === 0);
console.log(desyncs === 0
  ? `\nALL NETSYNC TESTS PASSED (${totalMoves} moves, ${captures} involving captures, 0 desyncs)`
  : `\n${desyncs} DESYNCS`);
process.exit(fail ? 1 : 0);

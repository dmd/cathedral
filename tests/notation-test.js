'use strict';
// Move-notation round-trip and replay tests: node tests/notation-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { module: undefined, console };
vm.createContext(ctx);
for (const f of ['site/data.js', 'site/engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const E = vm.runInContext('ENGINE', ctx);
function mkRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

let fail = 0;
function check(name, cond){ console.log(`${cond?'PASS':'FAIL'}  ${name}`); if(!cond) fail++; }

function cellsKey(id, rot, col, row) {
  return E.cellsFor(id, rot).map(([i,j]) => `${col+i},${row+j}`).sort().join(' ');
}

// 1) Every legal move in a batch of real positions round-trips: encode to
// text, decode against the same state, and the decoded move must cover the
// exact same squares (the piece id may differ between interchangeable copies).
{
  let moves = 0, bad = 0, ambiguousRot = 0;
  for (let g = 0; g < 40 && moves < 4000; g++) {
    const rng = mkRng(900 + g);
    const s = E.newGame(g % 2 === 0 ? 1 : 2);
    let n = 0;
    while (s.phase !== 'over' && n < 200) {
      const p = s.turn;
      if (s.phase !== 'cathedral' && !E.hasLegalMove(s, p)) { E.pass(s); continue; }
      for (const mv of E.legalMoves(s, p)) {
        const txt = E.moveToText(mv.id, mv.rot, mv.col, mv.row);
        const back = E.textToMove(s, txt);
        moves++;
        if (!back || back.pass) { bad++; if (bad <= 5) console.log('  no-decode:', txt); continue; }
        if (cellsKey(back.id, back.rot, back.col, back.row) !== cellsKey(mv.id, mv.rot, mv.col, mv.row)) {
          bad++; if (bad <= 5) console.log('  cells differ:', txt, '->', JSON.stringify(back));
        }
      }
      const choice = E.chooseMove(E.cloneState(s), p, rng, 120);
      if (!choice) { E.pass(s); continue; }
      E.place(s, choice.id, choice.rot, choice.col, choice.row); n++;
    }
  }
  check(`round-trip: ${moves} legal moves encode+decode to same squares (${bad} bad)`, bad === 0 && moves > 1000);
}

// 2) A full game serialized to a record replays to an identical final state.
{
  const rng = mkRng(2024);
  const placer = 1;
  const s = E.newGame(placer);
  const record = [];
  let n = 0;
  while (s.phase !== 'over' && n < 200) {
    const p = s.turn;
    if (s.phase !== 'cathedral' && !E.hasLegalMove(s, p)) { record.push('pass'); E.pass(s); continue; }
    const mv = E.chooseMove(E.cloneState(s), p, rng, 150);
    if (!mv) { record.push('pass'); E.pass(s); continue; }
    record.push(E.moveToText(mv.id, mv.rot, mv.col, mv.row));
    E.place(s, mv.id, mv.rot, mv.col, mv.row); n++;
  }
  const s2 = E.replay(placer, record);
  const gridSame = s.grid.every((v, k) => v === s2.grid[k]);
  const terrSame = s.terr.every((v, k) => v === s2.terr[k]);
  const sc1 = E.score(s), sc2 = E.score(s2);
  check('replay: grid identical', gridSame);
  check('replay: territory identical', terrSame);
  check('replay: scores identical', sc1[1] === sc2[1] && sc1[2] === sc2[2]);
  check('replay: phase/over identical', s.phase === s2.phase);
}

// 3) Hand-written notation loads as expected (cathedral first, then a tavern).
{
  const s = E.replay(2, ['cathedral e5 r0', 'tavern a1']);
  // green tavern at a1 (col 0,row 0)
  check('hand-written: tavern landed at a1', s.grid[0] === 15 || E.pieceName(s.grid[0]) === 'tavern');
  check('hand-written: turn passed to red', s.turn === 2);
}

// 4) Illegal text is rejected, not silently misapplied.
{
  const s = E.newGame(1);
  check('reject: garbage', E.textToMove(s, 'wizard z9') === null);
  check('reject: occupied/illegal returns null on apply', E.applyText(E.replay(2, ['cathedral e5 r0']), 'cathedral e5 r0') === null);
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL NOTATION TESTS PASSED');
process.exit(fail ? 1 : 0);

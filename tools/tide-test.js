// The tide and the ghosts — the two rules that give a match its shape.
//
// Matches used to drift: once the barrels were gone the board opened up, nobody
// wanted to commit, and being popped meant watching the rest from the sidelines.
//
//   TIDE    the bay floods one ring every TIDE_STEP after TIDE_START, hull
//           inwards. Water cannot be crossed, stops a blast, and drowns whoever
//           it catches — so no match can run forever.
//   GHOSTS  a popped human comes back as a ghost. He drifts through walls and
//           water, cannot be hurt and cannot win, and every GHOST_CD he can
//           leave a bubble that TRAPS whoever it catches but never pops them.
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failed = 0;
const check = (label, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail == null ? '' : detail}`); };
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
const DT = 1 / 30;

// N humans on an open floor, nobody moving unless we say so. A match ends the
// moment one sailor is left, so a test that needs the world to keep ticking
// parks a spare somewhere safe.
function arena(humans = 2) {
  const controls = new Array(8).fill('none');
  for (let i = 0; i < humans; i++) controls[i] = 'local';
  const w = BB.makeWorld();
  w.reset(controls, ['#fff', '#0ff'], 'normal', null, 0);
  const r = w.read();
  for (let y = 1; y < BB.ROWS - 1; y++) for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR;
  r.powerups.length = 0; r.bubbles.length = 0; r.blasts.length = 0;
  const put = (p, x, y) => { p.tx = p.fx = p.tox = x; p.ty = p.fy = p.toy = y; p.moving = false; p.t = 0; };
  for (let i = 0; i < humans; i++) put(r.players[i], 3 + i * 3, BB.ROWS - 3);   // a default parking spot each
  return { w, r, put, run: secs => { for (let i = 0; i < Math.round(secs / DT); i++) w.update(DT); } };
}
const water = r => r.grid.flat().filter(v => v === BB.WATER).length;

console.log('\n1. The sea takes a scatter of tiles, on a clock, and takes more each time\n');
{
  const { w, r, put, run } = arena(3);              // three, so one unlucky drowning cannot end the clock
  put(r.players[0], BB.MIDX, BB.MIDY); put(r.players[1], BB.MIDX + 2, BB.MIDY); put(r.players[2], BB.MIDX - 2, BB.MIDY);
  run(BB.TIDE_START - BB.TIDE_WARN - 1);
  eq('nothing before the tide is due', water(r), 0);
  check('the countdown is in the snapshot', w.snapshot().tt > 0, `${w.snapshot().tt}ms to go`);
  run(1.5);
  const marked = w.snapshot().tw.slice();
  check('tiles are marked before the wave lands', marked.length === BB.TIDE_BASE, `${marked.length} marked`);
  check('and they are scattered, not one edge', new Set(marked.map(t => t % BB.COLS)).size > 1 && new Set(marked.map(t => Math.floor(t / BB.COLS))).size > 1,
    marked.map(t => (t % BB.COLS) + ',' + Math.floor(t / BB.COLS)).join(' '));
  run(BB.TIDE_WARN + 0.2);
  check('the wave takes exactly the tiles it marked', marked.every(t => r.grid[Math.floor(t / BB.COLS)][t % BB.COLS] === BB.WATER) && water(r) === marked.length,
    `${water(r)} under, ${marked.length} marked`);
  eq('the board is not eaten from the outside in', r.grid[1].every(v => v === BB.WATER), false);
  const first = water(r);
  run(BB.TIDE_STEP + 0.4);
  check('the next wave takes more than the first', water(r) - first > first, `wave 1 took ${first}, wave 2 took ${water(r) - first}`);
}

console.log('\n2. Nothing ever goes under unannounced\n');
{
  const { w, r, put, run } = arena(4);
  [0, 1, 2, 3].forEach(i => put(r.players[i], BB.MIDX - 3 + i * 2, BB.MIDY));
  run(BB.TIDE_START - BB.TIDE_WARN - 1);
  let surprises = 0, waves = 0, wasWater = new Set(), wasMarked = new Set();
  for (let i = 0; i < Math.round(BB.TIDE_STEP * 4 / DT); i++) {
    const before = new Set(wasWater), marks = new Set(wasMarked);
    w.update(DT);
    const now = new Set(); r.grid.forEach((row, y) => row.forEach((v, x) => { if (v === BB.WATER) now.add(y * BB.COLS + x); }));
    for (const t of now) if (!before.has(t) && !marks.has(t)) surprises++;
    if (now.size > before.size) waves++;
    wasWater = now; wasMarked = new Set(w.snapshot().tw);
  }
  check('every tile that went under was marked first', surprises === 0, `${surprises} surprises over ${waves} waves`);
  check('and several waves landed', waves >= 3, `${waves} waves`);
}

console.log('\n2b. Water is not a place you can be\n');
{
  const { w, r, put, run } = arena(2);
  const p = r.players[0];
  put(p, 5, 5); put(r.players[1], BB.MIDX, BB.MIDY);
  r.grid[5][6] = BB.WATER;                          // the sea took the tile next to him
  p.inHeld = ['right']; p.inSeq = 1;
  run(1.5);
  eq('you cannot walk into it', [p.tx, p.ty], [5, 5]);
  p.inHeld = []; p.inSeq = 2;
  r.bubbles.push({ x: 5, y: 5, fuse: 0.02, range: 6, owner: p });
  w.update(DT);
  check('a blast stops at the waterline', !r.blasts.some(bl => bl.x > 6 && bl.y === 5), `${r.blasts.filter(bl => bl.y === 5).map(bl => bl.x).join(',')}`);
  const { w: w2, r: r2, put: put2, run: run2 } = arena(2);
  const q = r2.players[0];
  put2(q, 5, 5); put2(r2.players[1], BB.MIDX, BB.MIDY);
  r2.grid[5][5] = BB.WATER;                         // it took the tile under him
  run2(0.2);
  check('standing in it drowns you', !q.alive && q.ghost === true, `alive=${q.alive}`);
}

console.log('\n2c. The bots hop clear of what is marked\n');
{
  let survived = 0, trials = 6;
  for (let t = 0; t < trials; t++) {
    const { w, r, put, run } = arena(2);
    const bot = r.players[1];
    bot.control = 'ai'; bot.isHuman = false; bot.botDiff = { move: 0.2, trap: 0, react: 0, esc: 0 }; bot.think = 0;
    put(r.players[0], BB.MIDX, BB.MIDY); put(bot, 5, 5);
    run(BB.TIDE_START - BB.TIDE_WARN + 0.2);         // the wave is marked now
    const marks = w.snapshot().tw;
    if (!marks.length) continue;
    const t0 = marks[0], x = t0 % BB.COLS, y = Math.floor(t0 / BB.COLS);
    put(bot, x, y); bot.target = null;               // park it on a marked tile
    run(BB.TIDE_WARN + 1.0);
    if (bot.alive) survived++;
  }
  check('a bot parked on a marked tile gets off it', survived === trials, `${survived} of ${trials} survived`);
}

console.log('\n3. No match runs forever\n');
{
  const { w, r, put, run } = arena(2);
  put(r.players[0], 3, 3); put(r.players[1], BB.COLS - 4, BB.ROWS - 4);   // opposite corners, no bots
  let t = 0;
  while (w.gameState === 'playing' && t < 400) { w.update(DT); t += DT; }
  check('two players who never fight are still finished by the sea', w.gameState === 'over', `over at ${Math.round(t)}s`);
  check('and it takes minutes, not seconds', t > BB.TIDE_START, `${Math.round(t)}s`);
}

console.log('\n4. Popped is not out: you come back as a ghost\n');
{
  const { w, r, put, run } = arena(3);
  const me = r.players[0], foe = r.players[1];
  put(me, 5, 5); put(foe, 9, 9); put(r.players[2], 3, BB.ROWS - 3);
  r.bubbles.push({ x: 5, y: 5, fuse: 0.02, range: 2, owner: foe });
  run(BB.TRAP_TIME + 1.2);                          // trapped, then the timer runs out
  check('a popped human turns into a ghost', me.ghost === true && me.alive === false, `ghost=${me.ghost} alive=${me.alive}`);
  check('he starts on cooldown, so no instant revenge', me.ghostCd > 0, `${me.ghostCd.toFixed(1)}s`);
  check('a ghost is not counted among the living', w.snapshot().players.filter(p => p.alive).every(p => p.slot !== me.slot),
    `${w.snapshot().players.filter(p => p.alive).length} still in it`);
  me.inHeld = ['up']; me.inSeq = 5;
  r.grid[4][5] = BB.WALL;                           // a wall in his way
  run(1.0);
  check('he drifts straight through a wall', me.ty < 5, `now at ${me.tx},${me.ty}`);
  run(BB.GHOST_CD);
  me.inHeld = []; me.inBomb = true;
  const before = r.bubbles.length;
  w.update(DT);
  const gb = r.bubbles[r.bubbles.length - 1];
  check('once the cooldown is up he can leave a ghost bubble', r.bubbles.length === before + 1 && gb.soft === true, `${r.bubbles.length} bubbles`);
  me.inBomb = true; w.update(DT);
  eq('and only one at a time', r.bubbles.filter(b => b.soft).length, 1);
}

console.log('\n5. A ghost bubble traps. It never pops anyone\n');
{
  const { w, r, put, run } = arena(3);
  const gh = r.players[0], living = r.players[1];
  put(gh, 5, 5); put(living, 5, 5); put(r.players[2], 3, BB.ROWS - 3);
  gh.alive = false; gh.ghost = true; gh.ghostCd = 0;
  gh.inBomb = true; w.update(DT);
  run(BB.FUSE + 0.2);
  check('it traps whoever it catches', living.trapped === true && living.alive === true, `trapped=${living.trapped} alive=${living.alive}`);
  // a second splash lands on him while he is already bubbled
  r.blasts.push({ x: 5, y: 5, timer: BB.BLAST_TIME, id: 901, owner: gh, soft: true });
  w.update(DT);
  check('a second splash cannot finish a trapped sailor off', living.alive === true, `alive=${living.alive}`);
  check('nor does it free him', living.trapped === true);
  run(BB.BLAST_TIME + 0.1);                       // let the splash dry off — a live blast re-traps on contact
  living.struggle = BB.ESCAPE_NEED; run(0.1);
  check('he still wiggles out on his own', !living.trapped && living.alive, `trapped=${living.trapped} alive=${living.alive}`);
  // the same shot from a living rival, which is the whole difference
  r.blasts.push({ x: living.tx, y: living.ty, timer: BB.BLAST_TIME, id: 902, owner: r.players[2], soft: false });
  w.update(DT);
  check('a real blast still traps him', living.trapped === true);
  r.blasts.push({ x: living.tx, y: living.ty, timer: BB.BLAST_TIME, id: 903, owner: r.players[2], soft: false });
  w.update(DT);
  check('and a real one finishes the job', !living.alive, `alive=${living.alive}`);
}

console.log('\n6. A ghost is out of the running, and out of harm\n');
{
  const { w, r, put, run } = arena(3);
  const gh = r.players[0], foe = r.players[1];
  put(gh, 5, 5); put(foe, 9, 9); put(r.players[2], 3, 3);
  gh.alive = false; gh.ghost = true;
  r.bubbles.push({ x: 5, y: 5, fuse: 0.02, range: 3, owner: foe });
  run(1.0);
  check('a blast passes right through him', gh.ghost === true && !gh.trapped, `trapped=${gh.trapped}`);
  let t = 0;
  while (w.gameState === 'playing' && t < 300) { w.update(DT); t += DT; }
  check('and so does the tide', gh.ghost === true, 'still haunting');
  check('the match ends on the last sailor standing, ghosts aside', w.gameState === 'over', `over at ${Math.round(t)}s`);
}

console.log('\n7. A ghost breaks nothing and hands out nothing\n');
{
  const { w, r, put, run } = arena(3);
  const gh = r.players[0];
  put(gh, 5, 5); put(r.players[1], 3, 3); put(r.players[2], 3, BB.ROWS - 3);
  gh.alive = false; gh.ghost = true; gh.ghostCd = 0;
  r.grid[5][6] = BB.BARREL;
  gh.inBomb = true; w.update(DT);
  run(BB.FUSE + BB.BLAST_TIME + 0.2);
  eq('the barrel is still standing', r.grid[5][6], BB.BARREL);
  eq('and no pickup fell out of it', r.powerups.length, 0);
}

console.log('\n8. Bots die like bots\n');
{
  const { w, r, put, run } = arena(2);
  const bot = r.players[1];
  bot.control = 'ai'; bot.isHuman = false; bot.alive = true; bot.botDiff = { move: 0.2, trap: 0, react: 0, esc: 0 };
  put(bot, 9, 9);
  r.bubbles.push({ x: 9, y: 9, fuse: 0.02, range: 2, owner: r.players[0] });
  run(BB.TRAP_TIME + 1.5);
  check('a popped bot stays popped', !bot.alive && !bot.ghost, `alive=${bot.alive} ghost=${bot.ghost}`);
}

console.log('\n9. The page shows it\n');
{
  check('water tiles are drawn', /function drawWater\(/.test(HTML) && /grid\[y\]\[x\]===WATER/.test(HTML));
  check('the tide clock and warning are on screen', /id="hudTide"/.test(HTML) && /id="tideWarn"/.test(HTML));
  check('both setup panels let you pick when it comes', (HTML.match(/class="seg tiderow"/g) || []).length === 2 && /TIDE_CHOICES/.test(HTML));
  check('ghosts are drawn see-through, under the living', /if\(!p\.ghost\) continue;/.test(HTML) && /globalAlpha/.test(HTML));
  check('the DROP button becomes a haunt button', /classList\.toggle\('splash'/.test(HTML) && /HAUNT/.test(HTML));
  check('the result waits for the match, not for your own pop', !/!me\.alive && !deadShown/.test(HTML));
}

console.log(failed ? `\n${failed} FAILED` : '\nall cases pass');
process.exit(failed ? 1 : 0);

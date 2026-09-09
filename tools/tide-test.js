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

console.log('\n1. The sea sweeps through the bay, and is gone again\n');
{
  const { w, r, put, run } = arena(3);
  const open = () => { for (let y = 1; y < BB.ROWS - 1; y++) for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR; };
  open();
  [0, 1, 2].forEach(i => put(r.players[i], 3 + i * 2, 3));
  run(BB.TIDE_START - BB.TIDE_WARN - 1);
  eq('no water before the tide is due', water(r), 0);
  check('the countdown is in the snapshot', w.snapshot().tt > 0, `${w.snapshot().tt}ms to go`);
  run(1.5);
  const entry = w.snapshot().tw.slice();
  const rows = new Set(entry.map(t => Math.floor(t / BB.COLS))), cols = new Set(entry.map(t => t % BB.COLS));
  const horiz = cols.size === 1;                       // one column of tiles = a wall moving sideways
  check('the line it enters on is marked first', entry.length > 0 && (cols.size === 1 || rows.size === 1),
    `${entry.length} tiles on one ${horiz ? 'column' : 'row'}`);
  const span = horiz ? BB.ROWS : BB.COLS, used = horiz ? rows : cols;
  const lanes = []; for (let i = 1; i < span - 1; i++) if (!used.has(i)) lanes.push(i);
  check('with channels straight through it', lanes.length >= 1 && lanes.length <= BB.SURGE_LANES, `${lanes.length} channels: ${lanes.join(',')}`);
  // stand two sailors in a channel and one in the wall's path
  if (horiz) { put(r.players[0], 3, lanes[0]); put(r.players[1], 12, lanes[0]); put(r.players[2], 8, used.values().next().value); }
  else { put(r.players[0], lanes[0], 3); put(r.players[1], lanes[0], 12); put(r.players[2], used.values().next().value, 8); }
  run(BB.TIDE_WARN + 0.3);
  check('then the wall is really there', water(r) > 0, `${water(r)} tiles under water`);
  // follow it across, checking the channels never move
  let laneStayedDry = true, sawWater = 0;
  for (let i = 0; i < Math.round(12 / DT) && w.snapshot().tr === 0; i++) {
    w.update(DT);
    if (water(r) > 0) { sawWater++;
      for (const ln of lanes) for (let j = 1; j < (horiz ? BB.COLS : BB.ROWS) - 1; j++) {
        const x = horiz ? j : ln, y = horiz ? ln : j;
        if (r.grid[y][x] === BB.WATER) laneStayedDry = false;
      } }
  }
  check('the channels stay open the whole way across', laneStayedDry, `${sawWater} frames of water`);
  check('a sailor standing in the wall is taken', !r.players[2].alive, `alive=${r.players[2].alive}`);
  check('a sailor in a channel is not', r.players[0].alive && r.players[1].alive);
  check('and once it is through, the deck is dry again', water(r) === 0 && w.snapshot().tr === 1, `${water(r)} tiles left under, ${w.snapshot().tr} surges`);
}

console.log('\n2. It puts back everything it washed over\n');
{
  const { w, r, put, run } = arena(3);
  [0, 1, 2].forEach(i => put(r.players[i], 3 + i * 2, BB.ROWS - 3));
  for (let y = 2; y < BB.ROWS - 2; y += 2) for (let x = 2; x < BB.COLS - 2; x += 2)   // give the wall something to wash over
    r.grid[y][x] = (x + y) % 4 ? BB.BARREL : BB.CRATE;
  const before = r.grid.map(row => row.slice());
  run(BB.TIDE_START - BB.TIDE_WARN + 0.3);
  {                                                  // stand them all in a channel, so the match outlives the surge
    const entry = w.snapshot().tw, cols = new Set(entry.map(t => t % BB.COLS)), rows = new Set(entry.map(t => Math.floor(t / BB.COLS)));
    const horiz = cols.size === 1, span = horiz ? BB.ROWS : BB.COLS, used = horiz ? rows : cols;
    let lane = 1; for (let i = 1; i < span - 1; i++) if (!used.has(i)) { lane = i; break; }
    [0, 1, 2].forEach(i => horiz ? put(r.players[i], 3 + i * 4, lane) : put(r.players[i], lane, 3 + i * 4));
  }
  let surprises = 0;
  let wasWater = new Set(), wasMarked = new Set();
  for (let i = 0; i < Math.round(20 / DT) && w.snapshot().tr < 1; i++) {
    const marks = new Set(wasMarked), had = new Set(wasWater);
    w.update(DT);
    const now = new Set(); r.grid.forEach((row, y) => row.forEach((v, x) => { if (v === BB.WATER) now.add(y * BB.COLS + x); }));
    for (const t of now) if (!had.has(t) && !marks.has(t)) surprises++;
    wasWater = now; wasMarked = new Set(w.snapshot().tw);
  }
  check('no tile is ever wet without being marked first', surprises === 0, `${surprises} surprises`);
  const diff = [];
  r.grid.forEach((row, y) => row.forEach((v, x) => { if (v !== before[y][x]) diff.push(`${x},${y}`); }));
  check('the board is exactly as it was before the wall crossed it', diff.length === 0, diff.length ? diff.slice(0, 5).join(' ') : 'unchanged');
  check('barrels and crates included', r.grid.flat().filter(v => v === BB.BARREL || v === BB.CRATE).length === before.flat().filter(v => v === BB.BARREL || v === BB.CRATE).length,
    `${r.grid.flat().filter(v => v === BB.BARREL || v === BB.CRATE).length} still standing`);
  eq('and no water is left behind', water(r), 0);
}

console.log('\n2b. Touch it and you drown\n');
{
  const { w, r, put, run } = arena(2);
  const p = r.players[0];
  put(p, 5, 5); put(r.players[1], BB.MIDX, BB.MIDY);
  r.grid[5][6] = BB.WATER;
  p.inHeld = ['right']; p.inSeq = 1;
  run(1.5);
  eq('you cannot walk into it', [p.tx, p.ty], [5, 5]);
  p.inHeld = []; p.inSeq = 2;
  r.bubbles.push({ x: 5, y: 5, fuse: 0.02, range: 6, owner: p });
  w.update(DT);
  check('a blast stops at the wall of water', !r.blasts.some(bl => bl.x > 6 && bl.y === 5), r.blasts.filter(bl => bl.y === 5).map(bl => bl.x).join(','));
  const { w: w2, r: r2, put: put2, run: run2 } = arena(2);
  const q = r2.players[0];
  put2(q, 5, 5); put2(r2.players[1], BB.MIDX, BB.MIDY);
  r2.grid[5][5] = BB.WATER;
  run2(0.2);
  check('caught by it, you drown', !q.alive && q.ghost === true, `alive=${q.alive}`);
}

console.log('\n2c. The bots run for the channels too\n');
{
  let survived = 0, trials = 6;
  for (let t = 0; t < trials; t++) {
    const { w, r, put, run } = arena(2);
    for (let y = 1; y < BB.ROWS - 1; y++) for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR;
    const bot = r.players[1];
    bot.control = 'ai'; bot.isHuman = false; bot.botDiff = { move: 0.2, trap: 0, react: 0, esc: 0 }; bot.think = 0;
    put(r.players[0], BB.MIDX, BB.MIDY); put(bot, 5, 5);
    run(BB.TIDE_START - BB.TIDE_WARN + 0.3);
    const marks = w.snapshot().tw;
    if (!marks.length) continue;
    const t0 = marks[Math.floor(marks.length / 2)], x = t0 % BB.COLS, y = Math.floor(t0 / BB.COLS);
    put(bot, x, y); bot.target = null;                 // park it right in the wall's path
    run(BB.TIDE_WARN + 1.2);
    if (bot.alive) survived++;
  }
  check('a bot parked in the path gets out of the way', survived === trials, `${survived} of ${trials} survived`);
}

console.log('\n2d. When it comes, and how often, are rules you pick before the match\n');
{
  check('the start screen offers a few starts, one of them off', Array.isArray(BB.TIDE_CHOICES) && BB.TIDE_CHOICES.includes(0) && BB.TIDE_CHOICES.includes(BB.TIDE_START), JSON.stringify(BB.TIDE_CHOICES));
  check('and a few gaps between walls', Array.isArray(BB.TIDE_GAPS) && BB.TIDE_GAPS.includes(BB.TIDE_STEP) && BB.TIDE_GAPS.length > 1, JSON.stringify(BB.TIDE_GAPS));
  const early = BB.TIDE_CHOICES.find(v => v > 0 && v < BB.TIDE_START) || 25;
  const open = w => { const r = w.read(); for (let y = 1; y < BB.ROWS - 1; y++) for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR; return r; };
  const world = (opts) => { const w = BB.makeWorld(); w.reset(new Array(8).fill('none').map((c, i) => i < 3 ? 'local' : c), ['#fff'], 'normal', null, 0, opts); return w; };

  const w = world({ tide: early });
  const r = open(w);
  const run = secs => { for (let i = 0; i < Math.round(secs / DT); i++) w.update(DT); };
  run(early - 2);
  eq(`nothing yet at ${early - 2}s`, water(r), 0);
  run(2.4);
  check(`the first wall comes on the ${early}s setting, not the default`, water(r) > 0, `${water(r)} tiles under water`);

  const off = world({ tide: 0 });
  const ro = off.read();
  for (let i = 0; i < Math.round((BB.TIDE_START + 30) / DT); i++) off.update(DT);
  eq('Off means the sea never comes in', water(ro), 0);
  eq('with no countdown to show', off.snapshot().tt, -1);

  // the calm between walls, measured from the end of one to the end of the next
  const gap = BB.TIDE_GAPS.find(g => g !== BB.TIDE_STEP);
  const g = world({ tide: early, gap });
  const rg = open(g);
  // sailors who actually play the game: when the line they are on is marked,
  // they hop into a channel. That keeps the match alive so the clock can be read.
  const dodge = () => {
    const marks = g.snapshot().tw;
    if (!marks.length) return;
    const cols = new Set(marks.map(t => t % BB.COLS)), rows = new Set(marks.map(t => Math.floor(t / BB.COLS)));
    const horiz = cols.size === 1, span = horiz ? BB.ROWS : BB.COLS, used = horiz ? rows : cols;
    const lanes = []; for (let i = 1; i < span - 1; i++) if (!used.has(i)) lanes.push(i);
    if (!lanes.length) return;
    const set = new Set(marks);
    for (const p of rg.players) {
      if (!p.alive || p.control !== 'local') continue;
      if (!set.has(p.ty * BB.COLS + p.tx) && rg.grid[p.ty][p.tx] !== BB.WATER) continue;
      const lane = lanes[0];
      if (horiz) { p.ty = p.fy = p.toy = lane; } else { p.tx = p.fx = p.tox = lane; }
      p.moving = false; p.t = 0;
    }
  };
  const ends = [];
  let seen = 0;
  for (let i = 0; i < Math.round((early + gap * 4 + 40) / DT) && ends.length < 2; i++) {
    dodge();
    g.update(DT);
    if (g.snapshot().tr > seen) { seen = g.snapshot().tr; ends.push(i * DT); }
  }
  check('sailors who hop into the channels come through it', rg.players.filter(p => p.control === 'local' && p.alive).length >= 2,
    `${rg.players.filter(p => p.control === 'local' && p.alive).length} of 3 still sailing`);
  const between = ends.length > 1 ? ends[1] - ends[0] : -1;
  const crossing = BB.COLS * BB.SURGE_STEP;                       // the widest a wall can take to cross
  check(`on the ${gap}s setting the walls come ${gap}s apart`, between > gap && between < gap + crossing + 1,
    `${between.toFixed(1)}s between them (gap ${gap}s plus one crossing)`);
}

console.log('\n3. No match runs forever\n');
{
  const { w, r, put, run } = arena(2);
  put(r.players[0], 3, 3); put(r.players[1], BB.COLS - 4, BB.ROWS - 4);   // opposite corners, no bots
  let t = 0;
  while (w.gameState === 'playing' && t < 600) { w.update(DT); t += DT; }
  check('two players who never fight are caught by a surge in the end', w.gameState === 'over', `over at ${Math.round(t)}s`);
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
  check('and how often it comes', (HTML.match(/class="seg gaprow"/g) || []).length === 2 && /TIDE_GAPS/.test(HTML));
  check('ghosts are drawn see-through, under the living', /if\(!p\.ghost\) continue;/.test(HTML) && /globalAlpha/.test(HTML));
  check('the DROP button becomes a haunt button', /classList\.toggle\('splash'/.test(HTML) && /HAUNT/.test(HTML));
  check('the result waits for the match, not for your own pop', !/!me\.alive && !deadShown/.test(HTML));
}

console.log(failed ? `\n${failed} FAILED` : '\nall cases pass');
process.exit(failed ? 1 : 0);

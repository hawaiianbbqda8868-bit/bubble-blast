// Rides, surprise boxes and pushable crates, against the real sim.
//
// Everything here runs game-core.js directly, which is what both modes run:
// the relay ticks it for online play and index.html ticks a local copy for
// single-player. One suite therefore covers both.
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));

const FRAME = 1 / 60;
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
};
const near = (label, got, want, tol = 0.0005) =>
  check(label, Math.abs(got - want) <= tol, `${got.toFixed(4)} (want ${want.toFixed(4)})`);
const eq = (label, got, want) =>                 // deep, so [10,8] matches [10,8]
  check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);

// An empty floor with our sailor in the middle. Slot 1 is a second human who
// never presses anything — without him the match would end on the first tick
// for lack of opponents, and the sim would stop.
// opts.tide defaults to false: most of these cases are about one item, and a
// flooding board is a second rule. The water ones ask for it.
function arena(slot1 = 'local', opts = { tide:false }) {
  const w = BB.makeWorld();
  w.reset(['local', slot1, 'none', 'none', 'none', 'none', 'none', 'none'], ['#fff', '#0ff'], 'normal', null, 0, opts);
  const r = w.read();
  for (let y = 1; y < BB.ROWS - 1; y++)
    for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR;
  r.powerups.length = 0; r.bubbles.length = 0; r.blasts.length = 0;
  const p = r.players[0];
  p.tx = p.fx = p.tox = BB.MIDX; p.ty = p.fy = p.toy = BB.MIDY; p.moving = false; p.t = 0;
  return { w, r, p };
}
// One press, one tile — the same thing a tap does through the input layer.
function stepOnce(w, p, dir) {
  p.inSeq++; p.inHeld = [dir];
  for (let i = 0; i < 30 && !p.moving; i++) w.update(FRAME);
  p.inHeld = [];
  for (let i = 0; i < 400 && p.moving; i++) w.update(FRAME);
}
const tileTime = (w, slot = 0) => w.snapshot().players[slot].md;

console.log('1. A ride changes how long a tile takes\n');
{
  const rows = [
    ['on foot, speed 0', null, 0, 0.200],
    ['on foot, speed 5', null, 5, 0.138],
    ['car, speed 0', 'car', 0, 0.140],
    ['car, speed 5', 'car', 5, 0.120],   // floored, so a maxed skater stays steerable
    ['boat, speed 0', 'boat', 0, 0.230],
    ['plane, speed 0', 'plane', 0, 0.144],
    ['turtle, speed 0', 'turtle', 0, 0.380],
    ['turtle, speed 5', 'turtle', 5, 0.2622],
  ];
  for (const [label, ride, speed, want] of rows) {
    const { w, p } = arena();
    p.ride = ride; p.speed = speed;
    near(label, tileTime(w), want);
  }
  const { w, p } = arena();
  p.ride = 'car';
  check('the car is faster than the turtle', tileTime(w) < (p.ride = 'turtle', tileTime(w)), 'car < turtle');
}

console.log('\n2. Mounting\n');
{
  const { w, r, p } = arena();
  r.powerups.push({ x: p.tx + 1, y: p.ty, type: BB.PU_CAR });
  stepOnce(w, p, 'right');
  eq('walking onto a car mounts it', p.ride, 'car');
  eq('the car leaves the floor', r.powerups.length, 0);
  const q = r.players[1];
  q.tx = q.fx = q.tox = p.tx - 1; q.ty = q.fy = q.toy = p.ty; q.moving = false;
  stepOnce(w, q, 'right');                       // onto the tile the car was on
  eq('a second sailor finds nothing there', q.ride, null);
}
{
  const { w, r, p } = arena();
  r.powerups.push({ x: p.tx + 1, y: p.ty, type: BB.PU_TURTLE });
  stepOnce(w, p, 'right');
  eq('walking onto a turtle mounts it', p.ride, 'turtle');
  check('and it slows you down', tileTime(w) > 0.2, `${tileTime(w).toFixed(3)}s per tile`);
}

console.log('\n3. A bubble takes the ride away\n');
{
  const { w, r, p } = arena();
  p.ride = 'car';
  r.bubbles.push({ x: p.tx, y: p.ty, fuse: 0.01, range: 1, owner: r.players[1] });
  for (let i = 0; i < 60 && !p.trapped; i++) w.update(FRAME);
  eq('trapped', p.trapped, true);
  eq('the car is gone', p.ride, null);
  p.struggle = BB.ESCAPE_NEED;                   // wiggle out
  for (let i = 0; i < 60 && p.trapped; i++) w.update(FRAME);
  eq('and getting free does not give it back', p.ride, null);
}

console.log('\n4. The surprise box rolls inside its pool\n');
{
  const { w, r, p } = arena();
  const pool = ['range', 'bubble', 'skate', 'car', 'turtle', 'boat', 'plane', 'dud'];
  const seen = {};
  for (let i = 0; i < 600; i++) {
    p.range = 1; p.maxBubbles = 1; p.speed = 0; p.ride = null;
    r.powerups.length = 0;
    r.powerups.push({ x: p.tx + 1, y: p.ty, type: BB.PU_SURPRISE });
    stepOnce(w, p, 'right');
    let got = 'dud';
    if (p.range > 1) got = 'range';
    else if (p.maxBubbles > 1) got = 'bubble';
    else if (p.speed > 0) got = 'skate';
    else if (p.ride) got = p.ride;
    seen[got] = (seen[got] || 0) + 1;
    stepOnce(w, p, 'left');
  }
  const outside = Object.keys(seen).filter(k => !pool.includes(k));
  eq('nothing outside the pool', outside, []);
  for (const k of pool) check(`  rolls a ${k}`, (seen[k] || 0) > 0, `${seen[k] || 0} of 600`);
  eq('the box leaves the floor either way', r.powerups.length, 0);
}

console.log('\n4b. The boat floats, the plane flies\n');
{
  const { w, r, p } = arena('local', { tide:120 });     // the sea is in play, so water can take you
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.WATER;
  stepOnce(w, p, 'right');
  eq('on foot, water is a wall', [p.tx, p.ty], [x, y]);
  p.ride = 'boat';
  stepOnce(w, p, 'right');
  eq('in a boat you sail onto it', [p.tx, p.ty], [x + 1, y]);
  for (let i = 0; i < 60; i++) w.update(1 / 30);
  check('and the tide does not take you', p.alive === true && p.ride === 'boat', `alive=${p.alive}`);
  p.ride = 'plane';
  for (let i = 0; i < 60; i++) w.update(1 / 30);
  check('a plane rides it out just the same', p.alive === true && p.ride === 'plane', `alive=${p.alive}`);
  p.ride = null;
  for (let i = 0; i < 6; i++) w.update(1 / 30);
  check('step off the ride over water and you go under', !p.alive, `alive=${p.alive}`);
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.BARREL;
  p.ride = 'boat';
  stepOnce(w, p, 'right');
  eq('a boat is no good against a barrel', [p.tx, p.ty], [x, y]);
  p.ride = 'plane';
  stepOnce(w, p, 'right');
  eq('a plane goes straight over it', [p.tx, p.ty], [x + 1, y]);
  eq('and the barrel is untouched', r.grid[y][x + 1], BB.BARREL);
}
{
  // set down when the ride is lost over a block, rather than left inside it
  const { w, r, p } = arena('local'); const foe = r.players[1];
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.BARREL;
  p.ride = 'plane';
  stepOnce(w, p, 'right');
  eq('flying over the barrel', [p.tx, p.ty], [x + 1, y]);
  r.bubbles.push({ x: x + 1, y, fuse: 0.02, range: 1, owner: foe });
  for (let i = 0; i < 20; i++) w.update(1 / 30);
  check('bubbled up there, he is set down on clear floor', p.ride === null && r.grid[p.ty][p.tx] === BB.FLOOR,
    `at ${p.tx},${p.ty} which is ${r.grid[p.ty][p.tx]}`);
}
{
  const { w, r, p } = arena('local', { tide:120 }); const foe = r.players[1];
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.WATER;
  p.ride = 'boat';
  stepOnce(w, p, 'right');
  r.bubbles.push({ x: x + 1, y, fuse: 0.02, range: 1, owner: foe });
  for (let i = 0; i < 20; i++) w.update(1 / 30);
  check('lose the boat at sea and you go under with it', !p.alive, `alive=${p.alive} ride=${p.ride}`);
}

console.log('\n5. Rides and skates are a treat, not the norm\n');
{
  const share = (pool, want) => { const total = pool.reduce((a, [, w]) => a + w, 0);
    return pool.filter(([v]) => want.includes(v)).reduce((a, [, w]) => a + w, 0) / total; };
  const rides = [BB.PU_CAR, BB.PU_TURTLE, BB.PU_BOAT, BB.PU_PLANE], skate = [BB.PU_SPEED];
  const boxShare = share(BB.DROP_POOL, [BB.PU_SURPRISE]);
  // what a burst barrel actually hands you, box rolls included
  const eff = want => share(BB.DROP_POOL, want) + boxShare * share(BB.SURPRISE_POOL, want);
  const power = eff([BB.PU_RANGE, BB.PU_BUBBLE]);
  check('a ride is at most 1 drop in 6', eff(rides) <= 1 / 6, `${(eff(rides) * 100).toFixed(1)}% of drops`);
  check('skates are at most 1 drop in 6', eff(skate) <= 1 / 6, `${(eff(skate) * 100).toFixed(1)}% of drops`);
  check('water and bubbles outnumber rides and skates 2:1', power >= 2 * (eff(rides) + eff(skate)), `${(power * 100).toFixed(1)}% vs ${((eff(rides) + eff(skate)) * 100).toFixed(1)}%`);
}

console.log('\n6. Pushing a crate\n');
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.CRATE;
  stepOnce(w, p, 'right');
  eq('the crate slides one tile', r.grid[y][x + 2], BB.CRATE);
  eq('its old tile is clear', r.grid[y][x + 1], BB.FLOOR);
  eq('and the pusher takes its place', [p.tx, p.ty], [x + 1, y]);
}
{
  const blockers = [
    ['a wall', (r, x, y) => { r.grid[y][x + 2] = BB.WALL; }],
    ['another crate', (r, x, y) => { r.grid[y][x + 2] = BB.CRATE; }],
    ['a barrel', (r, x, y) => { r.grid[y][x + 2] = BB.BARREL; }],
    ['a bubble', (r, x, y) => { r.bubbles.push({ x: x + 2, y, fuse: 9, range: 1, owner: r.players[1] }); }],
    ['a sailor', (r, x, y) => { const q = r.players[1]; q.tx = q.fx = q.tox = x + 2; q.ty = q.fy = q.toy = y; }],
  ];
  for (const [what, place] of blockers) {
    const { w, r, p } = arena();
    const x = p.tx, y = p.ty;
    r.grid[y][x + 1] = BB.CRATE;
    place(r, x, y);
    stepOnce(w, p, 'right');
    check(`${what} beyond it stops the push`.padEnd(30),
      r.grid[y][x + 1] === BB.CRATE && p.tx === x && p.ty === y,
      `crate ${r.grid[y][x + 1] === BB.CRATE ? 'held' : 'MOVED'}, sailor at ${p.tx},${p.ty}`);
  }
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.CRATE;
  stepOnce(w, p, 'right');                                  // crate now at x+2
  r.bubbles.push({ x: x + 1, y, fuse: 0.01, range: 4, owner: r.players[1] });
  for (let i = 0; i < 30 && !r.blasts.length; i++) w.update(FRAME);
  const reached = tx => r.blasts.some(b => b.x === tx && b.y === y);
  check('a pushed crate still stops a blast', reached(x + 2) && !reached(x + 3),
    `water on the crate: ${reached(x + 2)}, past it: ${reached(x + 3)}`);
}

console.log('\n6. Bots leave crates alone\n');
{
  const { w, r } = arena('ai');
  const b = r.players[1];
  b.tx = b.fx = b.tox = 4; b.ty = b.fy = b.toy = 4; b.moving = false;
  const crates = [[5, 4], [3, 4], [4, 5], [4, 3]];
  for (const [cx, cy] of crates) r.grid[cy][cx] = BB.CRATE;
  let moved = false;
  for (let i = 0; i < 60 * 8; i++) {
    w.update(FRAME);
    for (let y = 1; y < BB.ROWS - 1; y++)
      for (let x = 1; x < BB.COLS - 1; x++)
        if (r.grid[y][x] === BB.CRATE && !crates.some(([cx, cy]) => cx === x && cy === y)) moved = true;
  }
  check('a bot never pushes one', !moved, moved ? 'a crate appeared on a new tile' : 'crates stayed put');
}

console.log('\n7. Crates behave like crates otherwise\n');
{
  const { w, r } = arena();
  const x = 6, y = 6;
  r.grid[y][x] = BB.CRATE;
  r.bubbles.push({ x: x + 1, y, fuse: 0.01, range: 3, owner: r.players[1] });
  for (let i = 0; i < 30 && r.grid[y][x] === BB.CRATE; i++) w.update(FRAME);
  eq('a blast pops one', r.grid[y][x], BB.FLOOR);
}
{
  const w = BB.makeWorld();
  w.reset(['local', 'local', 'none', 'none', 'none', 'none', 'none', 'none'], ['#fff', '#0ff'], 'normal');
  const g = w.read().grid;
  let crates = 0, barrels = 0;
  for (const row of g) for (const v of row) { if (v === BB.CRATE) crates++; if (v === BB.BARREL) barrels++; }
  check('a fresh map has some of each', crates > 0 && barrels > crates,
    `${crates} pushable, ${barrels} fixed`);
}

console.log(failed ? `\n${failed} FAILING CASE(S)` : '\nall cases pass');
process.exit(failed ? 1 : 0);

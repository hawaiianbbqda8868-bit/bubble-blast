// 半身位 — standing on a tile boundary so a bubble in the tile you are
// straddling cannot reach you.
//
// One rule produces all three classic cases: the sailor leans the way he last
// walked, and always a little downwards, and a blast catches him only when
// that leaning point is inside its tile.
//
//   竖半身 (left/right)  on a vertical line his bubble drops in the tile he came
//                        from and cannot reach him; the far side still can, so
//                        which way you lean is the skill
//   横半身 (upper only)   on a horizontal line the tile ABOVE misses him however
//                        he got there, the one BELOW never does — the downward
//                        half of the lean never flips, so there is no 下半身
//   完美点 (both axes)    on a corner his weight lands on the diagonal, which no
//                        blast cross covers: stand still and keep dropping
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));

const FRAME = 1 / 60;
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(54)} ${detail}`);
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);

function arena() {
  const w = BB.makeWorld();
  w.reset(['local', 'local', 'none', 'none', 'none', 'none', 'none', 'none'], ['#fff', '#0ff'], 'normal');
  const r = w.read();
  for (let y = 1; y < BB.ROWS - 1; y++)
    for (let x = 1; x < BB.COLS - 1; x++) r.grid[y][x] = BB.FLOOR;
  r.powerups.length = 0; r.bubbles.length = 0; r.blasts.length = 0;
  const p = r.players[0];
  p.tx = p.fx = p.tox = BB.MIDX; p.ty = p.fy = p.toy = BB.MIDY; p.moving = false; p.t = 0;
  const q = r.players[1];                       // the second human just stands in a corner
  q.tx = q.fx = q.tox = 1; q.ty = q.fy = q.toy = 1; q.moving = false;
  return { w, r, p, q };
}
function step(w, p, dir, { half = false } = {}) {
  p.inSeq++; p.inHalf = half; p.inHeld = [dir];
  for (let i = 0; i < 30 && !p.moving; i++) w.update(FRAME);
  p.inHeld = [];
  for (let i = 0; i < 400 && p.moving; i++) w.update(FRAME);
  p.inHalf = false;
}
// drop a bubble where the sailor stands, let it go off, and report whether it caught him
function bubbleHere(w, r, p) {
  p.inSeq++; p.inBomb = true;
  for (let i = 0; i < 5 && !r.bubbles.length; i++) w.update(FRAME);
  const at = r.bubbles.length ? { x: r.bubbles[0].x, y: r.bubbles[0].y } : null;
  for (let i = 0; i < 60 * 4 && (r.bubbles.length || r.blasts.length) && !p.trapped; i++) w.update(FRAME);
  return { at, caught: p.trapped };
}

console.log('1. A half-step lands on the line, a normal step comes back off it\n');
{
  const { w, p } = arena();
  const x = p.tx;
  step(w, p, 'right', { half: true });
  eq('half-step right', p.tx, x + 0.5);
  step(w, p, 'right', { half: true });
  eq('another half-step', p.tx, x + 1);
  step(w, p, 'left', { half: true });
  eq('half-step back', p.tx, x + 0.5);
  step(w, p, 'right');                          // a normal tap re-centres you
  eq('a normal step from the line re-centres', p.tx, x + 1);
}
{
  const { w, p } = arena();
  const y = p.ty;
  step(w, p, 'down', { half: true });
  eq('half-step down', p.ty, y + 0.5);
  step(w, p, 'up');
  eq('a normal step up re-centres', p.ty, y);
}
{
  const { w, p } = arena();
  const x = p.tx;
  step(w, p, 'right', { half: true });
  step(w, p, 'right', { half: true });
  step(w, p, 'right', { half: true });
  eq('three half-steps = one and a half tiles', p.tx, x + 1.5);
}

console.log('\n2. 竖半身 — safe from the side you leant away from\n');
// A blast that dies out one tile short, from either side.
function blastFrom(w, r, x, y, ticks = 60 * 3) {
  r.bubbles.push({ x, y, fuse: 0.02, range: 1, owner: r.players[1] });
  const p = r.players[0];
  for (let i = 0; i < ticks && !p.trapped && (r.bubbles.length || r.blasts.length); i++) w.update(FRAME);
  return p.trapped;
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'right', { half: true });          // 左半身位: on the line, weight to the right
  eq('his bubble drops in the tile he came from', bubbleHere(w, r, p).at, { x, y });
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'right', { half: true });
  eq('a blast from the left cannot reach him', blastFrom(w, r, x - 1, y), false);
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'right', { half: true });
  eq('but one from the right still does', blastFrom(w, r, x + 2, y), true);
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'left', { half: true });            // 右半身位: the mirror image
  eq('leaning the other way, his bubble goes right', bubbleHere(w, r, p).at, { x, y });
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'left', { half: true });
  eq('and the blast from the right cannot reach him', blastFrom(w, r, x + 1, y), false);
}

console.log('\n3. 横半身 — the tile above misses, the one below does not\n');
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'down', { half: true });
  eq('his bubble drops in the tile above', bubbleHere(w, r, p).at, { x, y });
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'down', { half: true });
  eq('上半身: a blast from above cannot reach him', blastFrom(w, r, x, y - 1), false);
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'down', { half: true });
  eq('下半身 does not exist: from below it gets him', blastFrom(w, r, x, y + 2), true);
}
{
  const { w, r, p } = arena();                    // the same line, walked onto from below
  const x = p.tx, y = p.ty;
  step(w, p, 'up', { half: true });               // straddling y-1 and y
  eq('which way he came onto the line does not matter', blastFrom(w, r, x, y - 2), false);
}
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'up', { half: true });
  eq('and from below it still gets him', blastFrom(w, r, x, y + 1), true);
}

console.log('\n4. 完美点 — on a corner you can stand and keep dropping\n');
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  step(w, p, 'right', { half: true });
  step(w, p, 'down', { half: true });
  p.maxBubbles = 3;
  eq('standing on the corner', [p.tx, p.ty], [x + 0.5, y + 0.5]);
  let caught = false;
  for (let i = 0; i < 3 && !caught; i++) caught = bubbleHere(w, r, p).caught || caught;
  eq('three bubbles in a row, still dry', caught, false);
  eq('and he never had to move', [p.tx, p.ty], [x + 0.5, y + 0.5]);
}

console.log('\n5. The line has to be clear, and a half-step is still one tap\n');
{
  const { w, r, p } = arena();
  const x = p.tx, y = p.ty;
  r.grid[y][x + 1] = BB.WALL;
  step(w, p, 'right', { half: true });
  eq('you cannot straddle a wall', p.tx, x);
}
{
  const { w, r, p } = arena();
  const y = p.ty, x = p.tx;
  r.grid[y + 1][x] = BB.BARREL;
  step(w, p, 'down', { half: true });
  eq('or a barrel', p.ty, y);
}
{
  const { w, p } = arena();                     // hold it down: one press is still one move
  const x = p.tx;
  p.inSeq++; p.inHalf = true; p.inHeld = ['right'];
  for (let i = 0; i < 18; i++) w.update(FRAME); // 300ms, just under TAP_HOLD
  p.inHeld = []; p.inHalf = false;
  for (let i = 0; i < 60 && p.moving; i++) w.update(FRAME);
  eq('a 300ms half-press is one half-step', p.tx, x + 0.5);
}

console.log('\n6. Bots stay on the grid\n');
{
  const w = BB.makeWorld();
  w.reset(['local', 'ai', 'ai', 'none', 'none', 'none', 'none', 'none'], ['#fff'], 'normal');
  const r = w.read();
  let offGrid = false;
  for (let i = 0; i < 60 * 10; i++) {
    w.update(FRAME);
    for (const b of r.players) if (b.control === 'ai' && (b.tx % 1 || b.ty % 1)) offGrid = true;
  }
  check('a bot never half-steps', !offGrid, offGrid ? 'a bot ended up on a line' : 'always on tile centres');
}

console.log(failed ? `\n${failed} FAILING CASE(S)` : '\nall cases pass');
process.exit(failed ? 1 : 0);

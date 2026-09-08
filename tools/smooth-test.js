// Smooth-walking regression test: what the player SEES, single-player and online.
//
// "The movement is not smooth, always like stuck" (two tablets, online). Traced:
//   1. every turn while holding cost a 283ms tile (1.4x; 1.7x on skates): a new
//      direction is a new press, and every press re-asked "tap or walk?" with a lean
//   2. the sim threw away the leftover of the tick in which a tile landed and only
//      started the next tile on the following tick — 33ms lost per tile online
//      (200ms tiles took 233ms: everyone walked 14% slower than single-player)
//   3. the client froze at every tile boundary, then jumped: the snapshot that
//      landed the tile showed him standing, and clientAdvance never crosses a step
//
// This runs the REAL page code (netSendInput / applySnapshot / smoothPlayers /
// drawPos / loop, extracted from index.html) against relay/game-core.js ticked
// at the relay's 30Hz, with a simulated, jittery round trip, and records the
// drawn position of the sailor every 60fps frame.
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const extract = name => { const m = HTML.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n|function ' + name + '\\([^)]*\\)\\{[^\\n]*\\n')); if (!m) throw new Error('index.html has no ' + name); return m[0]; };
const grabLet = re => { const m = HTML.match(re); if (!m) throw new Error('index.html lacks ' + re); return m[0]; };
const SRC = ['armDir', 'pressDir', 'releaseDir', 'effectiveDirArr', 'netSendInput', 'applySnapshot', 'posOf', 'stepAhead', 'smoothPlayers', 'drawPos', 'predictInit', 'predictInput', 'predictStep', 'snapTo', 'predictReconcile', 'predictDraw', 'loop'].map(extract).join('\n');
const FRAME = 1000 / 60, SDT = 1 / 30;

function run({ online, script, rtt = 0, jitter = 0, speed = 0, runMs = 2500, seed = 7, predict = false, wallAhead = 0 }) {
  let rnd = seed; const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  let clock = 0; const toS = [], toC = []; let lastArrive = 0;
  const world = BB.makeWorld(); world.reset(['local', 'none', 'none', 'none'], ['#fff'], 'normal');
  const w0 = world.read(); for (let y = 1; y < w0.grid.length - 1; y++) for (let x = 1; x < w0.grid[y].length - 1; x++) w0.grid[y][x] = BB.FLOOR;
  const p0 = w0.players[0]; p0.speed = speed; p0.tx = p0.fx = p0.tox = BB.MIDX; p0.ty = p0.fy = p0.toy = BB.MIDY;
  if (wallAhead) w0.grid[BB.MIDY][BB.MIDX + wallAhead] = BB.WALL;      // the server knows about a wall the copy will only learn from snapshots
  const ctx = { clock: 0, online, BB, players: online ? world.snapshot().players : w0.players, send: o => { if (o.k === 'input') toS.push([clock + rtt / 2, o]); }, world };
  const C = new Function('ctx', `
    const performance = { now: () => ctx.clock }; const requestAnimationFrame = () => {}; let last = 0; const held = []; const BB = ctx.BB; let paused = false; const FUSE = BB.FUSE;
    let pred = null;
    let wantBubble = false, bufferDir = null, bufferT = 0, inSeq = 0, lastInDir = '_', lastInTap = false, lastInHalf = false, lastInT = 0;
    let grid, players = ctx.players, bubbles, blasts, powerups; let state = 'playing', mySlot = 0, teamMode = false, winnerSlot = -1, deadShown = false;
    let netRole = ctx.online ? 'host' : 'off'; const world = ctx.online ? null : ctx.world; let halfMode = false, halfKey = false; const halfOn = () => false;
    const sfx = new Proxy({}, { get: () => () => {} }); const endGame = () => {}; const ws = { readyState: 1 }; const wsSend = o => ctx.send(o); const mashEscape = () => {};
    const hideOverlays = () => {}, showResult = () => {};
    ${grabLet(/(?:let|const)\s+snaps\s*=[^\n]*\n/)}
    ${grabLet(/let\s+snapLag\s*=[^\n]*\n/)}
    function syncWorld(){ const r = ctx.world.read(); players = r.players; }
    const render = () => {};
    ${SRC}
    return { loop, pressDir, releaseDir, snapshot: d => applySnapshot(d), predictInit: m => predictInit(m), pos: () => { const q = drawPos(players[0]); return q.x + 1000 * q.y; } };`)(ctx);
  if (online && predict) { const mm = world.mapMsg(); mm.grid = world.read().grid.map(r => r.join('')); C.predictInit(mm); }
  const ev = script.flatMap(([at, dir, hold]) => [[200 + at, 'down', dir], [200 + at + hold, 'up', dir]]).sort((a, b) => a[0] - b[0]);
  let ei = 0, acc = 0; const landings = []; let prev = { x: p0.tx, y: p0.ty }; const frames = []; let lastPos = C.pos();
  for (; clock < runMs; clock += FRAME) {
    ctx.clock = clock;
    while (ei < ev.length && clock >= ev[ei][0]) { const [, k, d] = ev[ei++]; k === 'down' ? C.pressDir(d) : C.releaseDir(d); }
    if (online) while (toC.length && toC[0][0] <= clock) C.snapshot(toC.shift()[1]);   // snapshots land before the frame draws
    C.loop(clock);
    if (online) {
      while (toS.length && toS[0][0] <= clock) { const m = toS.shift()[1]; world.setInput(0, { dir: m.dir, bomb: m.bomb, tap: m.tap, half: m.half, seq: m.seq }); }
      acc += FRAME / 1000;
      while (acc >= SDT) { acc -= SDT; world.update(SDT);
        lastArrive = Math.max(lastArrive, clock + rtt / 2 + rand() * jitter);          // TCP: in order, bunched
        toC.push([lastArrive, Object.assign({ k: 'state' }, world.snapshot())]); }
    }
    const me = world.read().players[0];
    if (me.tx !== prev.x || me.ty !== prev.y) { landings.push(Math.round(clock - 200)); prev = { x: me.tx, y: me.ty }; }
    const pos = C.pos(); frames.push({ t: clock, d: pos - lastPos }); lastPos = pos;
  }
  return { landings, gaps: landings.map((l, i) => i ? l - landings[i - 1] : l), frames };
}

let failed = 0;
const check = (label, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`); };
const tileMs = sp => Math.round((BB.BASE_MOVE - BB.SPEED_GAIN[sp]) * 1000);

console.log('\n1. Turning while holding is still one walk — no lean on every corner\n');
for (const speed of [0, 3]) {
  const r = run({ online: false, speed, script: [[0, 'right', 700], [700, 'down', 700], [1400, 'left', 700]], runMs: 2400 });
  const tile = tileMs(speed);
  const later = r.gaps.slice(2);                       // tile 1 = first tile, tile 2 = the one lean a fresh press may take
  check(`single-player, speed ${speed}: tiles after the first lean`, later.every(g => g <= tile * 1.12 + FRAME),
    `gaps ${r.gaps.join(' ')}  (tile ${tile}ms)`);
}
{ const r = run({ online: true, rtt: 120, script: [[0, 'right', 700], [700, 'down', 700]], runMs: 2000 });
  check('online, rtt 120: turning does not lean again', r.gaps.slice(2).every(g => g <= 200 * 1.12 + 1000 / 30), `gaps ${r.gaps.join(' ')}`); }

console.log('\n2. A tile landing does not eat a tick — online walks at single-player speed\n');
for (const speed of [0, 3]) {
  const r = run({ online: true, speed, script: [[0, 'right', 1800]], runMs: 2300 });
  const tile = tileMs(speed), steady = r.gaps.slice(2);
  const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
  check(`online, speed ${speed}: steady tile time`, Math.abs(avg - tile) <= 6, `avg ${avg.toFixed(0)}ms per tile (single-player ${tile}ms)  gaps ${steady.join(' ')}`);
}
{ const r = run({ online: false, script: [[0, 'right', 1800]], runMs: 2300 }); const steady = r.gaps.slice(2);
  const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
  check('single-player, speed 0: steady tile time', Math.abs(avg - 200) <= 6, `avg ${avg.toFixed(0)}ms per tile  gaps ${steady.join(' ')}`); }

console.log('\n3. What is drawn online never freezes mid-walk or jumps\n');
for (const [rtt, jitter] of [[0, 0], [120, 0], [120, 60], [250, 80]]) {
  const r = run({ online: true, rtt, jitter, script: [[0, 'right', 1800]], runMs: 2300 });
  const mv = r.frames.filter(f => f.t > 200 + rtt + 450 && f.t < 1900);      // steady hold, after the first lean
  const frozen = mv.filter(f => f.d === 0).length, back = mv.filter(f => f.d < -1e-6).length, jump = mv.filter(f => f.d > 0.2).length;
  const perFrame = FRAME / 200;                                                // a tile is 200ms: 0.083 tile per frame
  const ok = frozen === 0 && back === 0 && jump === 0;
  check(`online, rtt ${rtt} jitter ${jitter}: ${mv.length} drawn frames`, ok, `frozen ${frozen}, backwards ${back}, jumps>0.2 tile ${jump}  (a smooth frame moves ${perFrame.toFixed(3)})`);
}
console.log('\n4. ...and a tap still lands on the tile, drawn exactly there\n');
{ const r = run({ online: true, rtt: 120, script: [[0, 'right', 80]], runMs: 1500 });
  const end = r.frames[r.frames.length - 1];
  check('online tap: one tile, then still', r.landings.length === 1 && r.frames.slice(-20).every(f => f.d === 0), `${r.landings.length} tile(s); last frames ${r.frames.slice(-3).map(f => f.d.toFixed(3)).join(' ')}`); }

console.log('\n5. Your own sailor moves the moment you press (predicted), and lands where the server says\n');
for (const rtt of [120, 250]) {
  const r = run({ online: true, rtt, predict: true, script: [[0, 'right', 80]], runMs: 1600 });
  const first = r.frames.find(f => f.t >= 200 && Math.abs(f.d) > 1e-6);
  check(`rtt ${rtt}: drawn sailor starts within 2 frames of the press`, first && first.t - 200 <= 2 * FRAME + 1, first ? `${Math.round(first.t - 200)}ms after the press` : 'never moved');
  const end = r.frames[r.frames.length - 1];
  check(`rtt ${rtt}: a tap ends on one tile, drawn exactly there`, r.landings.length === 1 && r.frames.slice(-20).every(f => f.d === 0), `${r.landings.length} tile(s); last frames ${r.frames.slice(-3).map(f => f.d.toFixed(3)).join(' ')}`);
}
{ const r = run({ online: true, rtt: 120, predict: true, script: [[0, 'right', 1500]], runMs: 2000 });
  const mv = r.frames.filter(f => f.t > 700 && f.t < 1650);
  check('rtt 120, holding: predicted walk is smooth (no freezes, no jumps back)', mv.every(f => f.d > 0 && f.d < 0.2), `worst frames ${Math.min(...mv.map(f => f.d)).toFixed(3)} .. ${Math.max(...mv.map(f => f.d)).toFixed(3)}`); }
{ // the copy runs into a wall only the server knows about: it must snap back to the server's tile, not walk through it
  const r = run({ online: true, rtt: 120, predict: true, wallAhead: 2, script: [[0, 'right', 900]], runMs: 1800 });
  const lastPos = r.frames.reduce((a, f) => a + f.d, 0);
  check('a wall the copy did not know about: he settles on the server tile', Math.abs(lastPos - 1) < 0.02 && r.frames.slice(-15).every(f => f.d === 0), `drawn offset ${lastPos.toFixed(2)} tiles (server allows 1)`); }
console.log(failed ? `\n${failed} FAILED` : '\nall cases pass'); process.exit(failed ? 1 : 0);

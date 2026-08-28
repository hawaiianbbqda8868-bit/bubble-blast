// Movement input regression test.
//
// Drives the REAL client code (armDir / pressDir / releaseDir / effectiveDirArr /
// netSendInput / loop, extracted verbatim from index.html) against whichever sim
// actually runs in that mode — and they are two different pieces of code:
//
//   single-player: index.html's OWN sim (update / reset / moveDur ... extracted
//                  verbatim from the page), stepped at 60fps in the browser
//   online:        relay/game-core.js, ticked at the relay's 1/30 s with input
//                  and snapshots delayed by a simulated round trip — the same
//                  wiring relay/server.js uses, including exactly which fields
//                  it forwards to setInput()
//
// Testing single-player against the core instead is how a movement fix that
// only landed in game-core.js once looked green while the game still misbehaved.
//
// Rules under test:
//   1. one press of a direction -> exactly one tile, at any speed or latency
//   2. holding a direction      -> continuous walking
//   3. repeated presses         -> one tile each, never banked, and no drift
//                                  after the last release (over-driving the
//                                  sailor saturates: excess presses are
//                                  dropped, not queued, or he can't stop)
//   4. changing direction       -> he goes where you last pointed
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extract(name) {                        // pull `function name(...){...}` out of index.html
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('client function not found in index.html: ' + name);
  let depth = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) return HTML.slice(start, j + 1);
  }
  throw new Error('unbalanced braces for ' + name);
}
const CLIENT_SRC = ['armDir', 'pressDir', 'releaseDir', 'effectiveDirArr', 'netSendInput', 'loop']
  .map(extract).join('\n');

const FRAME = 1000 / 60, SERVER_DT = 1 / 30;    // relay/server.js: DT = 1/30

// index.html's single-player sim, lifted out of the page and given the handful
// of globals it reads (no DOM, no canvas, no sound, and no bots in these
// scenarios). Constants come from the core so the two can't silently diverge.
const SIM_FNS = ['areAllies', 'bubbleAt', 'passable', 'tileOf', 'blastCells', 'buildMap',
                 'makePlayer', 'botPlan', 'reset', 'placeBubble', 'burst',
                 'speedGain', 'moveDur', 'botMoveDur', 'update'];
function makeClientSim() {
  const src = SIM_FNS.map(extract).join('\n');
  return new Function('BB', `
    'use strict';
    const { COLS, ROWS, FUSE, BLAST_TIME, TRAP_TIME, ESCAPE_NEED, BASE_MOVE, SPEED_GAIN, MAX_SPEED,
            TAP_HOLD, MAX_RANGE, MAX_BUBBLES, FLOOR, WALL, BARREL, PALETTE, DIRV,
            SKIN, SKIN_LT, SPAWNS, MAPS, THEMES, MIDX, MIDY } = BB;
    const POWERUP_CHANCE = 0.36, BARREL_FILL = 0.78, PU_RANGE = 0, PU_BUBBLE = 1, PU_SPEED = 2;
    const inB = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS, key = (x, y) => x + ',' + y;
    const sfx = new Proxy({}, { get: () => () => {} });
    let grid, players = [], bubbles = [], blasts = [], powerups = [], decor, theme, shipCenter;
    let burstCounter = 0, diff = 'normal', teamMode = false;
    let netRole = 'off', state = 'playing', mySlot = 0, deadShown = false;
    const endGame = () => { state = 'over'; }, showResult = () => {};
    const botAct = () => ({ dir: null, bubble: false });
    ${src}
    return { reset, update, get players(){ return players; }, get grid(){ return grid; } };
  `)(BB);
}

// script: [[atMs, dir, holdMs], ...]
function play({ online, script, rttMs = 0, speed = 0, runMs = 3000, frameMs = FRAME, center = false }) {
  let clock = 0;
  const toServer = [], toClient = [];
  let world = null, sim, livePlayers, liveGrid;
  if (online) {                                        // the relay runs game-core.js
    world = BB.makeWorld();
    world.reset(['local', 'none', 'none', 'none'], ['#fff'], 'normal');
    sim = world; livePlayers = () => world.read().players; liveGrid = () => world.read().grid;
  } else {                                             // single-player runs index.html's own sim
    const c = makeClientSim();
    c.reset(['local', 'none', 'none', 'none'], ['#fff']);
    sim = c; livePlayers = () => c.players; liveGrid = () => c.grid;
  }
  const w0 = { grid: liveGrid(), players: livePlayers() };
  for (let y = 1; y < w0.grid.length - 1; y++)          // open the interior: no test should be wall-limited
    for (let x = 1; x < w0.grid[y].length - 1; x++) w0.grid[y][x] = BB.FLOOR;
  w0.players[0].speed = speed;
  if (center) {                                        // spawns sit in a corner: up/left are the hull
    const p0 = w0.players[0];
    p0.tx = p0.fx = p0.tox = BB.MIDX; p0.ty = p0.fy = p0.toy = BB.MIDY;
  }
  const from = { x: w0.players[0].tx, y: w0.players[0].ty };

  const ctx = {
    clock: 0, online, mySlot: 0,
    players: online ? world.snapshot().players : w0.players,
    send: o => { if (o && o.k === 'input') toServer.push([clock + rttMs / 2, o]); },
    update: dt => sim.update(dt),
  };
  const C = new Function('ctx', `
    const performance = { now: () => ctx.clock };
    const requestAnimationFrame = () => {};
    let last = 0;
    const held = [];
    let wantBubble = false, bufferDir = null, bufferT = 0, inSeq = 0;
    let lastInDir = '_', lastInTap = false, lastInT = 0;
    let players = ctx.players, state = 'playing', mySlot = ctx.mySlot;
    let netRole = ctx.online ? 'host' : 'off';
    const ws = { readyState: 1 };
    const wsSend = o => ctx.send(o);
    const mashEscape = () => {};
    const update = dt => ctx.update(dt);
    const clientAdvance = () => {};
    const render = () => {};
    ${CLIENT_SRC}
    return { loop, pressDir, releaseDir, setPlayers: p => { players = p; } };
  `)(ctx);

  const events = script
    .flatMap(([at, dir, hold]) => [[200 + at, 'down', dir], [200 + at + hold, 'up', dir]])
    .sort((a, b) => a[0] - b[0]);
  const lastRelease = Math.max(...events.map(e => e[0]));
  const driftAfter = lastRelease + rttMs + (BB.BASE_MOVE - BB.SPEED_GAIN[speed]) * 1000 * 1.5;
  let ei = 0, acc = 0, tiles = 0, tilesAfterLastRelease = 0;  // ...AfterLastRelease = drift
  let prev = { x: from.x, y: from.y };

  for (; clock < runMs; clock += frameMs) {
    ctx.clock = clock;
    while (ei < events.length && clock >= events[ei][0]) {
      const [, kind, dir] = events[ei++];
      kind === 'down' ? C.pressDir(dir) : C.releaseDir(dir);
    }
    if (!online) { ctx.players = livePlayers(); C.setPlayers(ctx.players); C.loop(clock); }
    else {
      C.loop(clock);
      while (toServer.length && toServer[0][0] <= clock) {
        const m = toServer.shift()[1];
        world.setInput(0, { dir: m.dir, bomb: m.bomb, tap: m.tap, seq: m.seq });
      }
      acc += frameMs / 1000;
      while (acc >= SERVER_DT) { acc -= SERVER_DT; world.update(SERVER_DT); toClient.push([clock + rttMs / 2, world.snapshot().players]); }
      while (toClient.length && toClient[0][0] <= clock) { ctx.players = toClient.shift()[1]; C.setPlayers(ctx.players); }
    }
    const me = livePlayers()[0];
    if (me.tx !== prev.x || me.ty !== prev.y) {
      tiles++; if (clock > driftAfter) tilesAfterLastRelease++;
      prev = { x: me.tx, y: me.ty };
    }
  }
  const me = livePlayers()[0];
  return { tiles, tilesAfterLastRelease, dx: me.tx - from.x, dy: me.ty - from.y };
}

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} ${detail}`);
};
const eq = (label, got, want) => check(label, got === want, `${got} tile(s) (want ${want})`);
const RTTS = [0, 60, 150, 250];

console.log('1. ONE press of a direction key -> exactly one tile\n');
for (const hold of [40, 80, 120, 180]) {
  eq(`single-player, ${hold}ms press`, play({ online: false, script: [[0, 'right', hold]] }).tiles, 1);
  for (const rtt of RTTS) {
    eq(`online, ${hold}ms press, rtt ${rtt}ms`, play({ online: true, script: [[0, 'right', hold]], rttMs: rtt }).tiles, 1);
  }
}

console.log('\n2. ...still one tile with skates on (shorter tiles, same latency)\n');
for (let sp = 1; sp <= BB.MAX_SPEED; sp++) {
  eq(`single-player, speed ${sp}`, play({ online: false, script: [[0, 'right', 80]], speed: sp }).tiles, 1);
  for (const rtt of RTTS) {
    eq(`online, speed ${sp}, rtt ${rtt}ms`, play({ online: true, script: [[0, 'right', 80]], rttMs: rtt, speed: sp }).tiles, 1);
  }
}

console.log('\n3. Holding walks continuously (1000ms at 200ms per tile)\n');
for (const online of [false, true]) {
  const r = play({ online, script: [[0, 'right', 1000]], rttMs: online ? 60 : 0, runMs: 4000 });
  check(`${online ? 'online' : 'single-player'}, 1000ms hold`, r.tiles >= 4 && r.tiles <= 6, `${r.tiles} tiles (want 4-6)`);
}

console.log('\n4. Repeated presses: one tile each, and he stops when you do\n');
for (const gap of [120, 160, 200, 300]) {
  for (const rtt of RTTS) {
    const r = play({ online: true, rttMs: rtt, runMs: 4000,
                     script: [[0, 'right', 70], [gap, 'right', 70], [gap * 2, 'right', 70]] });
    const wantMin = gap >= 200 ? 3 : 2;   // faster than 200ms/tile over-drives him
    check(`online, 3 presses ${gap}ms apart, rtt ${rtt}ms`,
      r.tiles >= wantMin && r.tiles <= 3 && r.tilesAfterLastRelease === 0,
      `${r.tiles} tiles (want ${wantMin}-3), ${r.tilesAfterLastRelease} drifted (want 0)`);
  }
}

console.log('\n5. Changing direction: he goes where you last pointed\n');
for (const rtt of RTTS) {
  const r = play({ online: true, rttMs: rtt, runMs: 4000, script: [[0, 'right', 70], [250, 'down', 70]] });
  check(`online, right then down, rtt ${rtt}ms`,
    r.dx === 1 && r.dy === 1 && r.tiles === 2,
    `dx=${r.dx} dy=${r.dy} in ${r.tiles} tiles (want dx=1 dy=1, 2)`);
}
for (const rtt of RTTS) {
  const r = play({ online: true, rttMs: rtt, runMs: 4000, script: [[0, 'right', 70], [110, 'down', 70]] });
  check(`online, turn mid-step, rtt ${rtt}ms`,
    r.dx <= 1 && r.dy <= 1 && r.dy >= 0 && r.tiles <= 2 && r.tilesAfterLastRelease === 0,
    `dx=${r.dx} dy=${r.dy} in ${r.tiles} tiles, ${r.tilesAfterLastRelease} drifted`);
}

console.log('\n6. A press is ONE tile however long you hold it, up to the hold threshold\n');
// The thumb on a D-pad rests far longer than a keyboard tap — especially on the
// up/down arms, which are a longer reach. Anything under BB.TAP_HOLD is a tap.
for (const hold of [200, 240, 280]) {
  eq(`single-player, ${hold}ms press`, play({ online: false, script: [[0, 'right', hold]], runMs: 2500 }).tiles, 1);
  eq(`single-player, ${hold}ms press, speed 3`, play({ online: false, script: [[0, 'right', hold]], speed: 3, runMs: 2500 }).tiles, 1);
  for (const rtt of RTTS) {
    eq(`online, ${hold}ms press, rtt ${rtt}ms`, play({ online: true, script: [[0, 'right', hold]], rttMs: rtt, runMs: 2500 }).tiles, 1);
    eq(`online, ${hold}ms press, speed 3, rtt ${rtt}ms`, play({ online: true, script: [[0, 'right', hold]], rttMs: rtt, speed: 3, runMs: 2500 }).tiles, 1);
  }
}
for (const dir of ['up', 'down', 'left', 'right']) {   // no axis is special
  eq(`single-player, 260ms press ${dir}`, play({ online: false, script: [[0, dir, 260]], runMs: 2500, center: true }).tiles, 1);
}

console.log('\n7. Past the threshold he walks on (holding still works)\n');
for (const online of [false, true]) {
  const r = play({ online, rttMs: online ? 60 : 0, script: [[0, 'right', 1500]], runMs: 4000 });
  check(`${online ? 'online' : 'single-player'}, 1500ms hold`, r.tiles >= 5 && r.tiles <= 8, `${r.tiles} tiles (want 5-8)`);
}

console.log(failed ? `\n${failed} FAILING CASE(S)` : '\nall cases pass');
process.exit(failed ? 1 : 0);

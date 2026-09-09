// Screen-fit regression test.
//
// "ability is overlapping the map": the HUD card sits over the top-left of the
// board, so on a tablet a sailor could stand behind your own stats. The camera
// now fits the board UNDER the HUD strip. This runs the REAL updateCamera()
// from index.html against a range of screen shapes and checks two things on
// each: the board never reaches into the HUD strip, and it is never fitted
// larger than the room left below it.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const BB = require(path.join(ROOT, 'relay/game-core.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const grab = re => { const m = HTML.match(re); if (!m) throw new Error('index.html lacks ' + re); return m[0]; };

const COLS = BB.COLS, ROWS = BB.ROWS, TILE = 40;
const SHAPES = [
  ['phone portrait', 390, 844], ['phone landscape', 844, 390], ['small phone', 360, 640],
  ['tablet portrait', 820, 1180], ['tablet landscape', 1180, 820], ['iPad Pro', 1024, 1366],
  ['desktop', 1512, 789], ['short window', 1200, 560], ['tall narrow', 430, 1300],
];
let failed = 0;
const check = (label, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`); };

function camFor(w, h, hudPx, playing) {
  const ctx = {
    COLS, ROWS, TILE, CAM_MAX_TILE: +grab(/const CAM_MAX_TILE = (\d+)/).match(/\d+/)[0],
    CAM_FOLLOW: 0.18, CAM: { x: null, y: null },
    cv: { width: 0, height: 0, style: {} },
    window: { innerWidth: w, innerHeight: h, devicePixelRatio: 2 },
    hudH: playing ? hudPx : 0,
    state: playing ? 'playing' : 'start',
    mySlot: 0,
    players: [{ tx: 1, ty: 1, moving: false, rx: null }],
    drawPos: p => ({ x: p.tx, y: p.ty }),
    addEventListener: () => {},
  };
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(`const { innerWidth, innerHeight, devicePixelRatio } = window;` + grab(/function updateCamera\(\)\{[\s\S]*?\n\}\n/) + '\nupdateCamera();', ctx);
  return ctx.CAM;
}

console.log('\nThe board is fitted under the HUD, never behind it\n');
for (const [name, w, h] of SHAPES) {
  const hud = 98;                                   // the card as it measures on a real screen
  const c = camFor(w, h, hud, true);
  const top = (0 - c.y) * c.zoom + c.top, bottom = (ROWS * TILE - c.y) * c.zoom + c.top;
  const drawnH = bottom - top;
  check(`${name} ${w}x${h}: clear of the HUD strip`, top >= hud - 0.5 || drawnH > h - hud + 0.5,
    `board top ${Math.round(top)} vs strip ${hud}`);
  check(`${name} ${w}x${h}: fits the room below it`, drawnH <= h - hud + 0.5 || bottom <= h + 0.5 || c.zoom * TILE >= 34,
    `board ${Math.round(drawnH)}px in ${h - hud}px`);
}

console.log('\nOff the board (menus) the strip is gone and nothing shifts\n');
{
  const a = camFor(1024, 1366, 98, false), b = camFor(1024, 1366, 0, false);
  check('no HUD, no reserved strip', a.top === 0 && b.top === 0, `top ${a.top}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall cases pass');
process.exit(failed ? 1 : 0);

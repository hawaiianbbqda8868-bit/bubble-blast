// The music, which is additive: parts join one at a time and never mid-phrase.
//
// 泡泡堂's soundtrack builds by stacking, so this one does too — a kick alone at
// the top of a round, then a hat, a bass, a lead and a bell as the round gets
// older and the board thins out. This drives the REAL scheduler out of
// index.html against a stub AudioContext and watches what it asks to play.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const grab = re => { const m = HTML.match(re); if (!m) throw new Error('index.html lacks ' + re); return m[0]; };

let failed = 0;
const check = (label, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail == null ? '' : detail}`); };
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);

function rig() {
  const played = [];                       // {part, t}
  const ctx = {
    clock: 0, played,
    state: 'playing', players: [], tideDoom: [], muted: false,
    setInterval: () => 1, clearInterval: () => {}, Math, console,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let actx = { get currentTime(){ return clock; } };
    const audio = () => actx;
    const musicBus = null;
    const musNote = (t, f, dur, type, vol) => played.push({ part: type === 'triangle' ? 'bass' : type === 'square' ? 'lead' : type === 'sawtooth' ? 'surge' : 'bell', t });
    const musDrum = (t, kind) => played.push({ part: kind, t });
    ${grab(/const MUS = \{[\s\S]*?\n\};\n/)}
    ${grab(/const PENTA = [^\n]*\n/)}
    ${grab(/const noteHz = [^\n]*\n/)}
    ${grab(/function musStep\(\)\{[\s\S]*?\n\}\n/)}
    ${grab(/function musicStart\(\)\{[\s\S]*?\n\}\n/)}
    ${grab(/function musicStop\(\)[^\n]*\n/)}
    ${grab(/function musicPulse\(\)\{[\s\S]*?\n\}\n/)}
  `, ctx);
  // run the scheduler forward like the 40ms timer does
  ctx.run = secs => { for (let i = 0; i < secs / 0.04; i++) { ctx.clock += 0.04; vm.runInContext('musStep()', ctx); } };
  return ctx;
}
const partsIn = (r, from, to) => new Set(r.played.filter(p => p.t >= from && p.t < to).map(p => p.part));

console.log('\n1. Nothing plays until a round starts\n');
{
  const r = rig();
  r.run(2);
  eq('silence before musicStart', r.played.length, 0);
  vm.runInContext('musicStart()', r);
  r.run(2);
  check('and notes once it does', r.played.length > 0, `${r.played.length} notes`);
  vm.runInContext('musicStop()', r);
  const n = r.played.length;
  r.run(2);
  eq('silence again after musicStop', r.played.length, n);
}

console.log('\n2. It starts on one part and adds them one at a time\n');
{
  const r = rig();
  vm.runInContext('musicStart()', r);
  r.run(4);
  eq('a round opens on the kick alone', [...partsIn(r, 0, 4)], ['kick']);
  const bar = 16 * (60 / 116 / 4);                    // one bar at the tune's tempo
  for (const want of [2, 3, 4, 5]) {
    const t0 = r.clock;
    vm.runInContext(`MUS.want = ${want}`, r);
    r.run(bar * 2.2);
    const parts = partsIn(r, t0 + bar, r.clock);
    check(`asking for ${want} parts gets ${want}`, parts.size === want, [...parts].join(', '));
  }
  vm.runInContext('MUS.want = 1', r);
  r.run(bar * 6);                                     // parts leave one a bar, same as they arrived
  const t1 = r.clock;
  r.run(bar * 2);
  eq('and they drop away again, one a bar', [...partsIn(r, t1, r.clock)], ['kick']);
}

console.log('\n3. Parts join on the bar, never mid-phrase\n');
{
  const r = rig();
  vm.runInContext('musicStart()', r);
  const t0 = r.clock + 0.08, spb = 60 / 116 / 4;      // musicStart schedules the first sixteenth here
  vm.runInContext('MUS.want = 5', r);
  r.run(20);
  // where in the bar each part is first heard, against where its own pattern says it should be
  const hitDrum = pat => pat.findIndex(v => !!v);          // drums: 1 plays, 0 rests
  const hitNote = pat => pat.findIndex(v => v !== null);   // parts: a rest is null, and 0 is a real note
  const want = {
    kick: hitDrum(vm.runInContext('MUS.kick', r)), hat: hitDrum(vm.runInContext('MUS.hat', r)),
    bass: hitNote(vm.runInContext('MUS.bass', r)), lead: hitNote(vm.runInContext('MUS.lead', r)),
    bell: hitNote(vm.runInContext('MUS.bell', r)),
  };
  const wrong = [];
  for (const part of Object.keys(want)) {
    const first = r.played.find(p => p.part === part);
    if (!first) { wrong.push(part + ' never played'); continue; }
    const step = Math.round((first.t - t0) / spb);
    if (step % 16 !== want[part]) wrong.push(`${part} came in at step ${step % 16}, its pattern starts at ${want[part]}`);
  }
  check('every part comes in on the bar, where its pattern starts', wrong.length === 0, wrong.join('; ') || 'all five');
}

console.log('\n4. The round itself decides how thick it gets\n');
{
  const r = rig();
  vm.runInContext('musicStart()', r);
  r.players = [{ alive: true }, { alive: true }, { alive: true }, { alive: true }];
  vm.runInContext('musicPulse()', r);
  const early = vm.runInContext('MUS.want', r);
  eq('four sailors, early: one part', early, 1);
  r.players = [{ alive: true }, { alive: true }];
  vm.runInContext('musicPulse()', r);
  check('down to two sailors and it thickens', vm.runInContext('MUS.want', r) > early, `want ${vm.runInContext('MUS.want', r)}`);
  r.tideDoom = [1, 2, 3];
  vm.runInContext('musicPulse()', r);
  check('a wall on its way brings the sea in', vm.runInContext('MUS.surge', r) === true);
  r.state = 'over';
  const held = vm.runInContext('MUS.want', r);
  r.players = [];
  vm.runInContext('musicPulse()', r);
  eq('and nothing changes once the round is over', vm.runInContext('MUS.want', r), held);
}

console.log('\n5. Waking from a sleeping tab does not fire a burst\n');
{
  // The context freezes while the tab is asleep, then jumps forward. Without a
  // resync that jump is played as hundreds of missed sixteenths at once.
  const r = rig();
  vm.runInContext('musicStart()', r);
  r.run(1);
  const before = r.played.length;
  r.clock += 30;                                       // the tab was away half a minute
  vm.runInContext('musStep()', r);
  check('at most a beat of notes on waking', r.played.length - before <= 4, `${r.played.length - before} notes`);
  r.run(1);
  check('and it keeps playing after', r.played.length > before + 1);
}

console.log(failed ? `\n${failed} FAILED` : '\nall cases pass');
process.exit(failed ? 1 : 0);

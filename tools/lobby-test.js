// Lobby head-count regression test.
//
// Bug: two tablets in a room, the lobby said "Humans: 3". A tablet that re-joins
// (second tap on Join, or Safari dropping the socket while the screen slept and
// the player tapping Join again) opened a NEW socket while the server still held
// the old one, so the same device was counted twice — and its ghost seat went
// into the game as a sailor nobody controls.
//
// Two layers, tested separately:
//   server: a (re)join carrying a cid already seated in the room REPLACES that
//           seat instead of adding one; the ghost socket is closed and its close
//           must not shrink the count or tear the room down (even for the host).
//   client: the page keeps one stable device id and connectServer() closes any
//           socket it already holds before opening another — extracted verbatim
//           from index.html and run against a fake WebSocket.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process'), net = require('net');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'relay/node_modules/ws'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let fails = 0;
function check(name, ok, detail){ console.log((ok?'  ok   ':'  FAIL ') + name + (ok||detail==null?'':'  -- '+detail)); if(!ok) fails++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort(){ return new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }

// ---- a tiny scripted client: records every message, resolves on the next one of kind k ----
function client(url){
  const ws = new WebSocket(url); const msgs = []; const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); for(const w of waiters.splice(0)) w(m); });
  const c = { ws, msgs, closed:false,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: o => ws.send(JSON.stringify(o)),
    next: (k, ms=1500) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for '+k)), ms);
      const w = m => { if(m.k===k){ clearTimeout(t); res(m); } else waiters.push(w); }; waiters.push(w); }),
    last: k => { for(let i=msgs.length-1;i>=0;i--) if(msgs[i].k===k) return msgs[i]; return null; } };
  ws.on('close', () => { c.closed = true; });
  return c;
}

async function serverTests(){
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'relay/server.js')], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ['ignore','pipe','pipe'] });
  await new Promise(res => srv.stdout.on('data', d => { if(String(d).includes('game server on')) res(); }));
  const url = 'ws://127.0.0.1:' + port;
  try {
    console.log('server: one device, two sockets');
    const host = client(url); await host.open(); host.send({ k:'create', cid:'HOST', color:'#f00', bots:1 }); await host.next('joined');
    const tabA = client(url); await tabA.open(); tabA.send({ k:'join', cid:'TAB-A', code:host.last('joined').code }); const ja = await tabA.next('joined');
    await host.next('lobby'); check('two devices -> Humans: 2', host.last('lobby').n === 2, 'n='+host.last('lobby').n);

    // Tablet A taps Join again (or comes back from sleep): new socket, same device id.
    const tabA2 = client(url); await tabA2.open(); tabA2.send({ k:'join', cid:'TAB-A', code:host.last('joined').code }); const ja2 = await tabA2.next('joined');
    await sleep(150);
    check('re-join from the same device does not add a human', host.last('lobby').n === 2, 'n='+host.last('lobby').n);
    check('re-join keeps the same seat', ja2.slot === ja.slot, ja.slot+' -> '+ja2.slot);
    check('the ghost socket is closed by the server', tabA.closed);
    await sleep(150);
    check('ghost closing does not shrink the count', host.last('lobby').n === 2, 'n='+host.last('lobby').n);
    check('room is still open', !host.last('closed') && !tabA2.last('closed'));

    console.log('server: host device reconnects');
    const host2 = client(url); await host2.open(); host2.send({ k:'join', cid:'HOST', code:host.last('joined').code }); const jh = await host2.next('joined');
    await sleep(200);
    check('host re-join takes seat 0 back', jh.slot === 0, 'slot='+jh.slot);
    check('old host socket closed', host.closed);
    check('room NOT torn down when the ghost host socket closes', !tabA2.last('closed') && !host2.last('closed'));
    check('still Humans: 2', host2.last('lobby') && host2.last('lobby').n === 2, 'n='+(host2.last('lobby')||{}).n);
    host2.send({ k:'setbots', bots:2 }); await host2.next('lobby');
    check('reconnected host still has host powers (setbots)', host2.last('lobby').bots === 2, 'bots='+host2.last('lobby').bots);

    console.log('server: a socket that joins twice');
    tabA2.send({ k:'join', cid:'TAB-A', code:host.last('joined').code }); await sleep(150);
    check('same socket re-sending join is not a second human', host2.last('lobby').n === 2, 'n='+host2.last('lobby').n);

    console.log('server: a real second device still counts');
    const tabB = client(url); await tabB.open(); tabB.send({ k:'join', cid:'TAB-B', code:host.last('joined').code }); await tabB.next('joined'); await sleep(100);
    check('third device -> Humans: 3', host2.last('lobby').n === 3, 'n='+host2.last('lobby').n);
    console.log('server: the host picks the map, nobody rolls one');
    host2.send({ k:'setmap', map:3 }); const [lb] = await Promise.all([host2.next('lobby'), tabB.next('lobby')]);
    check('setmap shows in the lobby for everyone', lb.map === 3 && tabB.last('lobby') && tabB.last('lobby').map === 3, JSON.stringify([lb.map, (tabB.last('lobby')||{}).map]));
    host2.send({ k:'start', diff:'easy', bots:2, teams:false, map:3 }); const st = await tabB.next('start');
    const BB = require(path.join(ROOT, 'relay/game-core.js'));
    check('the game starts on that map', st.map === 3 && st.theme === BB.MAPS[3].theme, JSON.stringify([st.map, st.theme]));
    let same = true; for(let i=0;i<6;i++){ const w = BB.makeWorld(); w.reset(null, null, 'normal', null, 2); same = same && w.read().theme === BB.MAPS[2].theme; }
    check('core: reset(map) builds that map every time', same);
    let fixed = true; for(let i=0;i<8;i++){ const w = BB.makeWorld(); w.reset(); fixed = fixed && w.mapMsg().map === 0; }
    check('core: no map given -> the first map, not a random one', fixed);
    for(const c of [host, host2, tabA, tabA2, tabB]) try{ c.ws.terminate(); }catch(e){}
  } catch(e){ check('server tests ran without error', false, e.message); }
  srv.kill();
}

function clientTests(){
  console.log('client: page code');
  const grab = re => { const m = HTML.match(re); if(!m) throw new Error('could not find '+re); return m[0]; };
  const src = [ grab(/function rid\(\)\{[^\n]*\n/), grab(/function wsSend\(o\)\{[^\n]*\n/), grab(/function leaveNet\(\)\{[^\n]*\n/),
                grab(/function connectServer\([\s\S]*?\n(?=\n|\/\/)/), grab(/function hostGame\(\)\{[\s\S]*?\n\}\n/), grab(/function joinGame\(\)\{[\s\S]*?\n\}\n/) ].join('\n');
  const cidDecl = HTML.match(/(?:let|const|var)\s+myCid\s*=[^\n]*\n/);
  const mapDecl = HTML.match(/let\s+menuMap\s*=[^\n]*\n/);
  check('page remembers the picked map (menuMap, persisted)', !!mapDecl && /localStorage/.test(mapDecl[0]));
  check('single-player starts on the picked map', /world\.reset\(controls, \[myColor\], diff, teams, menuMap\)/.test(HTML));
  check('host start sends the picked map', /k:'start'[^}]*map:menuMap/.test(HTML));
  check('both start panels have a map row', (HTML.match(/class="diffrow maprow"/g)||[]).length === 2);
  check('page keeps one stable device id (myCid, persisted)', !!cidDecl && /localStorage/.test(cidDecl[0]));
  const sockets = [];
  class FakeWS { constructor(){ this.readyState = 1; this.sent = []; sockets.push(this); } send(s){ this.sent.push(JSON.parse(s)); } close(){ this.readyState = 3; this.wasClosed = true; } }
  const els = {}; const doc = { getElementById: id => els[id] || (els[id] = { textContent:'', value:'JUD7', classList:{ toggle(){}, add(){}, remove(){} } }) };
  const ctx = { WebSocket: FakeWS, document: doc, localStorage: { getItem(){ return null; }, setItem(){} }, console,
    RELAY_URL:'wss://x', netRole:'off', mySlot:0, ws:null, myColor:'#f00', botCount:1, onServerMsg(){}, syncBots(){} };
  const vm = require('vm'); vm.createContext(ctx);
  try {
    vm.runInContext((cidDecl?cidDecl[0]:'') + src, ctx);
    vm.runInContext("joinGame(); for(const s of sockets) if(s.onopen) s.onopen(); joinGame(); for(const s of sockets) if(s.onopen && !s.sent.length) s.onopen();".split('sockets').join('__s'), Object.assign(ctx, { __s: sockets }));
    check('two taps on Join open two sockets', sockets.length === 2, sockets.length);
    check('the first socket is closed before the second opens', sockets[0].wasClosed === true);
    const cids = sockets.map(s => (s.sent[0]||{}).cid);
    check('both joins carry the same device id', cids[0] && cids[0] === cids[1], JSON.stringify(cids));
  } catch(e){ check('client code ran', false, e.message); }
}

(async () => { await serverTests(); clientTests(); console.log(fails ? '\n'+fails+' FAILED' : '\nall passed'); process.exit(fails?1:0); })();

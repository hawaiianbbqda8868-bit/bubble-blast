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
  const srv = spawn(process.execPath, [path.join(ROOT, 'relay/server.js')], { env: Object.assign({}, process.env, { PORT: String(port), GRACE_MS: '1500' }), stdio: ['ignore','pipe','pipe'] });
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
    for(const c of [host2, tabA2, tabB]) c.send({ k:'setready', ready:true }); await sleep(150);   // both must press 准备 first
    host2.send({ k:'start', diff:'easy', bots:2, teams:false, map:3 }); const st = await tabB.next('start');
    const BB = require(path.join(ROOT, 'relay/game-core.js'));
    check('the game starts on that map', st.map === 3 && st.theme === BB.MAPS[3].theme, JSON.stringify([st.map, st.theme]));
    let same = true; for(let i=0;i<6;i++){ const w = BB.makeWorld(); w.reset(null, null, 'normal', null, 2); same = same && w.read().theme === BB.MAPS[2].theme; }
    check('core: reset(map) builds that map every time', same);
    let fixed = true; for(let i=0;i<8;i++){ const w = BB.makeWorld(); w.reset(); fixed = fixed && w.mapMsg().map === 0; }
    check('core: no map given -> the first map, not a random one', fixed);
    for(const c of [host, host2, tabA, tabA2, tabB]) try{ c.ws.terminate(); }catch(e){}

    console.log('server: waiting room — profiles, READY, and a side of your own');
    const ann = client(url); await ann.open(); ann.send({ k:'create', cid:'ANN', color:'#f00', bots:2, name:'Ann', wins:5 }); const ja1 = await ann.next('joined');
    check('alone with bots: START needs no READY', await (async () => { ann.send({ k:'start' }); const m = await Promise.race([ann.next('start'), ann.next('notready')]); return m.k === 'start'; })());
    const bea = client(url); await bea.open(); bea.send({ k:'create', cid:'BEA', color:'#0f0', bots:2, name:'Bea', wins:0 }); const jb = await bea.next('joined');
    const cal = client(url); await cal.open(); cal.send({ k:'join', cid:'CAL', code:jb.code, name:'<Cal>', wins:12 }); await cal.next('joined'); await sleep(120);
    let lb2 = bea.last('lobby');
    check('lobby lists every seat with name, rank input and host flag', lb2.players.length === 2 && lb2.players[0].name === 'Bea' && lb2.players[0].host && lb2.players[1].name === '<Cal>' && lb2.players[1].wins === 12 && !lb2.players[1].host, JSON.stringify(lb2.players));
    check('nobody is ready at first', lb2.players.every(p => !p.ready));
    bea.send({ k:'start' }); let nr = await bea.next('notready');
    check('two humans: START refused until both READY', nr.waiting.length === 2, JSON.stringify(nr.waiting));
    bea.send({ k:'setready', ready:true }); await bea.next('lobby');
    bea.send({ k:'start' }); nr = await bea.next('notready');
    check('host ready alone is not enough', nr.waiting.join() === '<Cal>', JSON.stringify(nr.waiting));
    check('joiner sees who is ready', cal.last('lobby').players.find(p => p.name === 'Bea').ready === true);
    bea.send({ k:'setopts', teams:true, diff:'hard' }); await Promise.all([bea.next('lobby'), cal.next('lobby')]);
    lb2 = cal.last('lobby');
    check('teams on: settings reach the joiner, sides dealt evenly', lb2.teams === true && lb2.diff === 'hard' && lb2.players.map(p => p.team).sort().join() === '0,1', JSON.stringify(lb2));
    cal.send({ k:'setteam', team:lb2.players[0].team }); await Promise.all([bea.next('lobby'), cal.next('lobby')]);
    lb2 = cal.last('lobby');
    check('a player can pick the same side as the host', lb2.players[0].team === lb2.players[1].team, JSON.stringify(lb2.players.map(p => p.team)));
    cal.send({ k:'setready', ready:true }); await bea.next('lobby');
    bea.send({ k:'start' }); const st2 = await cal.next('start');
    const snap = await cal.next('state');
    const humans = snap.players.filter(p => p.isHuman && p.alive), bots = snap.players.filter(p => !p.isHuman && p.alive);
    check('game starts once everyone is READY', !!st2 && humans.length === 2);
    check('humans keep their chosen side; bots fill the other', humans.every(p => p.team === humans[0].team) && bots.length === 2 && bots.every(p => p.team !== humans[0].team), JSON.stringify(snap.players.filter(p => p.alive).map(p => [p.isHuman, p.team])));
    for(const c of [ann, bea, cal]) try{ c.ws.terminate(); }catch(e){}

    console.log('server: a tablet in the background keeps its seat, and gets it back');
    const dan = client(url); await dan.open(); dan.send({ k:'create', cid:'DAN', color:'#f00', bots:1, name:'Dan' }); const jd = await dan.next('joined');
    const eve = client(url); await eve.open(); eve.send({ k:'join', cid:'EVE', code:jd.code, name:'Eve' }); await eve.next('joined'); await sleep(100);
    eve.send({ k:'setready', ready:true }); await dan.next('lobby');
    eve.ws.terminate(); const lbAway = await dan.next('lobby');
    check('the host sees the dropped joiner as AWAY, seat kept', lbAway.n === 2 && lbAway.players[1].away === true && lbAway.players[1].name === 'Eve', JSON.stringify(lbAway.players));
    dan.send({ k:'setready', ready:true }); await dan.next('lobby'); dan.send({ k:'start' }); const nr2 = await dan.next('notready');
    check('START waits for the away player', nr2.waiting.join() === 'Eve', JSON.stringify(nr2.waiting));
    const eve2 = client(url); await eve2.open(); eve2.send({ k:'join', cid:'EVE', code:jd.code, name:'Eve' }); const je2 = await eve2.next('joined');
    await dan.next('lobby'); await sleep(60);
    check('she comes back to the same seat, still READY, flagged as back', je2.slot === 1 && je2.back === true && dan.last('lobby').players[1].ready === true && !dan.last('lobby').players[1].away, JSON.stringify([je2, dan.last('lobby').players[1]]));
    dan.ws.terminate(); const lbHostAway = await eve2.next('lobby');
    check('a dropped HOST does not close the room', lbHostAway.players[0].away === true && !eve2.last('closed'));
    const dan2 = client(url); await dan2.open(); dan2.send({ k:'join', cid:'DAN', code:jd.code, name:'Dan' }); const jd2 = await dan2.next('joined'); await sleep(80);
    dan2.send({ k:'setopts', diff:'hard' }); const lbBack = await dan2.next('lobby');
    check('the host returns to seat 0 with host powers', jd2.slot === 0 && lbBack.diff === 'hard' && !lbBack.players[0].away, JSON.stringify([jd2.slot, lbBack.diff]));
    dan2.send({ k:'start' }); await Promise.all([dan2.next('start'), eve2.next('start')]); await sleep(120);
    eve2.ws.terminate(); await sleep(150);
    const eve3 = client(url); await eve3.open(); eve3.send({ k:'join', cid:'EVE', code:jd.code, name:'Eve' }); const je3 = await eve3.next('joined'); const st3 = await eve3.next('start'); await eve3.next('state');
    check('mid-match: back into the running game with the map', je3.back === true && st3.grid && st3.grid.length > 0 && !dan2.last('closed'));
    const stranger = client(url); await stranger.open(); stranger.send({ k:'join', cid:'ZED', code:jd.code, name:'Zed' }); const jf = await stranger.next('joinfail');
    check('a newcomer still cannot join a running match', /already started/.test(jf.reason));
    dan2.ws.terminate(); const closedMsg = await eve3.next('closed', 5000);
    check('a host who never comes back closes the room after the grace period', !!closedMsg);
    for(const c of [dan, dan2, eve, eve2, eve3, stranger]) try{ c.ws.terminate(); }catch(e){}

    console.log('server: the host can kick');
    const fay = client(url); await fay.open(); fay.send({ k:'create', cid:'FAY', color:'#f00', bots:1, name:'Fay' }); const jfay = await fay.next('joined');
    const gus = client(url); await gus.open(); gus.send({ k:'join', cid:'GUS', code:jfay.code, name:'Gus' }); const jgus = await gus.next('joined');
    const hal = client(url); await hal.open(); hal.send({ k:'join', cid:'HAL', code:jfay.code, name:'Hal' }); await hal.next('joined'); await sleep(100);
    gus.send({ k:'kick', slot:2 }); await sleep(150);
    check('a joiner cannot kick', fay.last('lobby').n === 3);
    fay.send({ k:'kick', slot:jgus.slot }); const kicked = await gus.next('kicked'); await sleep(150);
    check('the host kicks Gus: he is told, the seat is freed', !!kicked && fay.last('lobby').n === 2 && !fay.last('lobby').players.some(p => p.name === 'Gus') && gus.closed, JSON.stringify(fay.last('lobby').players.map(p => p.name)));
    fay.send({ k:'kick', slot:0 }); await sleep(120);
    check('the host cannot kick themselves', fay.last('lobby').n === 2 && fay.last('lobby').players[0].name === 'Fay');
    for(const c of [fay, gus, hal]) try{ c.ws.terminate(); }catch(e){}
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
  check('both start panels have a map row', (HTML.match(/class="diffrow maprow( grid)?"/g)||[]).length === 2);
  check('host seats carry a kick button; a kicked page leaves', /data-kick=/.test(HTML) && /k:'kick', slot/.test(HTML) && /d\.k==='kicked'/.test(HTML));
  check('page rejoins its room when it comes back to the foreground', /visibilitychange/.test(HTML) && /function tryRejoin\(/.test(HTML) && /scheduleRejoin\(0\)/.test(HTML) && /k:'join', cid:myCid, code:roomCode/.test(HTML));
  check('profile: name persisted, sent with create and join', /localStorage\.getItem\('bnbName'\)/.test(HTML) && /k:'create'[^}]*name:myName/.test(HTML) && /k:'join'[^}]*name:myName/.test(HTML));
  check('both waiting rooms have a roster and a READY button', /id="hostRoster"/.test(HTML) && /id="joinRoster"/.test(HTML) && /id="hostReady"/.test(HTML) && /id="joinReady"/.test(HTML));
  try {
    const fn = new Function(grab(/function canStart\([^)]*\)\{[^\n]*\n/) + grab(/const RANKS = [^\n]*\n/) + grab(/function rankOf\([^)]*\)\{[^\n]*\n/) + 'return {canStart, rankOf};')();
    check('canStart: alone -> yes; two humans -> only when both ready', fn.canStart([{ready:false}]) && !fn.canStart([{ready:true},{ready:false}]) && fn.canStart([{ready:true},{ready:true}]));
    check('rankOf climbs with wins', fn.rankOf(0) !== fn.rankOf(3) && fn.rankOf(60).includes('泡泡王'));
  } catch(e){ check('client waiting-room helpers extract', false, e.message); }
  check('page keeps one stable device id (myCid, persisted)', !!cidDecl && /localStorage/.test(cidDecl[0]));
  const sockets = [];
  class FakeWS { constructor(){ this.readyState = 1; this.sent = []; sockets.push(this); } send(s){ this.sent.push(JSON.parse(s)); } close(){ this.readyState = 3; this.wasClosed = true; } }
  const els = {}; const doc = { getElementById: id => els[id] || (els[id] = { textContent:'', value:'JUD7', classList:{ toggle(){}, add(){}, remove(){} } }) };
  const ctx = { WebSocket: FakeWS, document: doc, localStorage: { getItem(){ return null; }, setItem(){} }, console,
    RELAY_URL:'wss://x', netRole:'off', mySlot:0, ws:null, myColor:'#f00', botCount:1, onServerMsg(){}, syncBots(){},
    myName:'Tab', myWins:0, menuMap:0, menuTeams:false, lobby:null, myReady:false, syncReadyBtns(){}, showJoinRoom(){} };
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

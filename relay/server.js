// Bubble Blast — authoritative game server.
// Runs one game world per room at 30Hz. Every player (host included) is a
// thin client: it sends input and receives state. No client runs the sim.
const { WebSocketServer } = require('ws');
const http = require('http');
const BB = require('./game-core.js');

const PORT = process.env.PORT || 8080;
const TICK_MS = 33;            // ~30 ticks/sec
const DT = 1 / 30;
const GRACE_MS = +process.env.GRACE_MS || 60000;   // how long a dropped player keeps their seat (a tablet in the background)

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bubble-blast server ok — core ' + BB.CORE_VERSION);   // check a deploy actually took
});
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> { code, conns:[{ws,cid,slot,color}], state, world, tick, diff }
function makeCode(){ const c='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function send(ws, o){ if(ws.readyState===1){ try{ ws.send(JSON.stringify(o)); }catch(e){} } }
function broadcast(room, o){ const s=JSON.stringify(o); for(const c of room.conns) if(c.ws.readyState===1){ try{ c.ws.send(s); }catch(e){} } }
const N_SLOTS = BB.MAX_SLOTS; // 8
function pickMap(v){ const i = v|0; return BB.MAPS[i] ? i : 0; }   // a known map index, never a roll
function pickTide(v){ const t = v|0; return BB.TIDE_CHOICES.includes(t) ? t : BB.TIDE_START; }   // when the first wall comes, 0 = never
function pickGap(v){ const g = v|0; return BB.TIDE_GAPS.includes(g) ? g : BB.TIDE_STEP; }        // and the calm between them
// The waiting room, as everyone sees it: every seat, who is ready, which team
// they picked, and the host's settings. Like 泡泡堂: players press 准备, only the
// host presses 开始, and only once every human is ready.
function lobbyInfo(room){
  const players = room.conns.map(c => ({ slot:c.slot, name:c.name, color:c.color, wins:c.wins|0, ready:!!c.ready, team:c.team, host:c.slot===0, away:!!c.away }))
    .sort((a,b) => a.slot-b.slot);
  return { k:'lobby', code:room.code, n:room.conns.length, bots:room.bots, cap:N_SLOTS-room.bots, state:room.state,
           map:room.map, diff:room.diff, teams:!!room.teamMode, tide:room.tide, gap:room.gap, players };
}
function allReady(room){ return room.conns.length < 2 || room.conns.every(c => c.ready && !c.away); }
function notReady(room){ return room.conns.filter(c => !c.ready || c.away).map(c => c.name); }
function cleanName(v){ const t = String(v==null?'':v).replace(/[\u0000-\u001f]/g,'').trim().slice(0, 14); return t || 'Sailor'; }
// With teams on, every human keeps the side they picked (a new joiner lands on
// the smaller side); bots fill in so the two sides come out as even as possible.
function balanceTeams(room){
  if (!room.teamMode) return;
  for (const c of room.conns) if (c.team!==0 && c.team!==1) c.team = teamSize(room,0) <= teamSize(room,1) ? 0 : 1;
}
function teamSize(room, t){ return room.conns.filter(c => c.team===t).length; }
function buildControls(room){
  const controls = new Array(N_SLOTS).fill('none'), colors = [];
  for(const c of room.conns){ if(c.slot>=0 && c.slot<N_SLOTS){ controls[c.slot]='remote'; colors[c.slot]=c.color; } } // humans
  let need = room.bots || 0;
  for(let s=0;s<N_SLOTS && need>0;s++){ if(controls[s]==='none'){ controls[s]='ai'; need--; } }              // bots into empty seats
  let teams = null;
  if(room.teamMode){ teams = new Array(N_SLOTS).fill(null);
    balanceTeams(room);
    const size = [0, 0];
    for(const c of room.conns){ teams[c.slot] = c.team; size[c.team]++; }                                   // humans: the side they chose
    for(let s=0;s<N_SLOTS;s++) if(controls[s]==='ai'){ const t = size[0] <= size[1] ? 0 : 1; teams[s]=t; size[t]++; } } // bots even it out
  return { controls, colors, teams };
}
function beginGame(room){
  const { controls, colors, teams } = buildControls(room);
  room.world = BB.makeWorld();
  room.world.reset(controls, colors, room.diff||'normal', teams, room.map, { tide:room.tide, gap:room.gap });
  room.state = 'playing';
  broadcast(room, Object.assign({ k:'start', tm:!!room.teamMode }, room.world.mapMsg()));
  startTick(room);
}
function startTick(room){
  if(room.tick) return;
  room.tick = setInterval(() => {
    room.world.update(DT);
    broadcast(room, Object.assign({ k:'state' }, room.world.snapshot()));
    if(room.world.gameState === 'over'){ room.state='over'; clearInterval(room.tick); room.tick=null; }
  }, TICK_MS);
}
// One seat per device. A tablet that taps Join twice, or comes back after Safari
// dropped its socket while the screen slept, arrives on a NEW socket while the
// server may still hold the old one — for up to a minute until the ping sweep
// notices. Without this, the same person was counted twice ("Humans: 3" with two
// tablets) and the ghost seat went into the game as a sailor nobody controls.
function evictGhost(room, ws, cid){
  if (!cid) return null;
  const old = room.conns.find(c => c.cid === cid && c.ws !== ws);
  if (!old) return null;
  room.conns = room.conns.filter(c => c !== old);
  try { old.ws.terminate(); } catch {}
  return old;
}
function seat(room, ws, m, slot, back){                // back: the seat this device is returning to (keeps READY and its side)
  ws.cid = m.cid; ws.roomCode = room.code; ws.slot = slot; ws.color = m.color || BB.PALETTE[slot % BB.PALETTE.length];
  room.conns.push({ ws, cid:ws.cid, slot, color:ws.color, name:cleanName(m.name), wins:Math.max(0, m.wins|0), ready:!!(back && back.ready), team:back ? back.team : null });
  balanceTeams(room);
  send(ws, { k:'joined', code:room.code, slot, back:!!back });
  broadcast(room, lobbyInfo(room));
}
function closeRoom(room){ if(room.tick){ clearInterval(room.tick); room.tick=null; } rooms.delete(room.code); }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }

    if (m.k === 'list') {
      const list = [];
      for (const r of rooms.values()) if (r.state === 'lobby') list.push({ code:r.code, n:r.conns.length, cap:N_SLOTS - r.bots, map:r.map, teams:!!r.teamMode });
      send(ws, { k:'rooms', rooms:list });
      return;
    }
    if ((m.k === 'create' || m.k === 'join') && ws.roomCode && rooms.has(ws.roomCode)) {
      const cur = rooms.get(ws.roomCode);                        // this socket is already seated: just re-send where it sits
      if (cur.conns.some(c => c.ws === ws)) { send(ws, { k:'joined', code:cur.code, slot:ws.slot }); send(ws, lobbyInfo(cur)); return; }
    }
    if (m.k === 'create') {
      let code; do { code = makeCode(); } while (rooms.has(code));
      const room = { code, conns:[], state:'lobby', world:null, tick:null, diff:'normal', teamMode:!!m.teams, bots:Math.min(7,Math.max(0, m.bots==null?3:m.bots)), map:pickMap(m.map), tide:pickTide(m.tide==null?BB.TIDE_START:m.tide), gap:pickGap(m.gap==null?BB.TIDE_STEP:m.gap) };
      rooms.set(code, room);
      seat(room, ws, m, 0);
      return;
    }
    if (m.k === 'join') {
      const room = rooms.get(String(m.code||'').toUpperCase());
      if (!room) { send(ws, { k:'joinfail', reason:'Room not found — check the code.' }); return; }
      const mine = room.conns.find(c => c.cid === m.cid);
      if (room.state !== 'lobby' && !mine) { send(ws, { k:'joinfail', reason:'That game already started.' }); return; }
      const ghost = evictGhost(room, ws, m.cid);       // same device re-joining: its old seat is free again
      if (!ghost && room.conns.length >= (N_SLOTS - room.bots)) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      const used = new Set(room.conns.map(c => c.slot));
      let slot = ghost ? ghost.slot : -1;
      if (slot < 0) for (let s=0; s<N_SLOTS; s++) if (!used.has(s)) { slot = s; break; }
      if (slot < 0) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      seat(room, ws, m, slot, ghost);
      if (room.state === 'playing' && room.world) send(ws, Object.assign({ k:'start', tm:!!room.teamMode }, room.world.mapMsg()));   // back into the match
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.conns.find(c => c.ws === ws);
    if (m.k === 'kick') {                               // the host shows someone the door (a seat that went quiet, or a stranger)
      if (ws.slot === 0 && room.state === 'lobby') {
        const t = room.conns.find(c => c.slot === (m.slot|0) && c.slot !== 0);
        if (t) { room.conns = room.conns.filter(c => c !== t); send(t.ws, { k:'kicked' }); try { t.ws.close(); } catch {} balanceTeams(room); broadcast(room, lobbyInfo(room)); }
      } return; }
    if (m.k === 'setready') { if (me && room.state === 'lobby') { me.ready = !!m.ready; broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'setteam') { if (me && room.state === 'lobby' && room.teamMode && (m.team===0 || m.team===1)) { me.team = m.team; broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'profile') { if (me) { me.name = cleanName(m.name); me.wins = Math.max(0, m.wins|0); if (m.color) { me.color = ws.color = m.color; } broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'setopts') { if (ws.slot === 0 && room.state === 'lobby') {
      if (m.diff && ['easy','normal','hard'].includes(m.diff)) room.diff = m.diff;
      if (m.teams != null) { room.teamMode = !!m.teams; balanceTeams(room); }
      if (m.map != null) room.map = pickMap(m.map);
      if (m.tide != null) room.tide = pickTide(m.tide);
      if (m.gap != null) room.gap = pickGap(m.gap);
      if (m.bots != null) room.bots = Math.min(N_SLOTS - room.conns.length, Math.max(0, m.bots|0));
      broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'setmap') { if (ws.slot === 0 && room.state === 'lobby') { room.map = pickMap(m.map); broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'setbots') { if (ws.slot === 0 && room.state === 'lobby') { room.bots = Math.min(N_SLOTS - room.conns.length, Math.max(0, m.bots||0)); broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'start' || m.k === 'restart') { if (ws.slot === 0) {
      if (m.bots!=null) room.bots = Math.min(N_SLOTS - room.conns.length, Math.max(0, m.bots)); if (m.teams!=null) room.teamMode = !!m.teams; if (m.map!=null) room.map = pickMap(m.map); if (m.tide!=null) room.tide = pickTide(m.tide); if (m.gap!=null) room.gap = pickGap(m.gap); room.diff = m.diff || room.diff;
      if (room.state === 'lobby' && !allReady(room)) { send(ws, { k:'notready', waiting:notReady(room) }); return; }   // 开始 only when everyone pressed 准备 (and is here)
      beginGame(room); } return; }
    if (m.k === 'input') { if (room.world && room.state === 'playing') room.world.setInput(ws.slot, { dir:m.dir, bomb:m.bomb, tap:m.tap, half:m.half, seq:m.seq }); return; }
  });
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    const c = room.conns.find(c => c.ws === ws); if (!c) return;   // already evicted (device re-joined on a new socket)
    // A tablet sent to the background drops its socket. Keep the seat for a
    // while: the page rejoins with the same id when it comes back, and takes
    // the seat over — READY state, side and all. The sweep below frees seats
    // nobody came back for (a host's absence closes the room, as before).
    c.away = true; c.awayAt = Date.now();
    broadcast(room, lobbyInfo(room));
  });
  ws.on('error', () => {});
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }); }, 10000);   // a silent tablet shows as away within ~20s
setInterval(() => {                                  // free the seats of players who never came back
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const gone = room.conns.filter(c => c.away && now - c.awayAt > GRACE_MS);
    if (!gone.length) continue;
    room.conns = room.conns.filter(c => !gone.includes(c));
    if (!room.conns.length || gone.some(c => c.slot === 0)) { broadcast(room, { k:'closed' }); closeRoom(room); continue; }
    balanceTeams(room);
    broadcast(room, lobbyInfo(room));
  }
}, Math.min(5000, GRACE_MS));
server.listen(PORT, () => console.log('bubble-blast game server on ' + PORT));

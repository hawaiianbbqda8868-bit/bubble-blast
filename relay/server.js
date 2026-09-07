// Bubble Blast — authoritative game server.
// Runs one game world per room at 30Hz. Every player (host included) is a
// thin client: it sends input and receives state. No client runs the sim.
const { WebSocketServer } = require('ws');
const http = require('http');
const BB = require('./game-core.js');

const PORT = process.env.PORT || 8080;
const TICK_MS = 33;            // ~30 ticks/sec
const DT = 1 / 30;

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
function lobbyInfo(room){ return { k:'lobby', code:room.code, n:room.conns.length, bots:room.bots, cap:N_SLOTS-room.bots, state:room.state, map:room.map }; }
function buildControls(room){
  const controls = new Array(N_SLOTS).fill('none'), colors = [];
  for(const c of room.conns){ if(c.slot>=0 && c.slot<N_SLOTS){ controls[c.slot]='remote'; colors[c.slot]=c.color; } } // humans
  let need = room.bots || 0;
  for(let s=0;s<N_SLOTS && need>0;s++){ if(controls[s]==='none'){ controls[s]='ai'; need--; } }              // bots into empty seats
  let teams = null;
  if(room.teamMode){ teams = new Array(N_SLOTS).fill(null); let k=0;
    for(let s=0;s<N_SLOTS;s++){ if(controls[s]!=='none'){ teams[s]=k%2; k++; } } }                          // auto-split into 2 teams
  return { controls, colors, teams };
}
function beginGame(room){
  const { controls, colors, teams } = buildControls(room);
  room.world = BB.makeWorld();
  room.world.reset(controls, colors, room.diff||'normal', teams, room.map);
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
function seat(room, ws, m, slot){
  ws.cid = m.cid; ws.roomCode = room.code; ws.slot = slot; ws.color = m.color || BB.PALETTE[slot % BB.PALETTE.length];
  room.conns.push({ ws, cid:ws.cid, slot, color:ws.color });
  send(ws, { k:'joined', code:room.code, slot });
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
      for (const r of rooms.values()) if (r.state === 'lobby') list.push({ code:r.code, n:r.conns.length });
      send(ws, { k:'rooms', rooms:list });
      return;
    }
    if ((m.k === 'create' || m.k === 'join') && ws.roomCode && rooms.has(ws.roomCode)) {
      const cur = rooms.get(ws.roomCode);                        // this socket is already seated: just re-send where it sits
      if (cur.conns.some(c => c.ws === ws)) { send(ws, { k:'joined', code:cur.code, slot:ws.slot }); send(ws, lobbyInfo(cur)); return; }
    }
    if (m.k === 'create') {
      let code; do { code = makeCode(); } while (rooms.has(code));
      const room = { code, conns:[], state:'lobby', world:null, tick:null, diff:'normal', teamMode:!!m.teams, bots:Math.min(7,Math.max(0, m.bots==null?3:m.bots)), map:pickMap(m.map) };
      rooms.set(code, room);
      seat(room, ws, m, 0);
      return;
    }
    if (m.k === 'join') {
      const room = rooms.get(String(m.code||'').toUpperCase());
      if (!room) { send(ws, { k:'joinfail', reason:'Room not found — check the code.' }); return; }
      if (room.state !== 'lobby') { send(ws, { k:'joinfail', reason:'That game already started.' }); return; }
      const ghost = evictGhost(room, ws, m.cid);       // same device re-joining: its old seat is free again
      if (!ghost && room.conns.length >= (N_SLOTS - room.bots)) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      const used = new Set(room.conns.map(c => c.slot));
      let slot = ghost ? ghost.slot : -1;
      if (slot < 0) for (let s=0; s<N_SLOTS; s++) if (!used.has(s)) { slot = s; break; }
      if (slot < 0) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      seat(room, ws, m, slot);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (m.k === 'setmap') { if (ws.slot === 0 && room.state === 'lobby') { room.map = pickMap(m.map); broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'setbots') { if (ws.slot === 0 && room.state === 'lobby') { room.bots = Math.min(N_SLOTS - room.conns.length, Math.max(0, m.bots||0)); broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'start' || m.k === 'restart') { if (ws.slot === 0) { if (m.bots!=null) room.bots = Math.min(N_SLOTS - room.conns.length, Math.max(0, m.bots)); if (m.teams!=null) room.teamMode = !!m.teams; if (m.map!=null) room.map = pickMap(m.map); room.diff = m.diff || room.diff; beginGame(room); } return; }
    if (m.k === 'input') { if (room.world && room.state === 'playing') room.world.setInput(ws.slot, { dir:m.dir, bomb:m.bomb, tap:m.tap, half:m.half, seq:m.seq }); return; }
  });
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    if (!room.conns.some(c => c.ws === ws)) return;   // already evicted (device re-joined on a new socket)
    const wasHost = ws.slot === 0;
    room.conns = room.conns.filter(c => c.ws !== ws);
    if (!room.conns.length || wasHost) { broadcast(room, { k:'closed' }); closeRoom(room); return; }
    broadcast(room, lobbyInfo(room));
  });
  ws.on('error', () => {});
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }); }, 30000);
server.listen(PORT, () => console.log('bubble-blast game server on ' + PORT));

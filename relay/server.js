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
  res.end('bubble-blast server ok');
});
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> { code, conns:[{ws,cid,slot,color}], state, world, tick, diff }
function makeCode(){ const c='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function send(ws, o){ if(ws.readyState===1){ try{ ws.send(JSON.stringify(o)); }catch(e){} } }
function broadcast(room, o){ const s=JSON.stringify(o); for(const c of room.conns) if(c.ws.readyState===1){ try{ c.ws.send(s); }catch(e){} } }
function lobbyInfo(room){ return { k:'lobby', code:room.code, n:room.conns.length, max:room.max, state:room.state }; }
function buildControls(room){
  const max = room.max || 4;
  const controls = ['none','none','none','none'], colors = [];
  for(let s=0;s<max;s++) controls[s]='ai';                 // active empty seats -> bots
  for(const c of room.conns){ if(c.slot>=0 && c.slot<max){ controls[c.slot]='remote'; colors[c.slot]=c.color; } }
  return { controls, colors };
}
function beginGame(room){
  const { controls, colors } = buildControls(room);
  room.world = BB.makeWorld();
  room.world.reset(controls, colors, room.diff||'normal');
  room.state = 'playing';
  broadcast(room, Object.assign({ k:'start' }, room.world.mapMsg()));
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
    if (m.k === 'create') {
      let code; do { code = makeCode(); } while (rooms.has(code));
      const room = { code, conns:[], state:'lobby', world:null, tick:null, diff:'normal', max:Math.min(4,Math.max(2,m.max||4)) };
      rooms.set(code, room);
      ws.cid = m.cid; ws.roomCode = code; ws.slot = 0; ws.color = m.color || BB.PALETTE[0];
      room.conns.push({ ws, cid:ws.cid, slot:0, color:ws.color });
      send(ws, { k:'joined', code, slot:0 });
      broadcast(room, lobbyInfo(room));
      return;
    }
    if (m.k === 'join') {
      const room = rooms.get(String(m.code||'').toUpperCase());
      if (!room) { send(ws, { k:'joinfail', reason:'Room not found — check the code.' }); return; }
      if (room.state !== 'lobby') { send(ws, { k:'joinfail', reason:'That game already started.' }); return; }
      if (room.conns.length >= room.max) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      const used = new Set(room.conns.map(c => c.slot));
      let slot = -1; for (let s=1; s<=3; s++) if (!used.has(s)) { slot = s; break; }
      if (slot < 0) { send(ws, { k:'joinfail', reason:'Room is full.' }); return; }
      ws.cid = m.cid; ws.roomCode = room.code; ws.slot = slot; ws.color = m.color || BB.PALETTE[slot % BB.PALETTE.length];
      room.conns.push({ ws, cid:ws.cid, slot, color:ws.color });
      send(ws, { k:'joined', code:room.code, slot });
      broadcast(room, lobbyInfo(room));
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (m.k === 'setmax') { if (ws.slot === 0 && room.state === 'lobby') { room.max = Math.min(4, Math.max(2, Math.max(room.conns.length, m.max||4))); broadcast(room, lobbyInfo(room)); } return; }
    if (m.k === 'start' || m.k === 'restart') { if (ws.slot === 0) { if (m.max) room.max = Math.min(4, Math.max(2, Math.max(room.conns.length, m.max))); beginGame(room); } return; }
    if (m.k === 'input') { if (room.world && room.state === 'playing') room.world.setInput(ws.slot, { dir:m.dir, bomb:m.bomb }); return; }
  });
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    const wasHost = ws.slot === 0;
    room.conns = room.conns.filter(c => c.ws !== ws);
    if (!room.conns.length || wasHost) { broadcast(room, { k:'closed' }); closeRoom(room); return; }
    broadcast(room, lobbyInfo(room));
  });
  ws.on('error', () => {});
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }); }, 30000);
server.listen(PORT, () => console.log('bubble-blast game server on ' + PORT));

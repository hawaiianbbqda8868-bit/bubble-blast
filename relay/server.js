// Bubble Blast — tiny room relay (WebSocket).
// Pure message relay: a client sends {k:'join',room} to subscribe, then every
// other message is rebroadcast to the other members of that room. No game logic.
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Health-check endpoint so Railway sees the service as up.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bubble-blast relay ok');
});
const wss = new WebSocketServer({ server });

const rooms = new Map(); // room -> Set<ws>
const ads = new Map();   // ws -> {code, n, t}  (open rooms advertised by hosts)
function leave(ws) {
  const r = rooms.get(ws.room);
  if (r) { r.delete(ws); if (!r.size) rooms.delete(ws.room); }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.k === 'join') {
      leave(ws);
      ws.room = String(m.room || '').slice(0, 64);
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      rooms.get(ws.room).add(ws);
      return;
    }
    if (m.k === 'advertise') { ads.set(ws, { code: String(m.code || '').slice(0, 8), n: m.n || 1, t: Date.now() }); return; }
    if (m.k === 'unadvertise') { ads.delete(ws); return; }
    if (m.k === 'list') {
      const now = Date.now(), list = [];
      for (const a of ads.values()) if (now - a.t < 8000) list.push({ code: a.code, n: a.n });
      try { ws.send(JSON.stringify({ k: 'rooms', rooms: list })); } catch {}
      return;
    }
    const peers = rooms.get(ws.room);
    if (!peers) return;
    const s = typeof data === 'string' ? data : data.toString();
    for (const p of peers) if (p !== ws && p.readyState === 1) p.send(s);
  });
  ws.on('close', () => { ads.delete(ws); leave(ws); });
  ws.on('error', () => { ads.delete(ws); leave(ws); });
});

// Drop dead connections so rooms don't leak.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { leave(ws); return ws.terminate(); }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

server.listen(PORT, () => console.log('bubble-blast relay listening on ' + PORT));

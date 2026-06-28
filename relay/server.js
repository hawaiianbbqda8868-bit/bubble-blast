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
    const peers = rooms.get(ws.room);
    if (!peers) return;
    const s = typeof data === 'string' ? data : data.toString();
    for (const p of peers) if (p !== ws && p.readyState === 1) p.send(s);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
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

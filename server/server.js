'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_PEERS = 8;

function createServer({ port = 8787, webRoot = path.join(__dirname, '..', 'web'), sharedRoot = path.join(__dirname, '..', 'shared') } = {}) {
  const rooms = new Map(); // code -> {peers:Set<ws>, url, state}
  let nextId = 1;

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname.includes('\0')) { res.writeHead(400).end(); return; }
    if (pathname === '/healthz') { res.end('ok'); return; }
    let file;
    if (pathname === '/media-sync.js' || pathname === '/room-client.js') file = path.join(sharedRoot, pathname);
    else file = path.join(webRoot, pathname === '/' ? 'index.html' : pathname);
    const base = pathname.startsWith('/media-sync') || pathname.startsWith('/room-client') ? sharedRoot : webRoot;
    if (!path.resolve(file).startsWith(path.resolve(base) + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf);
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

  function broadcast(room, msg, except) {
    const data = JSON.stringify(msg);
    for (const p of room.peers) if (p !== except && p.readyState === 1) p.send(data);
  }
  const peerInfo = (room) => ({ t: 'peers', peers: room.peers.size, names: [...room.peers].map((p) => p.name) });

  wss.on('connection', (ws) => {
    ws.on('error', () => {}); // e.g. oversize frame: ws closes the socket; an unhandled 'error' would crash the process
    ws.id = nextId++;
    ws.name = 'guest';
    ws.room = null;
    let budget = 40, lastRefill = Date.now(); // crude per-socket rate limit

    ws.on('message', (raw) => {
      const now = Date.now();
      budget = Math.min(40, budget + ((now - lastRefill) / 1000) * 20);
      lastRefill = now;
      if (budget < 1) return; // flooding: drop, and recover once the client calms down
      budget--;
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'sync') { ws.send(JSON.stringify({ t: 'sync', c: m.c, s: Date.now() })); return; }

      if (m.t === 'join') {
        if (ws.room || typeof m.room !== 'string' || !ROOM_RE.test(m.room)) { ws.close(1008, 'bad room'); return; }
        let room = rooms.get(m.room);
        if (!room) rooms.set(m.room, (room = { peers: new Set(), url: null, state: null, leader: null }));
        if (room.peers.size >= MAX_PEERS) { ws.close(1008, 'room full'); return; }
        ws.name = String(m.name || 'guest').slice(0, 24);
        ws.room = room;
        ws.code = m.room;
        room.peers.add(ws);
        ws.send(JSON.stringify({ t: 'joined', id: ws.id, ...peerInfo(room) }));
        if (room.url) ws.send(JSON.stringify({ t: 'nav', url: room.url }));
        if (room.state) ws.send(JSON.stringify({ t: 'state', ...room.state }));
        broadcast(room, peerInfo(room));
        return;
      }

      const room = ws.room;
      if (!room) return;

      if (m.t === 'state') {
        if (typeof m.playing !== 'boolean' || !Number.isFinite(m.time) || m.time < 0) return;
        if (m.hb) { if (room.leader !== null && room.leader !== ws.id) return; } // stale heartbeat from a previous leader
        else room.leader = ws.id;
        const rate = Number.isFinite(m.rate) && m.rate > 0 && m.rate <= 4 ? m.rate : 1;
        room.state = { playing: m.playing, time: m.time, rate, at: Date.now() };
        broadcast(room, { t: 'state', ...room.state, from: ws.id, hb: !!m.hb }, ws);
      } else if (m.t === 'nav') {
        if (typeof m.url !== 'string' || m.url.length > 2048 || !/^https?:\/\//i.test(m.url)) return;
        room.url = m.url;
        room.leader = null;
        room.state = null; // new page: previous playback position is meaningless
        broadcast(room, { t: 'nav', url: m.url, from: ws.id }, ws);
      }
    });

    ws.on('close', () => {
      const room = ws.room;
      if (!room) return;
      room.peers.delete(ws);
      if (room.peers.size === 0) rooms.delete(ws.code);
      else broadcast(room, peerInfo(room));
    });
  });

  return {
    server, wss, rooms,
    listen: () => new Promise((r) => server.listen(port, () => r(server.address().port))),
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(() => server.close(() => r())); }),
  };
}

module.exports = { createServer };

if (require.main === module) {
  const s = createServer({ port: +process.env.PORT || 8787 });
  s.listen().then((p) => console.log(`SyncWatch relay + web client on :${p}`));
}

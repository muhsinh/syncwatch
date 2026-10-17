const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { createServer } = require('../server/server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (port) => new Promise((r, j) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on('open', () => r(w)); w.on('error', j); });
const rawGet = (port, p) => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)); let d = ''; s.on('data', (c) => (d += c)); s.on('close', () => r(d)); });

test('server survives garbage, floods, oversize frames and keeps serving', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  const bad = await open(port);
  for (const g of ['', 'null', '[]', '42', '{"t":', '{"t":"state"}', '\u0000\u0001', '{"t":"nav","url":5}']) bad.send(g);
  bad.send(Buffer.from([0, 1, 2, 3]));
  for (let i = 0; i < 2000; i++) bad.send('{"t":"state","playing":true,"time":1}'); // flood before join: ignored
  await wait(2200); // limiter recovers after the flood stops
  bad.send(JSON.stringify({ t: 'join', room: 'flood-room' }));
  await wait(50);
  assert.equal(srv.rooms.get('flood-room').peers.size, 1);
  const dbl = await open(port); const dblClosed = new Promise((r) => dbl.on('close', r));
  dbl.send(JSON.stringify({ t: 'join', room: 'dbl-room' }));
  dbl.send(JSON.stringify({ t: 'join', room: 'flood-room' })); // joining twice is a protocol error
  assert.equal(await dblClosed, 1008);
  await wait(50);
  assert.equal(srv.rooms.get('flood-room').peers.size, 1, 'failed double-join must not add membership');
  assert.equal(srv.rooms.has('dbl-room'), false);

  for (const badJoin of ['{"t":"join"}', '{"t":"join","room":{"a":1}}', '{"t":"join","room":"../../etc"}']) {
    const w = await open(port); const c = new Promise((r) => w.on('close', r));
    w.send(badJoin);
    assert.equal(await c, 1008, badJoin);
  }

  const big = await open(port);
  const closed = new Promise((r) => big.on('close', r));
  big.send('x'.repeat(100000));
  assert.equal(await closed, 1009);

  const peer = await open(port); const got = [];
  peer.on('message', (d) => got.push(JSON.parse(d)));
  peer.send(JSON.stringify({ t: 'join', room: 'flood-room' }));
  await wait(50);
  for (let i = 0; i < 500; i++) bad.send(JSON.stringify({ t: 'state', playing: true, time: i, rate: 1 }));
  await wait(200);
  const relayed = got.filter((m) => m.t === 'state').length;
  assert.ok(relayed > 0 && relayed < 120, `rate limit should bound flood, relayed ${relayed}`);
  // weird values
  bad.send(JSON.stringify({ t: 'state', playing: true, time: 1e308, rate: 'fast' }));
  bad.send(JSON.stringify({ t: 'state', playing: true, time: NaN, rate: 1 }));
  await wait(50);
  assert.ok(srv.wss.clients.size >= 2);
  const ok = await open(port); ok.close(); // still accepting
  [bad, peer].forEach((w) => w.close());
  await srv.close();
});

test('room caps, empty-room cleanup, and name/url limits', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  const peers = [];
  for (let i = 0; i < 8; i++) { const w = await open(port); w.send(JSON.stringify({ t: 'join', room: 'cap-room', name: 'n'.repeat(500) })); peers.push(w); }
  await wait(100);
  assert.equal(srv.rooms.get('cap-room').peers.size, 8);
  assert.equal([...srv.rooms.get('cap-room').peers][0].name.length, 24);
  const ninth = await open(port);
  const code = new Promise((r) => ninth.on('close', r));
  ninth.send(JSON.stringify({ t: 'join', room: 'cap-room' }));
  assert.equal(await code, 1008);
  peers[0].send(JSON.stringify({ t: 'nav', url: 'https://x.com/' + 'a'.repeat(3000) })); // too long: rejected
  peers[0].send(JSON.stringify({ t: 'nav', url: 'file:///etc/passwd' })); // non-http: rejected
  peers[0].send(JSON.stringify({ t: 'nav', url: 'http://[::1]:3000/ok' }));
  await wait(100);
  assert.equal(srv.rooms.get('cap-room').url, 'http://[::1]:3000/ok');
  peers.forEach((w) => w.close());
  await wait(150);
  assert.equal(srv.rooms.has('cap-room'), false, 'empty rooms are garbage collected');
  await srv.close();
});

test('static server: no path traversal, healthz, 404s', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server/server.js', '/media-sync.js/../../package.json', '/%00', '/%E0%A4%A']) {
    const r = await rawGet(port, p);
    assert.doesNotMatch(r, /"name": "syncwatch"|createServer/, 'leaked file via ' + p);
  }
  assert.match(await rawGet(port, '/healthz'), /\r\n\r\nok$/);
  assert.match(await rawGet(port, '/media-sync.js'), /createMediaSync/);
  assert.match(await rawGet(port, '/nope'), /404/);
  await srv.close();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../server/server');
const { createMediaSync } = require('../shared/media-sync');
const { createRoomClient } = require('../shared/room-client');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error('timeout');
}

function fakeMedia(duration = 600) {
  const l = {};
  const el = {
    paused: true, ended: false, currentTime: 0, playbackRate: 1, duration, readyState: 4,
    addEventListener: (n, f) => (l[n] ||= []).push(f),
    emit: (n) => (l[n] || []).forEach((f) => f()),
    play() { el.paused = false; setTimeout(() => el.emit('play'), 1); return Promise.resolve(); },
    pause() { el.paused = true; setTimeout(() => el.emit('pause'), 1); },
  };
  return el;
}

test('media engine: remote play/seek applied without echoing back', async () => {
  const sent = [];
  const sync = createMediaSync({ send: (m) => sent.push(m) });
  const el = fakeMedia();
  sync.attach(el);
  sync.onRemote({ playing: true, time: 100, rate: 1, at: Date.now() - 2000 }); // started 2s ago
  assert.equal(el.paused, false);
  assert.ok(Math.abs(el.currentTime - 102) < 0.2, `currentTime ${el.currentTime}`);
  await wait(30);
  assert.equal(sent.length, 0, 'applying remote state must not echo');
  el.currentTime = 300; el.emit('seeked'); // genuine local action after suppression window
  sync.stop();
});

test('media engine: local user action is reported after suppress window', async () => {
  const sent = [];
  const sync = createMediaSync({ send: (m) => sent.push(m) });
  const el = fakeMedia();
  sync.attach(el);
  el.play(); await wait(10);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].playing, sent[0].time], [true, 0]);
  sync.stop();
});

test('media engine: ignores short ad-like clips and applies state to late media', () => {
  const sync = createMediaSync({ send() {} });
  const ad = fakeMedia(15);
  sync.attach(ad);
  sync.onRemote({ playing: true, time: 5, rate: 1, at: Date.now() });
  assert.equal(ad.paused, true);
  const movie = fakeMedia(5400);
  sync.attach(movie); // appears after remote state was received
  assert.equal(movie.paused, false);
  sync.stop();
});

test('server + clients: state, nav, late joiner, clock offset', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  const url = `ws://127.0.0.1:${port}`;
  const inbox = { a: [], b: [], c: [] };
  const mk = (k, name) => {
    const c = createRoomClient({ WebSocketImpl: WebSocket, onMessage: (m) => inbox[k].push(m), onStatus() {} });
    c.connect({ url, room: 'test-room', name });
    return c;
  };
  const a = mk('a', 'alice'), b = mk('b', 'bob');
  await until(() => inbox.a.some((m) => m.t === 'peers' && m.peers === 2));

  a.send({ t: 'nav', url: 'https://example.com/movie' });
  await until(() => inbox.b.find((m) => m.t === 'nav'));
  a.send({ t: 'state', playing: true, time: 12.5, rate: 1 });
  const st = await until(() => inbox.b.find((m) => m.t === 'state'));
  assert.equal(st.time, 12.5);
  assert.ok(Math.abs(st.at - Date.now()) < 500, 'at converted to local clock');
  assert.equal(inbox.a.some((m) => m.t === 'state'), false, 'sender is not echoed');

  const c = mk('c', 'carol'); // late joiner gets current url + state
  await until(() => inbox.c.find((m) => m.t === 'state'));
  assert.equal(inbox.c.find((m) => m.t === 'nav').url, 'https://example.com/movie');

  a.send({ t: 'nav', url: 'javascript:alert(1)' }); // rejected
  a.send({ t: 'state', playing: 'yes', time: -1 }); // rejected
  await wait(100);
  assert.equal(inbox.b.filter((m) => m.t === 'nav').length, 1);

  [a, b, c].forEach((x) => x.close());
  await srv.close();
});

test('server: rejects bad room codes', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', room: 'x' }));
  const code = await new Promise((r) => ws.on('close', r));
  assert.equal(code, 1008);
  await srv.close();
});

test('media engine: user action right after remote update still goes out; heartbeats from rival leader ignored', async () => {
  const sent = [];
  const sync = createMediaSync({ send: (m) => sent.push(m) });
  const el = fakeMedia();
  sync.attach(el);
  sync.onRemote({ playing: true, time: 10, rate: 1, at: Date.now() });
  await wait(5);
  el.pause(); await wait(10); // user pauses within the suppress window
  assert.equal(sent.length, 1);
  assert.equal(sent[0].playing, false);
  // we are the leader now; a stale heartbeat from the previous leader must not move us
  el.currentTime = 50;
  sync.onRemote({ playing: true, time: 3, rate: 1, at: Date.now(), hb: true });
  assert.equal(el.currentTime, 50);
  assert.equal(el.paused, true);
  sync.stop();
});

test('server: heartbeat from non-leader is dropped, from leader relayed', async () => {
  const srv = createServer({ port: 0 });
  const port = await srv.listen();
  const got = [];
  const open = () => new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on('open', () => { w.send(JSON.stringify({ t: 'join', room: 'hb-test' })); r(w); }); w.on('message', (d) => got.push(JSON.parse(d))); });
  const a = await open(), b = await open();
  await wait(50);
  a.send(JSON.stringify({ t: 'state', playing: true, time: 5, rate: 1 }));
  await wait(30);
  b.send(JSON.stringify({ t: 'state', playing: true, time: 99, rate: 1, hb: true })); // b is not the leader
  a.send(JSON.stringify({ t: 'state', playing: true, time: 8, rate: 1, hb: true }));
  await wait(80);
  const states = got.filter((m) => m.t === 'state').map((m) => m.time);
  assert.deepEqual(states, [5, 8]);
  a.close(); b.close();
  await srv.close();
});

test('media engine: play pressed before metadata loads is sent once duration is known (movie) and dropped for ads', async () => {
  const sent = [];
  const sync = createMediaSync({ send: (m) => sent.push(m) });
  const mk = (dur) => { const e = fakeMedia(NaN); e.readyState = 0; e.finish = () => { e.duration = dur; e.readyState = 1; e.emit('loadedmetadata'); }; return e; };
  const movie = mk(5400), ad = mk(15);
  sync.attach(movie); sync.attach(ad);
  movie.play(); ad.play(); await wait(10);
  assert.equal(sent.length, 0);
  ad.finish(); movie.finish(); await wait(10);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].playing, true);
  sync.stop();
});

test('media engine: element already autoplaying when discovered is announced; paused room state wins over it', async () => {
  const sent = [];
  const sync = createMediaSync({ send: (m) => sent.push(m) });
  const auto = fakeMedia(); auto.paused = false; auto.currentTime = 12;
  sync.attach(auto); await wait(5);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].playing, sent[0].time], [true, 12]);
  sync.stop();

  const sent2 = [];
  const s2 = createMediaSync({ send: (m) => sent2.push(m) });
  s2.onRemote({ playing: false, time: 100, rate: 1, at: Date.now() });
  const auto2 = fakeMedia(); auto2.paused = false;
  s2.attach(auto2); await wait(5);
  assert.equal(auto2.paused, true);
  assert.equal(auto2.currentTime, 100);
  assert.equal(sent2.length, 0);
  s2.stop();
});

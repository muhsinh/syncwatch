// Real Electron app x3 (run under xvfb): relay + fake "movie site" with ad, cross-origin late-injected iframe player, SPA nav.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { _electron } = require('playwright-core');
const { createServer } = require('../../server/server');
const { startSite } = require('./fixtures');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await wait(100); }
  throw new Error('timeout ' + label);
}

let srv, site, relayPort;
const apps = [];
test.before(async () => {
  srv = createServer({ port: 0 });
  relayPort = await srv.listen();
  site = await startSite({ sitePort: 9201, playerPort: 9202 });
});
test.after(async () => { for (const a of apps) await a.close().catch(() => {}); site.close(); await srv.close(); });

async function launch(name, room) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-' + name + '-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '../../desktop/main.js'), '--no-sandbox', '--user-data-dir=' + dir],
  });
  apps.push(app);
  await app.firstWindow();
  const shell = await until(() => app.windows().find((w) => /index\.html$/.test(w.url())), 15000, 'shell window');
  await shell.waitForSelector('#connect');
  await shell.fill('#server', `ws://127.0.0.1:${relayPort}`);
  await shell.fill('#room', room);
  await shell.fill('#name', name);
  await shell.click('#connect');
  await until(() => shell.textContent('#status').then((s) => s.includes('In room')), 8000, name + ' connect');
  return { app, shell, name };
}

// state of every <video> in every frame of the content view
const mediaState = (d) => d.app.evaluate(async ({ webContents }) => {
  const wc = webContents.getAllWebContents().find((w) => /^https?:/.test(w.getURL()) && !/youtube/.test(w.getURL()));
  if (!wc) return null;
  const out = [];
  for (const f of wc.mainFrame.framesInSubtree) {
    const r = await f.executeJavaScript(`[...document.querySelectorAll('video,audio')].map(v=>({id:v.id,paused:v.paused,t:v.currentTime,dur:v.duration}))`).catch(() => []);
    out.push(...r);
  }
  return { url: wc.getURL(), media: out };
});
const player = async (d) => (await mediaState(d))?.media.find((m) => m.id === 'player');
const runInPlayer = (d, code) => d.app.evaluate(async ({ webContents }, code) => {
  const wc = webContents.getAllWebContents().find((w) => /^https?:/.test(w.getURL()) && !/youtube/.test(w.getURL()));
  for (const f of wc.mainFrame.framesInSubtree) {
    if (await f.executeJavaScript(`!!document.getElementById('player')`).catch(() => false)) return f.executeJavaScript(code);
  }
}, code);

test('desktop: nav sync, ad ignored, cross-origin late player syncs play/seek/pause, SPA nav, late joiner', async () => {
  const room = 'desk-' + Date.now();
  const A = await launch('alice', room), B = await launch('bob', room);
  let stateMsgs = 0;
  for (const c of srv.wss.clients) c.on('message', (r) => { if (/"state"/.test(r.toString())) stateMsgs++; });

  await A.shell.fill('#url', 'http://127.0.0.1:9201/');
  await A.shell.click('#go');
  await until(async () => (await mediaState(B))?.url === 'http://127.0.0.1:9201/', 10000, 'B follows nav');
  await until(async () => (await player(A)) && (await player(B)), 10000, 'players appear');
  assert.equal(stateMsgs, 0, 'ad video (<30s) must not generate sync traffic');

  await until(async () => (await player(A)).dur > 100 && (await player(B)).dur > 100, 10000, 'metadata');
  await runInPlayer(A, `document.getElementById('player').play()`);
  await until(async () => (await player(B)).paused === false, 6000, 'B plays');

  await runInPlayer(A, `document.getElementById('player').currentTime = 70`);
  await until(async () => Math.abs((await player(B)).t - 70) < 3, 6000, 'B seeks');

  await runInPlayer(B, `document.getElementById('player').pause()`); // control from the other side
  await until(async () => (await player(A)).paused === true, 6000, 'A paused by B');
  const [ta, tb] = [(await player(A)).t, (await player(B)).t];
  assert.ok(Math.abs(ta - tb) < 0.6, `paused positions ${ta} vs ${tb}`);

  // SPA navigation (pushState) propagates
  await A.app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /127\.0\.0\.1:9201/.test(w.getURL()));
    await wc.executeJavaScript(`document.getElementById('spa').click()`);
  });
  await until(async () => /watch\/2$/.test((await mediaState(B)).url), 6000, 'SPA nav');

  // back to the movie page with a playing state, then a late joiner arrives
  await B.shell.fill('#url', 'http://127.0.0.1:9201/'); await B.shell.click('#go');
  await until(async () => (await player(A)) && (await player(B)), 10000, 'players again');
  await until(async () => (await player(A)).dur > 100, 10000);
  await runInPlayer(B, `(()=>{const v=document.getElementById('player');v.currentTime=30;v.play()})()`);
  await until(async () => (await player(A)).paused === false, 6000, 'A follows B');
  await wait(1500);
  const C = await launch('carol', room);
  await until(async () => { const p = await player(C); return p && p.dur > 100 && !p.paused && p.t >= 30; }, 15000, 'late joiner synced');
  const [pa, pc] = [(await player(A)).t, (await player(C)).t];
  assert.ok(Math.abs(pa - pc) < 2.5, `late joiner drift ${pa} vs ${pc}`);
});

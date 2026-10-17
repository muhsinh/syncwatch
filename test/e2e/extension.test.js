// Chrome extension in two real Chromium profiles (headed, run under xvfb) against the fixture "movie site".
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { createServer } = require('../../server/server');
const { startSite } = require('./fixtures');

const EXT = path.join(__dirname, '../../extension');
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await wait(100); }
  throw new Error('timeout ' + label);
}

let srv, site, relayPort;
const ctxs = [];
test.before(async () => {
  srv = createServer({ port: 0 });
  relayPort = await srv.listen();
  site = await startSite({ sitePort: 9501, playerPort: 9502 });
});
test.after(async () => { for (const c of ctxs) await c.close().catch(() => {}); site.close(); await srv.close(); });

async function profile(name, room) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ext-' + name + '-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: exe, headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  });
  ctxs.push(ctx);
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate((p) => self.swTest.connect(p), { server: `ws://127.0.0.1:${relayPort}`, room, name });
  await until(() => sw.evaluate(() => self.swTest.status.state === 'connected'), 8000, name + ' connected');
  return { ctx, sw, name, id: new URL(sw.url()).host };
}

const findFrame = (page) => page.frames().find((f) => f.url().includes(':9502'));
const playerState = async (page) => {
  const f = findFrame(page) || page.mainFrame();
  const r = await f.evaluate(() => { const v = document.getElementById('player'); return v && { paused: v.paused, t: v.currentTime, dur: v.duration }; }).catch(() => null);
  return r;
};
const runInPlayer = (page, code) => (findFrame(page) || page.mainFrame()).evaluate(code);

test('extension: sync tab -> partner follows, cross-origin late player syncs play/seek/pause, SPA nav, ad ignored', async () => {
  const room = 'ext-' + Date.now();
  const A = await profile('alice', room), B = await profile('bob', room);
  let stateMsgs = 0;
  for (const c of srv.wss.clients) c.on('message', (r) => { if (/"state"/.test(r.toString())) stateMsgs++; });

  const pageA = await A.ctx.newPage();
  await pageA.goto('http://127.0.0.1:9501/');
  const tabId = await A.sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:9501/*' }))[0].id);
  await A.sw.evaluate(([id, url]) => self.swTest.syncTab(id, url), [tabId, 'http://127.0.0.1:9501/']);

  // Bob has no synced tab: the extension opens one for him
  const pageB = await until(() => B.ctx.pages().find((p) => p.url() === 'http://127.0.0.1:9501/'), 10000, 'bob tab opened');
  await until(async () => (await playerState(pageA)) && (await playerState(pageB)), 10000, 'players');
  await until(async () => (await playerState(pageA)).dur > 100 && (await playerState(pageB)).dur > 100, 10000, 'metadata');
  assert.equal(stateMsgs, 0, 'ad video must not generate sync traffic');

  await runInPlayer(pageA, `document.getElementById('player').play()`);
  await until(async () => (await playerState(pageB)).paused === false, 6000, 'B plays');
  await runInPlayer(pageA, `document.getElementById('player').currentTime = 75`);
  await until(async () => Math.abs((await playerState(pageB)).t - 75) < 3, 6000, 'B seeks');
  await runInPlayer(pageB, `document.getElementById('player').pause()`);
  await until(async () => (await playerState(pageA)).paused === true, 6000, 'A paused by B');
  const [ta, tb] = [(await playerState(pageA)).t, (await playerState(pageB)).t];
  assert.ok(Math.abs(ta - tb) < 0.6, `paused positions ${ta} vs ${tb}`);

  await pageA.evaluate(() => document.getElementById('spa').click()); // pushState navigation
  await until(() => /watch\/2$/.test(pageB.url()), 8000, 'SPA nav followed');
});

test('extension: popup UI loads and shows connection state; unsynced tabs are ignored', async () => {
  const room = 'ext2-' + Date.now();
  const A = await profile('carol', room);
  const popup = await A.ctx.newPage();
  await popup.goto(`chrome-extension://${A.id}/popup.html`);
  await until(() => popup.textContent('#status').then((s) => s.includes('In room')), 6000, 'popup status');
  assert.equal(await popup.inputValue('#room'), room);
  // a video in a tab that was never synced must not talk to the room
  let stateMsgs = 0;
  for (const c of srv.wss.clients) c.on('message', (r) => { if (/"state"/.test(r.toString())) stateMsgs++; });
  const page = await A.ctx.newPage();
  await page.goto('http://127.0.0.1:9501/direct');
  await until(() => page.evaluate(() => document.getElementById('player').duration > 100), 8000);
  await page.evaluate(() => document.getElementById('player').play());
  await wait(800);
  assert.equal(stateMsgs, 0);
});

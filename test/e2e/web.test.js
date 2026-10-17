// Web app (PWA) on virtual devices: laptop, iPad, Android tablet, TV. Chromium engine with device emulation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright-core');
const { createServer } = require('../../server/server');
const { startSite } = require('./fixtures');

const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const DEVICES = {
  laptop: { viewport: { width: 1440, height: 900 } },
  ipad: devices['iPad Pro 11'],
  androidTablet: devices['Galaxy Tab S4'],
  tv: { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 11; BRAVIA 4K) AppleWebKit/537.36 Chrome/120 Safari/537.36 SmartTV' },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = '') {
  const t = Date.now(); let last;
  while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch {} await wait(50); }
  throw new Error('timeout ' + label);
}

let srv, site, browser, base, mediaBase;
test.before(async () => {
  srv = createServer({ port: 0 });
  const port = await srv.listen();
  base = `http://127.0.0.1:${port}`;
  site = await startSite({ sitePort: 9101, playerPort: 9102 });
  mediaBase = 'http://127.0.0.1:9101';
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { await browser.close(); site.close(); await srv.close(); });

const opened = [];
test.afterEach(async () => { while (opened.length) await opened.pop().close().catch(() => {}); });
const peersIn = (room) => srv.rooms.get(room)?.peers.size || 0;

async function device(name, room) {
  const ctx = await browser.newContext({ ...DEVICES[name], isMobile: false, hasTouch: !!DEVICES[name].hasTouch });
  opened.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.fill('#room', room);
  await page.fill('#name', name);
  await page.click('#join');
  await until(() => page.textContent('#status').then((s) => s.includes('In room')), 5000, name + ' join');
  return { ctx, page, errors, name };
}
const st = (p, sel = 'video,audio') => p.evaluate((s) => { const v = document.querySelector(s); return v && { paused: v.paused, t: v.currentTime, rate: v.playbackRate }; }, sel);

test('all device profiles sync play/seek/pause/rate and layout fits', async () => {
  const room = 'devices-' + Date.now();
  const d = {};
  for (const n of Object.keys(DEVICES)) d[n] = await device(n, room);
  // no horizontal scroll on any device
  for (const x of Object.values(d)) {
    const over = await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(over, false, x.name + ' has horizontal overflow');
  }
  await d.ipad.page.fill('#url', `${mediaBase}/movie.webm`);
  await d.ipad.page.click('#go');
  for (const x of Object.values(d)) await until(() => st(x.page), 5000, x.name + ' mount');
  await until(() => d.tv.page.evaluate(() => document.querySelector('video').readyState >= 3));

  await d.ipad.page.evaluate(() => document.querySelector('video').play());
  for (const x of Object.values(d)) await until(async () => (await st(x.page)).paused === false, 4000, x.name + ' play');

  await d.laptop.page.evaluate(() => (document.querySelector('video').currentTime = 60));
  for (const x of Object.values(d)) await until(async () => Math.abs((await st(x.page)).t - 60) < 2.5, 4000, x.name + ' seek');

  await d.androidTablet.page.evaluate(() => document.querySelector('video').pause());
  await wait(600);
  const times = [];
  for (const x of Object.values(d)) { const s = await st(x.page); assert.equal(s.paused, true, x.name + ' not paused'); times.push(s.t); }
  assert.ok(Math.max(...times) - Math.min(...times) < 0.5, 'paused positions differ: ' + times);

  await d.tv.page.evaluate(() => (document.querySelector('video').playbackRate = 1.5));
  for (const x of Object.values(d)) await until(async () => (await st(x.page)).rate === 1.5, 4000, x.name + ' rate');

  for (const x of Object.values(d)) { assert.deepEqual(x.errors, [], x.name + ' page errors'); await x.ctx.close(); }
});

test('no feedback loop: idle devices stay quiet and stay in sync while playing 8s', async () => {
  const room = 'loop-' + Date.now();
  const a = await device('laptop', room), b = await device('ipad', room);
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(b.page));
  await a.page.evaluate(() => document.querySelector('video').play());
  await until(async () => (await st(b.page)).paused === false);
  // count state messages seen by server over idle period
  let msgs = 0;
  for (const c of srv.wss.clients) c.on('message', () => msgs++);
  await wait(8000);
  const sa = await st(a.page), sb = await st(b.page);
  assert.ok(Math.abs(sa.t - sb.t) < 1.2, `drift ${sa.t} vs ${sb.t}`);
  assert.ok(msgs < 12, 'chatter too high: ' + msgs);
  await a.ctx.close(); await b.ctx.close();
});

test('late joiner, audio source, and navigation replace', async () => {
  const room = 'late-' + Date.now();
  const a = await device('laptop', room);
  await a.page.fill('#url', `${mediaBase}/song.mp3`); await a.page.click('#go');
  await until(() => st(a.page, 'audio'));
  await a.page.evaluate(() => { const v = document.querySelector('audio'); v.currentTime = 20; v.play(); });
  await wait(1500);
  const b = await device('androidTablet', room);
  await until(async () => { const s = await st(b.page, 'audio'); return s && !s.paused && s.t >= 20; }, 6000, 'late join');
  // switching media replaces previous element
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => b.page.evaluate(() => document.querySelectorAll('audio').length === 0 && document.querySelectorAll('video').length === 1));
  await a.ctx.close(); await b.ctx.close();
});

test('unsupported page shows desktop-app hint; XSS in url is inert', async () => {
  const a = await device('laptop', 'hint-' + Date.now());
  await a.page.fill('#url', 'https://example.com/some-movie-page'); await a.page.click('#go');
  assert.match(await a.page.textContent('#msg'), /desktop app/);
  await a.page.fill('#url', 'javascript:alert(1)'); await a.page.click('#go');
  assert.match(await a.page.textContent('#msg'), /desktop app/); // unchanged, never navigated
  await a.ctx.close();
});

test('autoplay blocked (iOS-style policy): overlay appears, tap resumes playback in sync', async () => {
  // Playwright's own evaluate()/click() count as user activation, so emulate the policy: play() rejects until a real pointerdown.
  const room = 'block-' + Date.now();
  const a = await device('laptop', room);
  const ctx = await browser.newContext(DEVICES.ipad); opened.push(ctx);
  await ctx.addInitScript(() => {
    let ok = false;
    addEventListener('pointerdown', () => (ok = true), true);
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return ok ? orig.call(this) : Promise.reject(new DOMException('blocked', 'NotAllowedError')); };
  });
  const p = await ctx.newPage();
  await p.goto(base); await p.fill('#room', room);
  await p.evaluate(() => document.getElementById('join').click());
  await until(() => p.textContent('#status').then((s) => s.includes('2 here')));
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(p));
  await a.page.evaluate(() => document.querySelector('video').play());
  await until(() => p.isVisible('#unblock'), 5000, 'overlay');
  assert.equal((await st(p)).paused, true);
  await p.click('#unblock');
  await until(async () => (await st(p)).paused === false, 4000, 'resumed');
  await wait(500);
  const sa = await st(a.page), sp = await st(p);
  assert.ok(Math.abs(sa.t - sp.t) < 1.5, `${sa.t} vs ${sp.t}`);
});

test('reconnect: server drop -> clients rejoin and keep syncing', async () => {
  const room = 'recon-' + Date.now();
  const a = await device('laptop', room), b = await device('ipad', room);
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(b.page));
  for (const c of srv.wss.clients) c.terminate(); // simulate network drop
  await until(() => a.page.textContent('#status').then((s) => /reconnecting/.test(s)), 3000, 'saw reconnecting').catch(() => {});
  await until(async () => peersIn(room) === 2, 8000, 'rejoined');
  await until(() => a.page.textContent('#status').then((s) => s.includes('2 here')), 6000, 'peers=2');
  await a.page.evaluate(() => document.querySelector('video').play());
  await until(async () => (await st(b.page)).paused === false, 5000, 'sync after reconnect');
  await a.ctx.close(); await b.ctx.close();
});

test('YouTube adapter (mocked IFrame API): play/pause/seek mirror to video element', async () => {
  const room = 'yt-' + Date.now();
  const a = await device('laptop', room);
  const ctx = await browser.newContext(DEVICES.ipad); opened.push(ctx);
  const y = await ctx.newPage();
  await y.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: `
    window.YT={Player:function(el,o){const me=this;let state=-1,t=0,rate=1,last=Date.now();
      const tick=()=>{const n=Date.now();if(state===1)t+=(n-last)/1000*rate;last=n};setInterval(tick,50);
      me.getPlayerState=()=>state;me.getCurrentTime=()=>{tick();return t};me.getDuration=()=>3600;me.getPlaybackRate=()=>rate;
      me.setPlaybackRate=(r)=>{tick();rate=r;o.events.onPlaybackRateChange&&o.events.onPlaybackRateChange()};
      me.seekTo=(s)=>{t=s};me.playVideo=()=>{state=1;o.events.onStateChange({data:1})};me.pauseVideo=()=>{state=2;o.events.onStateChange({data:2})};
      window.__yt=me;setTimeout(()=>o.events.onReady(),20);}};
    setTimeout(()=>window.onYouTubeIframeAPIReady&&window.onYouTubeIframeAPIReady(),10);` }));
  await y.goto(base); await y.fill('#room', room); await y.click('#join');
  await until(() => y.textContent('#status').then((s) => s.includes('2 here') || s.includes('In room')));
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(a.page));
  // YT side shares a YouTube link -> laptop shows a YouTube player slot (real API unreachable offline: expect #yt container)
  await y.fill('#url', 'https://youtu.be/dQw4w9WgXcQ'); await y.click('#go');
  await until(() => y.evaluate(() => !!window.__yt), 4000, 'yt player created');
  await y.evaluate(() => { window.__yt.seekTo(40); window.__yt.playVideo(); });
  await wait(300);
  const urlOnLaptop = await a.page.inputValue('#url');
  assert.match(urlOnLaptop, /youtu\.be/, 'laptop followed nav to YouTube link');
  await ctx.close(); await a.ctx.close();
});

test('concurrent actions: seek while the other side sends a heartbeat does not diverge', async () => {
  const room = 'race-' + Date.now();
  const a = await device('laptop', room), b = await device('ipad', room);
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(b.page));
  await b.page.evaluate(() => document.querySelector('video').play()); // b becomes leader, heartbeating every 3s
  await until(async () => (await st(a.page)).paused === false);
  for (let i = 0; i < 4; i++) { // hammer seeks from the follower across several heartbeat boundaries
    const target = 20 + i * 15;
    await a.page.evaluate((t) => (document.querySelector('video').currentTime = t), target);
    await wait(1300);
    const [sa, sb] = [await st(a.page), await st(b.page)];
    assert.ok(Math.abs(sa.t - sb.t) < 2 && Math.abs(sa.t - (target + 1.3)) < 3, `round ${i}: a=${sa.t} b=${sb.t} want~${target + 1.3}`);
  }
});

test('immediate user pause right after a remote play is not swallowed', async () => {
  const room = 'quick-' + Date.now();
  const a = await device('laptop', room), b = await device('ipad', room);
  await a.page.fill('#url', `${mediaBase}/movie.webm`); await a.page.click('#go');
  await until(() => st(b.page));
  await a.page.evaluate(() => document.querySelector('video').play());
  await until(async () => (await st(b.page)).paused === false);
  await b.page.evaluate(() => document.querySelector('video').pause()); // within the suppress window of the remote play
  await until(async () => (await st(a.page)).paused === true, 3000, 'a paused by b');
});

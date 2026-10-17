// Manual check that the ad blocker hook works in this Electron: xvfb-run -a npx electron --no-sandbox scripts/adblock-smoke.js
// Expect: hits has no /ads/track.js and bannerDisplay is "none".
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
app.whenReady().then(async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.setHeader('content-type','text/html'); res.end(req.url === '/' ? '<div class="ad-banner" id="b">AD</div><div id="c">content</div><script src="/ads/track.js"></script><script src="/ok.js"></script>' : '/*x*/'); }).listen(9401);
  const ses = session.fromPartition('persist:t');
  const blocker = ElectronBlocker.parse('||127.0.0.1:9401/ads/\n##.ad-banner');
  blocker.enableBlockingInSession(ses);
  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:t' } });
  console.log('loading'); win.loadURL('http://127.0.0.1:9401/').catch(e=>console.log('loaderr',e.message)); await new Promise(r=>win.webContents.once('did-stop-loading',r)); console.log('loaded');
  await new Promise(r => setTimeout(r, 800));
  const hidden = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('b')).display`);
  console.log('RESULT', JSON.stringify({ hits, bannerDisplay: hidden }));
  app.quit(); srv.close();
});

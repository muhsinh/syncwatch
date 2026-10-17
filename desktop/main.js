const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { createRoomClient } = require('../shared/room-client');

const TOOLBAR_H = 96;
const PARTITION = 'persist:syncwatch'; // keeps site logins (YouTube, Spotify, etc.) between launches
let win, view, fullscreen = false;
let lastNavUrl = '';
let lastState = null; // last known room playback state (local clock), replayed into new frames
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const saveSettings = (s) => fs.writeFileSync(settingsFile(), JSON.stringify(s));

const toShell = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const allFrames = () => (view && !view.webContents.isDestroyed() ? view.webContents.mainFrame.framesInSubtree : []);
const sendToFrames = (msg) => allFrames().forEach((f) => { try { f.send('media:remote', msg); } catch {} });

const client = createRoomClient({
  WebSocketImpl: WebSocket,
  onStatus: (s) => toShell('status', s),
  onMessage(m) {
    if (m.t === 'state') {
      lastState = { playing: m.playing, time: m.time, rate: m.rate, at: m.at };
      sendToFrames(lastState);
    } else if (m.t === 'nav') {
      loadRemote(m.url);
      toShell('toast', 'Partner opened a new page');
    }
  },
});

function loadRemote(url) {
  if (!/^https?:\/\//i.test(url) || url === lastNavUrl) return;
  lastNavUrl = url;
  lastState = null;
  view.webContents.loadURL(url).catch(() => {});
}

function localNav(url) {
  if (!/^https?:\/\//i.test(url)) return;
  toShell('url', url);
  if (url === lastNavUrl) return;
  lastNavUrl = url;
  lastState = null;
  client.send({ t: 'nav', url });
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = fullscreen ? 0 : TOOLBAR_H;
  view.setBounds({ x: 0, y: top, width: w, height: h - top });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#14151a', title: 'SyncWatch',
    webPreferences: { preload: path.join(__dirname, 'shell-preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'content-preload.js'),
      contextIsolation: true,
      sandbox: false, // preload needs to require() the shared sync engine
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // run the preload inside player iframes too
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.contentView.addChildView(view);
  const wc = view.webContents;

  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // no popup ads
  wc.on('did-navigate', (_e, url) => localNav(url));
  wc.on('did-navigate-in-page', (_e, url, isMain) => isMain && localNav(url));
  wc.on('enter-html-full-screen', () => { fullscreen = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { fullscreen = false; win.setFullScreen(false); layout(); });
  win.on('resize', layout);
  layout();
  wc.loadURL('https://www.youtube.com');
}

ipcMain.handle('settings:get', loadSettings);
ipcMain.on('room:connect', (_e, p) => {
  if (!/^wss?:\/\//i.test(p.server) || !/^[A-Za-z0-9_-]{4,64}$/.test(p.room)) {
    toShell('toast', 'Need a ws(s):// server and a room code (4+ letters/numbers)');
    return;
  }
  saveSettings(p);
  client.connect({ url: p.server, room: p.room, name: p.name });
});
ipcMain.on('room:disconnect', () => client.close());
ipcMain.on('nav:go', (_e, url) => { if (/^https?:\/\//i.test(url)) view.webContents.loadURL(url).catch(() => {}); });
ipcMain.on('nav:action', (_e, a) => {
  const wc = view.webContents;
  if (a === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (a === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (a === 'reload') wc.reload();
});

// Frames report local playback; we relay to the room. Late-loading frames ask for current state.
ipcMain.on('media:local', (_e, msg) => {
  lastState = { playing: msg.playing, time: msg.time, rate: msg.rate, at: Date.now() };
  client.send(msg);
});
ipcMain.on('media:ready', (e) => { if (lastState && e.senderFrame) e.senderFrame.send('media:remote', lastState); });
ipcMain.on('media:blocked', () => toShell('toast', 'Playback was blocked — click the video once to join in'));

app.whenReady().then(() => {
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow();
});
app.on('window-all-closed', () => app.quit());

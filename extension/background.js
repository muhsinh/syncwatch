// Service worker: owns the room connection, tracks which tab is "synced", relays between that tab's frames and the room.
importScripts('lib/room-client.js');

let cfg = { server: '', room: '', name: '', connected: false, tabId: null };
let status = { state: 'disconnected', peers: 0 };
let lastState = null; // last known room playback state (local clock), replayed into frames that load later
let lastNavUrl = '';

const save = () => chrome.storage.local.set({ cfg });
const httpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

const client = RoomClient.createRoomClient({
  WebSocketImpl: WebSocket,
  onStatus(s) {
    status = { state: s.state, peers: s.peers ?? status.peers };
    chrome.action.setBadgeText({ text: cfg.tabId != null && s.state === 'connected' ? String(status.peers) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff5d8f' });
    chrome.runtime.sendMessage({ t: 'status', status }).catch(() => {});
  },
  onMessage(m) {
    if (m.t === 'state') {
      lastState = { playing: m.playing, time: m.time, rate: m.rate, at: m.at };
      if (cfg.tabId != null) chrome.tabs.sendMessage(cfg.tabId, { t: 'remote', state: lastState }).catch(() => {});
    } else if (m.t === 'nav') {
      follow(m.url);
    }
  },
});

function connect(p) {
  cfg = { ...cfg, server: p.server, room: p.room, name: p.name || 'guest', connected: true };
  save();
  client.connect({ url: cfg.server, room: cfg.room, name: cfg.name });
}
function disconnect() {
  cfg.connected = false;
  save();
  client.close();
}
function setTab(tabId) {
  cfg.tabId = tabId;
  save();
  chrome.action.setBadgeText({ text: tabId != null && status.state === 'connected' ? String(status.peers) : '' });
}

// The user chose this tab: make it the synced one and share its page with the room.
function syncTab(tabId, url) {
  setTab(tabId);
  if (httpUrl(url)) { lastNavUrl = url; lastState = null; client.send({ t: 'nav', url }); }
}

// Partner opened a page: load it in our synced tab, or open (and sync) a new tab if we have none.
async function follow(url) {
  if (!httpUrl(url) || url === lastNavUrl) return;
  lastNavUrl = url;
  lastState = null;
  if (cfg.tabId != null) {
    try { await chrome.tabs.update(cfg.tabId, { url }); return; } catch { /* tab was closed */ }
  }
  const tab = await chrome.tabs.create({ url });
  setTab(tab.id);
}

// We navigated in the synced tab (including SPA pushState): tell the partner.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== cfg.tabId || !info.url || !httpUrl(info.url) || info.url === lastNavUrl) return;
  lastNavUrl = info.url;
  lastState = null;
  client.send({ t: 'nav', url: info.url });
});
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === cfg.tabId) setTab(null); });

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  const fromSynced = sender.tab && sender.tab.id === cfg.tabId;
  switch (m.t) {
    case 'local': // a frame in the synced tab reports play/pause/seek
      if (fromSynced) {
        lastState = { playing: m.msg.playing, time: m.msg.time, rate: m.msg.rate, at: Date.now() };
        client.send(m.msg);
      }
      break;
    case 'ready': // a frame found a media element; catch it up
      if (fromSynced && lastState) chrome.tabs.sendMessage(cfg.tabId, { t: 'remote', state: lastState }, { frameId: sender.frameId }).catch(() => {});
      break;
    case 'getStatus': respond({ cfg, status }); break;
    case 'connect': connect(m); respond({ ok: true }); break;
    case 'disconnect': disconnect(); respond({ ok: true }); break;
    case 'syncTab': syncTab(m.tabId, m.url); respond({ ok: true }); break;
    case 'unsyncTab': setTab(null); respond({ ok: true }); break;
  }
});

// Service workers restart; restore the previous session.
chrome.storage.local.get('cfg').then(({ cfg: saved }) => {
  if (saved) cfg = saved;
  if (cfg.connected && cfg.server && cfg.room) client.connect({ url: cfg.server, room: cfg.room, name: cfg.name });
});

self.swTest = { connect, disconnect, setTab, syncTab, get cfg() { return cfg; }, get status() { return status; } }; // used by e2e tests

const $ = (id) => document.getElementById(id);
const ask = (m) => chrome.runtime.sendMessage(m);
let cfg, status, activeTab;

function render() {
  const on = cfg.connected;
  $('connect').textContent = on ? 'Disconnect' : 'Connect';
  $('status').textContent = !on ? 'Not connected' : status.state === 'connected' ? `In room · ${status.peers} here` : status.state + '…';
  const synced = cfg.tabId != null && activeTab && cfg.tabId === activeTab.id;
  $('sync').textContent = synced ? 'Stop syncing this tab' : 'Sync this tab';
  $('sync').disabled = !on;
}

async function refresh() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ({ cfg, status } = await ask({ t: 'getStatus' }));
  render();
}

(async () => {
  await refresh();
  $('server').value = cfg.server || '';
  $('room').value = cfg.room || '';
  $('name').value = cfg.name || '';
})();

$('connect').onclick = async () => {
  if (cfg.connected) await ask({ t: 'disconnect' });
  else {
    const server = $('server').value.trim(), room = $('room').value.trim();
    if (!/^wss?:\/\//i.test(server) || !/^[A-Za-z0-9_-]{4,64}$/.test(room)) { $('status').textContent = 'Need a ws(s):// server and a room code (4+ letters/numbers)'; return; }
    await ask({ t: 'connect', server, room, name: $('name').value.trim() });
  }
  await refresh();
};
$('sync').onclick = async () => {
  const synced = cfg.tabId != null && cfg.tabId === activeTab.id;
  await ask(synced ? { t: 'unsyncTab' } : { t: 'syncTab', tabId: activeTab.id, url: activeTab.url });
  await refresh();
};
chrome.runtime.onMessage.addListener((m) => { if (m.t === 'status') { status = m.status; render(); } });

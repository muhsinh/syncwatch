const $ = (id) => document.getElementById(id);
const api = window.syncwatch;
let connected = false;

api.getSettings().then((s) => {
  $('server').value = s.server || 'ws://localhost:8787';
  $('room').value = s.room || '';
  $('name').value = s.name || '';
});

function connect() {
  api.connect({ server: $('server').value.trim(), room: $('room').value.trim(), name: $('name').value.trim() || 'guest' });
}
$('connect').onclick = () => (connected ? api.disconnect() : connect());
$('room').addEventListener('keydown', (e) => e.key === 'Enter' && connect());

function go() {
  let u = $('url').value.trim();
  if (!u) return;
  if (!/^[a-z]+:\/\//i.test(u)) u = /\s|^[^.]+$/.test(u) ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(u) : 'https://' + u;
  api.navigate(u);
}
$('go').onclick = go;
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && go());
$('back').onclick = () => api.nav('back');
$('fwd').onclick = () => api.nav('forward');
$('reload').onclick = () => api.nav('reload');

api.onUrl((u) => { if (document.activeElement !== $('url')) $('url').value = u; });
api.onStatus((s) => {
  connected = s.state === 'connected' || s.state === 'connecting' || s.state === 'reconnecting';
  $('dot').className = s.state;
  $('connect').textContent = connected ? 'Leave' : 'Connect';
  $('status').textContent = s.state === 'connected' ? `In room · ${s.peers} here` : s.state === 'disconnected' ? 'Not connected' : s.state + '…';
});
let toastTimer;
api.onToast((t) => {
  $('toast').textContent = t; $('toast').style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ($('toast').style.display = 'none'), 4000);
});

api.onBlocked((n) => { $('blocked').textContent = `🛡 ${n} blocked`; });

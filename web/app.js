const $ = (id) => document.getElementById(id);
const stage = $('stage');
let current = null; // url currently shown

const sync = MediaSync.createMediaSync({
  send: (m) => room.send(m),
  onBlocked: () => ($('unblock').style.display = 'block'),
});
$('unblock').onclick = () => { $('unblock').style.display = 'none'; sync.resume(); };

const room = RoomClient.createRoomClient({
  WebSocketImpl: WebSocket,
  onStatus: (s) => ($('status').textContent = s.state === 'connected' ? `In room · ${s.peers} here` : s.state + '…'),
  onMessage(m) {
    if (m.t === 'state') sync.onRemote(m);
    else if (m.t === 'nav') show(m.url, false);
  },
});

try {
  $('room').value = localStorage.room || new URLSearchParams(location.search).get('room') || '';
  $('name').value = localStorage.name || '';
} catch {}

$('join').onclick = () => {
  const code = $('room').value.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) { $('status').textContent = 'Room code: 4+ letters/numbers'; return; }
  try { localStorage.room = code; localStorage.name = $('name').value; } catch {}
  room.connect({ url: location.origin.replace(/^http/, 'ws'), room: code, name: $('name').value || 'guest' });
};
$('go').onclick = () => { const u = $('url').value.trim(); if (/^https?:\/\//i.test(u)) show(u, true); };

function ytId(u) {
  try {
    const x = new URL(u);
    if (x.hostname === 'youtu.be') return x.pathname.slice(1);
    if (/(^|\.)youtube\.com$/.test(x.hostname)) return x.searchParams.get('v') || (x.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/) || [])[1];
  } catch {}
  return null;
}

function show(url, share) {
  if (url === current) return;
  current = url;
  sync.clearRemote();
  stage.querySelectorAll('video,audio,iframe,#yt,#msg').forEach((n) => n.remove());
  $('url').value = url;
  if (share) room.send({ t: 'nav', url });
  const id = ytId(url);
  if (id) return loadYouTube(id);
  if (/\.(mp4|webm|m4v|mov|m3u8|ogv)(\?|#|$)/i.test(url)) return mount('video', url);
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i.test(url)) return mount('audio', url);
  const d = document.createElement('div');
  d.id = 'msg';
  d.textContent = 'This page needs the SyncWatch desktop app to sync (it is not a YouTube or direct media link).';
  stage.prepend(d);
}

function mount(tag, src) {
  const el = document.createElement(tag);
  el.controls = true; el.playsInline = true; el.src = src;
  stage.prepend(el);
  sync.attach(el);
}

// --- YouTube: wrap the IFrame API in an HTMLMediaElement-shaped adapter ---
let ytApiReady;
function ytApi() {
  return (ytApiReady ||= new Promise((res) => {
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  }));
}

async function loadYouTube(id) {
  await ytApi();
  const holder = document.createElement('div');
  holder.id = 'yt';
  stage.prepend(holder);
  const L = {};
  let adapter;
  const player = new YT.Player(holder, {
    videoId: id,
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady() {
        let lastT = 0, lastTick = Date.now();
        setInterval(() => { // detect scrubbing: YouTube has no 'seeked' event
          const now = Date.now(), t = player.getCurrentTime();
          const expect = lastT + (adapter.paused ? 0 : ((now - lastTick) / 1000) * adapter.playbackRate);
          if (Math.abs(t - expect) > 1.5) adapter.emit('seeked');
          lastT = t; lastTick = now;
        }, 500);
        sync.attach(adapter);
      },
      onStateChange(e) { adapter.emit(e.data === 1 || e.data === 3 ? 'play' : e.data === 2 ? 'pause' : null); },
      onPlaybackRateChange() { adapter.emit('ratechange'); },
    },
  });
  adapter = {
    get paused() { const s = player.getPlayerState(); return s !== 1 && s !== 3; },
    get ended() { return player.getPlayerState() === 0; },
    get duration() { return player.getDuration(); },
    get currentTime() { return player.getCurrentTime(); },
    set currentTime(v) { player.seekTo(v, true); },
    get playbackRate() { return player.getPlaybackRate(); },
    set playbackRate(v) { player.setPlaybackRate(v); },
    play() { player.playVideo(); return Promise.resolve(); },
    pause() { player.pauseVideo(); },
    addEventListener(n, f) { (L[n] ||= []).push(f); },
    emit(n) { (L[n] || []).forEach((f) => f()); },
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

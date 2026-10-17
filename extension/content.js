// Runs in every frame of every page. Finds <video>/<audio> and reports/applies playback; the background ignores
// everything except the tab the user chose to sync.
(() => {
  if (window.__syncwatchLoaded) return;
  window.__syncwatchLoaded = true;
  const send = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { /* extension reloaded */ } };

  let banner;
  const sync = MediaSync.createMediaSync({
    send: (msg) => send({ t: 'local', msg }),
    onActive: (_el, isNew) => { if (isNew) send({ t: 'ready' }); },
    onBlocked() { // the browser refused autoplay: ask for one click, which grants it
      if (banner || !document.body) return;
      banner = document.createElement('button');
      banner.textContent = '▶ Click to join SyncWatch playback';
      banner.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#ff5d8f;color:#fff;border:0;border-radius:8px;padding:10px 14px;font:600 14px system-ui;cursor:pointer';
      banner.onclick = () => { banner.remove(); banner = null; sync.resume(); };
      document.body.append(banner);
    },
  });

  try { chrome.runtime.onMessage.addListener((m) => { if (m && m.t === 'remote') sync.onRemote(m.state); }); } catch {}

  const start = () => sync.watch(document);
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

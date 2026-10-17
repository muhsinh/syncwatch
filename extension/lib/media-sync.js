/* Media sync engine. Works on anything shaped like an HTMLMediaElement
 * (<video>, <audio>, or an adapter such as the YouTube one in web/app.js).
 * Remote messages carry `at` already converted to the local clock. */
(function (root) {
  const SUPPRESS_MS = 800; // ignore our own events caused by applying remote state
  const HEARTBEAT_MS = 3000;
  const DRIFT_PLAYING = 1.0; // seconds of drift tolerated while playing
  const DRIFT_PAUSED = 0.3;
  const MIN_DURATION = 30; // skip ads / previews / UI blips shorter than this
  const EVENTS = ['play', 'pause', 'seeked', 'ratechange'];

  function createMediaSync({ send, onBlocked = () => {}, onActive = () => {} }) {
    const elements = new Set();
    let active = null;
    let remote = null; // last room state {playing,time,rate,at}
    let suppressUntil = 0;
    let lastSent = null;
    let leader = false; // true after a local user action; leaders send heartbeats

    const eligible = (el) => el.duration === Infinity || el.duration >= MIN_DURATION;

    function expectedTime() {
      if (!remote) return 0;
      if (!remote.playing) return remote.time;
      return remote.time + ((Date.now() - remote.at) / 1000) * (remote.rate || 1);
    }

    function snapshot(el) {
      return { t: 'state', playing: !el.paused && !el.ended, time: el.currentTime, rate: el.playbackRate || 1 };
    }

    function pick() {
      const list = [...elements].filter(eligible);
      if (active && list.includes(active)) return active;
      return list.find((e) => !e.paused) || list[0] || null;
    }

    function apply(el) {
      if (!remote || !el || !eligible(el)) return;
      suppressUntil = Date.now() + SUPPRESS_MS;
      leader = false;
      const target = expectedTime();
      const drift = Math.abs(el.currentTime - target);
      if (el.duration !== Infinity && drift > (remote.playing ? DRIFT_PLAYING : DRIFT_PAUSED)) {
        el.currentTime = Math.min(target, (el.duration || target) - 0.1);
      }
      if ((remote.rate || 1) !== el.playbackRate) el.playbackRate = remote.rate || 1;
      if (remote.playing && el.paused) {
        const p = el.play();
        if (p && p.catch) p.catch(() => onBlocked());
      } else if (!remote.playing && !el.paused) {
        el.pause();
      }
    }

    // True when the element is already where the room says it should be, i.e. the event is just an echo of apply().
    function matchesRemote(el) {
      return !!remote && el.paused === !remote.playing && (el.playbackRate || 1) === (remote.rate || 1) &&
        (el.duration === Infinity || Math.abs(el.currentTime - expectedTime()) < 1.5);
    }

    function onLocal(el) {
      // Duration unknown yet (metadata still loading): can't tell a movie from an ad, so decide once it's known.
      if (!(el.duration >= 0) && el.readyState !== undefined && el.readyState < 1) {
        el.addEventListener('loadedmetadata', () => onLocal(el), { once: true });
        return;
      }
      if (!eligible(el)) return;
      // Only swallow echoes: a real user action right after a remote update must still go out.
      if (Date.now() < suppressUntil && matchesRemote(el)) return;
      const snap = snapshot(el), now = Date.now();
      if (lastSent && now - lastSent.at < 500 && lastSent.playing === snap.playing && Math.abs(lastSent.time - snap.time) < 0.3) return; // duplicate event burst
      lastSent = { ...snap, at: now };
      active = el;
      leader = true;
      onActive(el);
      send(snap);
    }

    function attach(el) {
      if (elements.has(el)) return;
      elements.add(el);
      EVENTS.forEach((ev) => el.addEventListener(ev, () => onLocal(el)));
      const ready = () => {
        if (remote) { if (pick() === el) apply(el); }
        else if (!el.paused) onLocal(el); // autoplayed before we noticed it: announce it to the room
      };
      if (el.readyState !== undefined && el.readyState < 1) el.addEventListener('loadedmetadata', ready, { once: true });
      else ready();
      onActive(el, true);
    }

    function scan(doc) {
      doc.querySelectorAll('video,audio').forEach(attach);
    }

    function watch(doc) {
      scan(doc);
      let queued = false, last = 0;
      const mo = new MutationObserver(() => {
        if (queued) return;
        const wait = Math.max(0, 150 - (Date.now() - last)); // scan immediately, then at most every 150ms
        queued = true;
        setTimeout(() => { queued = false; last = Date.now(); scan(doc); }, wait);
      });
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      return mo;
    }

    const timer = setInterval(() => {
      const el = pick();
      if (leader && el && !el.paused) send({ ...snapshot(el), hb: true });
    }, HEARTBEAT_MS);
    if (timer.unref) timer.unref(); // Node (tests): never keep the process alive

    return {
      attach,
      watch,
      hasMedia: () => !!pick(),
      onRemote(msg) {
        if (msg.hb && leader) return; // two leaders: the one who acted most recently keeps authority
        remote = { playing: !!msg.playing, time: +msg.time || 0, rate: +msg.rate || 1, at: msg.at || Date.now() };
        const el = pick();
        if (el) apply(el);
      },
      clearRemote() { remote = null; },
      resume() { const el = pick(); if (el) apply(el); },
      stop() { clearInterval(timer); },
      _expectedTime: expectedTime,
    };
  }

  const api = { createMediaSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediaSync = api;
})(typeof self !== 'undefined' ? self : this);

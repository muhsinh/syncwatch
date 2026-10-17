/* WebSocket room client with auto-reconnect and server clock-offset estimation.
 * Incoming `at` timestamps are converted to the local clock before delivery. */
(function (root) {
  function createRoomClient({ WebSocketImpl, onMessage, onStatus }) {
    let ws = null, params = null, offset = 0, bestRtt = Infinity;
    let retry = 0, retryTimer = null, pingTimer = null, closed = true;

    function ping() {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'sync', c: Date.now() }));
    }

    function open() {
      onStatus({ state: 'connecting' });
      ws = new WebSocketImpl(params.url);
      const mine = ws;
      mine.onopen = () => {
        retry = 0;
        bestRtt = Infinity;
        mine.send(JSON.stringify({ t: 'join', room: params.room, name: params.name }));
        ping();
        pingTimer = setInterval(ping, 10000);
      };
      mine.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        if (m.t === 'sync') {
          const rtt = Date.now() - m.c;
          if (rtt < bestRtt) { bestRtt = rtt; offset = m.s - (m.c + rtt / 2); }
          return;
        }
        if (typeof m.at === 'number') m.at -= offset;
        if (m.t === 'joined' || m.t === 'peers') onStatus({ state: 'connected', peers: m.peers });
        onMessage(m);
      };
      mine.onclose = () => {
        clearInterval(pingTimer);
        if (closed || mine !== ws) return;
        onStatus({ state: 'reconnecting' });
        retryTimer = setTimeout(open, Math.min(15000, 500 * 2 ** retry++));
      };
      mine.onerror = () => {};
    }

    return {
      connect(p) { this.close(); closed = false; params = p; open(); },
      send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      close() {
        closed = true;
        clearTimeout(retryTimer);
        clearInterval(pingTimer);
        if (ws) { const w = ws; ws = null; try { w.close(); } catch {} }
        onStatus({ state: 'disconnected' });
      },
    };
  }

  const api = { createRoomClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoomClient = api;
})(typeof self !== 'undefined' ? self : this);

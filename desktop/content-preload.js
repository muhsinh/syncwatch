// Runs in EVERY frame of the watched page (incl. embedded player iframes).
// Finds <video>/<audio>, reports local play/pause/seek, applies remote state.
const { ipcRenderer } = require('electron');
const { createMediaSync } = require('../shared/media-sync');

const sync = createMediaSync({
  send: (msg) => ipcRenderer.send('media:local', msg),
  onBlocked: () => ipcRenderer.send('media:blocked'),
  onActive: (_el, isNew) => { if (isNew) ipcRenderer.send('media:ready'); },
});
ipcRenderer.on('media:remote', (_e, msg) => sync.onRemote(msg));

window.addEventListener('DOMContentLoaded', () => sync.watch(document));

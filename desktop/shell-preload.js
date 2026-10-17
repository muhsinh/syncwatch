const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('syncwatch', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  connect: (p) => ipcRenderer.send('room:connect', p),
  disconnect: () => ipcRenderer.send('room:disconnect'),
  navigate: (url) => ipcRenderer.send('nav:go', url),
  nav: (action) => ipcRenderer.send('nav:action', action),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onUrl: (cb) => ipcRenderer.on('url', (_e, u) => cb(u)),
  onBlocked: (cb) => ipcRenderer.on('blocked', (_e, n) => cb(n)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
});

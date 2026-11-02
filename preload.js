const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stan', {
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
  onInit: (cb) => ipcRenderer.on('init', (_e, data) => cb(data)),
  postpone: (minutes) => ipcRenderer.send('postpone', minutes),
  escape: () => ipcRenderer.send('escape'),
  escHold: (held) => ipcRenderer.send('esc-hold', !!held),
  ready: () => ipcRenderer.send('ready'),
});

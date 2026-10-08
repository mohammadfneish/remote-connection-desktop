const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the (sandboxed) UI and the main process.
contextBridge.exposeInMainWorld('rc', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  listScreens: () => ipcRenderer.invoke('screen:list'),

  host: {
    share: (sourceId) => ipcRenderer.invoke('host:share', sourceId),
    start: (displayId) => ipcRenderer.invoke('host:start', displayId),
    setDisplay: (displayId) => ipcRenderer.invoke('host:set-display', displayId),
    stop: () => ipcRenderer.invoke('host:stop'),
    release: () => ipcRenderer.invoke('host:release'),
    input: (event) => ipcRenderer.send('host:input', event),
  },
  inputStatus: () => ipcRenderer.invoke('input:status'),

  attention: () => ipcRenderer.send('win:attention'),
  setFullScreen: (on) => ipcRenderer.send('win:fullscreen', on),
  log: (line) => ipcRenderer.send('log', String(line)),

  updates: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (callback) => {
      const listener = (_e, state) => callback(state);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    },
  },
});

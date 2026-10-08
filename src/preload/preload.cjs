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

  clipboard: {
    watch: (on) => ipcRenderer.invoke('clipboard:watch', Boolean(on)),
    write: (item) => ipcRenderer.invoke('clipboard:write', item),
    onChange: (callback) => {
      const listener = (_e, item) => callback(item);
      ipcRenderer.on('clipboard:changed', listener);
      return () => ipcRenderer.removeListener('clipboard:changed', listener);
    },
  },

  files: {
    begin: (id, info) => ipcRenderer.invoke('files:begin', id, info),
    chunk: (id, data) => ipcRenderer.send('files:chunk', id, data),
    end: (id) => ipcRenderer.invoke('files:end', id),
    cancel: (id) => ipcRenderer.invoke('files:cancel', id),
    reveal: (id) => ipcRenderer.invoke('files:reveal', id),
  },

  system: {
    get: () => ipcRenderer.invoke('system:get'),
    setStartAtLogin: (on) => ipcRenderer.invoke('system:set-start-at-login', Boolean(on)),
    setCloseToTray: (on) => ipcRenderer.invoke('system:set-close-to-tray', Boolean(on)),
  },

  unattended: {
    set: (password) => ipcRenderer.invoke('unattended:set', String(password)),
    disable: () => ipcRenderer.invoke('unattended:disable'),
    verify: (password) => ipcRenderer.invoke('unattended:verify', String(password)),
  },

  trusted: {
    add: (device) => ipcRenderer.invoke('trusted:add', device),
    remove: (id) => ipcRenderer.invoke('trusted:remove', String(id)),
  },

  // Tell the main process a remote session is (in)active, so it can surface it to the user.
  hosting: (active, peer) => ipcRenderer.send('session:hosting', { active: Boolean(active), peer }),

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

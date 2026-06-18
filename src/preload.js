// Secure bridge. Renderer windows get a tiny, explicit API; never any key.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('veil', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  clearConvo: () => ipcRenderer.invoke('history:clear-convo'),

  // ask
  ask: (prompt, includeScreenshot) =>
    ipcRenderer.send('ai:ask', { prompt, includeScreenshot: !!includeScreenshot }),
  askHistory: (question) => ipcRenderer.send('history:ask', { question }),

  // history / storage / usage
  getStats: () => ipcRenderer.invoke('history:stats'),
  getStorage: () => ipcRenderer.invoke('storage:info'),
  getUsage: () => ipcRenderer.invoke('usage:get'),

  // live audio
  transcribe: (buffer, mimeType) => ipcRenderer.invoke('audio:transcribe', { buffer, mimeType }),

  // practice (mock interview)
  openPractice: () => ipcRenderer.send('practice:open'),
  practiceTurn: (messages, context) => ipcRenderer.invoke('practice:turn', { messages, context }),

  // onboarding (managed / no-key)
  openExternal: (url) => ipcRenderer.send('open:external', url),
  restore: (licenseKey) => ipcRenderer.invoke('auth:restore', { licenseKey }), // "log in" with the key
  activateToken: (token) => ipcRenderer.send('activate:token', token),
  onActivated: (cb) => ipcRenderer.on('activate:result', (_e, r) => cb(r)),

  // window
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),

  // events main -> renderer
  onStatus: (cb) => ipcRenderer.on('ai:status', (_e, s) => cb(s)),
  onChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('ai:done', (_e, t) => cb(t)),
  onError: (cb) => ipcRenderer.on('ai:error', (_e, err) => cb(err)),
  onAskScreen: (cb) => ipcRenderer.on('cmd:ask-screen', () => cb()),
  onFocus: (cb) => ipcRenderer.on('cmd:focus', () => cb()),
  onToggleListen: (cb) => ipcRenderer.on('cmd:toggle-listen', () => cb()),
  onMasterChat: (cb) => ipcRenderer.on('cmd:master-chat', () => cb()),
  onClickThrough: (cb) => ipcRenderer.on('cmd:click-through', (_e, on) => cb(on)),
  onStorageWarn: (cb) => ipcRenderer.on('storage:warn', (_e, info) => cb(info)),
});

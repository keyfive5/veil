const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
  desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const history = require('./history');
const {
  streamAnswer, askOnce, transcribe, transcribeViaProxy,
  MASTER_SYSTEM, PRACTICE_SYSTEM,
} = require('./ai');

let win = null;
let practiceWin = null;
let visible = true;

// Short rolling conversation so live follow-ups have context (text-only, cheap).
let convo = [];
const MAX_CONVO = 6;
function pushConvo(role, text) {
  if (!text) return;
  convo.push({ role, content: text });
  if (convo.length > MAX_CONVO) convo = convo.slice(-MAX_CONVO);
}

// Which key/route to use, based on the user's chosen mode.
function getCreds() {
  const s = store.read();
  if (s.keyMode === 'managed') return { apiKey: s.licenseKey, baseURL: s.managedUrl, settings: s };
  return { apiKey: s.apiKey, baseURL: undefined, settings: s };
}

function createWindow() {
  const settings = store.read();
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 500, height: 660,
    x: Math.round(screenW / 2 - 250), y: 48,
    frame: false, transparent: true, resizable: true,
    minWidth: 380, minHeight: 120,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(!!settings.invisible);
  applyClickThrough(settings.clickThrough);
  win.setOpacity(settings.opacity ?? 1);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function applyClickThrough(on) { if (win) win.setIgnoreMouseEvents(!!on, { forward: true }); }

function toggleVisibility() {
  if (!win) return;
  visible = !visible;
  if (visible) { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); }
  else win.hide();
}

function moveBy(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

async function captureScreen() {
  if (!win) return null;
  const prev = win.getOpacity();
  win.setOpacity(0);
  await new Promise((r) => setTimeout(r, 60));
  try {
    const d = screen.getPrimaryDisplay();
    const scale = d.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) },
    });
    const primary = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    return primary ? primary.thumbnail.toPNG().toString('base64') : null;
  } catch (err) {
    console.error('[veil] capture failed:', err);
    return null;
  } finally {
    win.setOpacity(prev || 1);
  }
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// ---- Storage monitoring (fixes the "it silently ran out of space" bug) ----
async function storageInfo() {
  let free = null, total = null;
  try {
    const st = await fs.promises.statfs(app.getPath('userData'));
    free = st.bavail * st.bsize;
    total = st.blocks * st.bsize;
  } catch {}
  const h = history.stats();
  const LOW = 1.5 * 1024 * 1024 * 1024; // warn under 1.5 GB free
  return { free, total, low: free != null && free < LOW, historyBytes: h.bytes, entries: h.entries };
}
async function checkStorage() {
  const info = await storageInfo();
  if (info.low) send('storage:warn', info);
}

// ---- IPC -------------------------------------------------------------------
ipcMain.handle('settings:get', () => store.read());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.write(patch);
  if (win) {
    if ('invisible' in patch) win.setContentProtection(!!next.invisible);
    if ('clickThrough' in patch) applyClickThrough(next.clickThrough);
    if ('opacity' in patch) win.setOpacity(next.opacity ?? 1);
  }
  return next;
});
ipcMain.handle('history:clear-convo', () => { convo = []; return true; });
ipcMain.handle('history:stats', () => history.stats());
ipcMain.handle('storage:info', () => storageInfo());
ipcMain.handle('usage:get', async () => {
  const s = store.read();
  if (s.keyMode !== 'managed' || !s.managedUrl) return null;
  try {
    const r = await fetch(`${s.managedUrl.replace(/\/$/, '')}/v1/usage`, { headers: { 'x-api-key': s.licenseKey } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
});

// Ask Veil (optionally about the screen).
ipcMain.on('ai:ask', async (_e, { prompt, includeScreenshot }) => {
  const { apiKey, baseURL, settings } = getCreds();
  let imageBase64 = null;
  if (includeScreenshot) { send('ai:status', 'capturing'); imageBase64 = await captureScreen(); }
  send('ai:status', 'thinking');
  let full = '';
  await streamAnswer({
    apiKey, baseURL, model: settings.model, mode: settings.mode, context: settings.context,
    prompt, imageBase64, history: convo,
    onText: (d) => { full += d; send('ai:chunk', d); },
    onDone: (text) => {
      const answer = text || full;
      pushConvo('user', prompt || '[screenshot] what should I do/say?');
      pushConvo('assistant', answer);
      history.append({ mode: settings.mode, kind: 'ask', prompt: prompt || '[screenshot]', answer });
      send('ai:done', answer);
    },
    onError: (err) => send('ai:error', err),
  });
});

// Master chatbot — ask across ALL saved conversations.
function extractTerm(q) {
  const m = q.match(/['"“”]([^'"“”]{1,40})['"“”]/);
  return m ? m[1] : null;
}
ipcMain.on('history:ask', async (_e, { question }) => {
  const { apiKey, baseURL, settings } = getCreds();
  const term = extractTerm(question || '');
  const countLine = term
    ? `Exact occurrences of "${term}" (whole-word, case-insensitive) across all of the user's history: ${history.countTerm(term)}.\n\n`
    : '';
  const corpus = history.corpus(120000);
  const prompt = `${countLine}USER QUESTION: ${question}\n\n=== THE USER'S FULL VEIL HISTORY (newest first) ===\n${corpus || '(empty — no saved conversations yet)'}`;
  send('ai:status', 'thinking');
  await streamAnswer({
    apiKey, baseURL, model: settings.model, systemOverride: MASTER_SYSTEM, maxTokens: 1500, prompt,
    onText: (d) => send('ai:chunk', d),
    onDone: (t) => send('ai:done', t),
    onError: (err) => send('ai:error', err),
  });
});

// Transcription for Listen mode.
ipcMain.handle('audio:transcribe', async (_e, { buffer, mimeType }) => {
  const s = store.read();
  try {
    if (s.keyMode === 'managed') {
      const text = await transcribeViaProxy({ baseURL: s.managedUrl, licenseKey: s.licenseKey, audioBuffer: Buffer.from(buffer), mimeType });
      return { text };
    }
    if (!s.transcriptionKey) return { error: 'no-transcription-key' };
    const text = await transcribe({ provider: s.transcriptionProvider, key: s.transcriptionKey, audioBuffer: Buffer.from(buffer), mimeType });
    return { text };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

// Mock-interview practice (separate window).
function openPractice() {
  if (practiceWin && !practiceWin.isDestroyed()) { practiceWin.focus(); return; }
  practiceWin = new BrowserWindow({
    width: 900, height: 700, title: 'Veil — Practice Interview',
    backgroundColor: '#0a0b0f', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  practiceWin.setMenuBarVisibility(false);
  practiceWin.loadFile(path.join(__dirname, '..', 'renderer', 'practice.html'));
  practiceWin.on('closed', () => { practiceWin = null; });
}
ipcMain.on('practice:open', openPractice);
ipcMain.handle('practice:turn', async (_e, { messages, context }) => {
  const { apiKey, baseURL, settings } = getCreds();
  if (!apiKey) return { error: 'no-key' };
  try {
    const sys = PRACTICE_SYSTEM + (context ? `\n\nROLE / CONTEXT FOR THIS INTERVIEW:\n${context}` : '');
    const text = await askOnce({ apiKey, baseURL, model: settings.model, system: sys, messages });
    const last = messages[messages.length - 1];
    history.append({ mode: 'practice', kind: 'practice', prompt: typeof last?.content === 'string' ? last.content : '', answer: text });
    return { text };
  } catch (err) {
    const status = err && (err.status || err.statusCode);
    return { error: status === 401 ? 'bad-key' : (err.message || String(err)) };
  }
});

ipcMain.on('window:hide', () => toggleVisibility());
ipcMain.on('app:quit', () => app.quit());

// ---- Global hotkeys --------------------------------------------------------
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+\\', toggleVisibility);
  globalShortcut.register('CommandOrControl+Enter', () => { if (!visible) toggleVisibility(); send('cmd:ask-screen'); });
  globalShortcut.register('CommandOrControl+Shift+Space', () => { if (!visible) toggleVisibility(); if (win) win.showInactive(); send('cmd:focus'); });
  globalShortcut.register('CommandOrControl+Shift+L', () => { if (!visible) toggleVisibility(); send('cmd:toggle-listen'); });
  globalShortcut.register('CommandOrControl+Shift+M', () => { if (!visible) toggleVisibility(); send('cmd:master-chat'); });
  globalShortcut.register('CommandOrControl+Shift+\\', () => {
    const next = store.write({ clickThrough: !store.read().clickThrough });
    applyClickThrough(next.clickThrough);
    send('cmd:click-through', next.clickThrough);
  });
  globalShortcut.register('CommandOrControl+Up', () => moveBy(0, -48));
  globalShortcut.register('CommandOrControl+Down', () => moveBy(0, 48));
  globalShortcut.register('CommandOrControl+Left', () => moveBy(-48, 0));
  globalShortcut.register('CommandOrControl+Right', () => moveBy(48, 0));
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
}

// Grant system/loopback audio to getDisplayMedia (Windows). macOS → video only,
// renderer falls back to mic.
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  }, { useSystemPicker: false });
}

// ---- App lifecycle ---------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (!visible) toggleVisibility(); win.showInactive(); } });

  app.whenReady().then(() => {
    setupDisplayMedia();
    createWindow();
    registerShortcuts();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    setTimeout(checkStorage, 4000);
    setInterval(checkStorage, 5 * 60 * 1000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

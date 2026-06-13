// Renderer logic. No Node here — only the `window.veil` bridge from preload.

const $ = (id) => document.getElementById(id);
const els = {
  storageBar: $('storageBar'), storageMsg: $('storageMsg'), storageUpsell: $('storageUpsell'), storageDismiss: $('storageDismiss'),
  input: $('input'), askScreen: $('askScreen'), masterBtn: $('masterBtn'),
  settingsBtn: $('settingsBtn'), hideBtn: $('hideBtn'),
  modes: $('modes'), listenBtn: $('listenBtn'), listenLabel: $('listenLabel'), practiceBtn: $('practiceBtn'),
  status: $('status'), statusText: $('statusText'),
  transcriptPanel: $('transcriptPanel'), transcript: $('transcript'), autoSuggest: $('autoSuggest'), suggestBtn: $('suggestBtn'),
  panel: $('panel'), answer: $('answer'), answerHint: $('answerHint'), copyBtn: $('copyBtn'),
  settings: $('settings'),
  onboard: $('onboard'), obStart: $('obStart'), obEmail: $('obEmail'), obSignIn: $('obSignIn'), obStatus: $('obStatus'), obByo: $('obByo'),
  keyMode: $('keyMode'), managedFields: $('managedFields'), byoFields: $('byoFields'),
  licenseKey: $('licenseKey'), managedUrl: $('managedUrl'), checkoutUrl: $('checkoutUrl'), getLicense: $('getLicense'),
  usageBox: $('usageBox'), usageFill: $('usageFill'), usageText: $('usageText'),
  apiKey: $('apiKey'), model: $('model'), context: $('context'),
  transcriptionProvider: $('transcriptionProvider'), transcriptionKey: $('transcriptionKey'),
  invisible: $('invisible'), clickThrough: $('clickThrough'), opacity: $('opacity'), opacityVal: $('opacityVal'),
  quitBtn: $('quitBtn'), settingsDone: $('settingsDone'),
};

let streaming = false, rawAnswer = '', transcriptText = '', listener = null, suggestDebounce = null;
let masterMode = false;
let cfg = {};

// ---- Markdown (safe) ------------------------------------------------------
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function renderMarkdown(md) {
  const blocks = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _l, code) => { blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`); return ` BLOCK${blocks.length - 1} `; });
  text = escapeHtml(text);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = text.split('\n'); let html = '', listType = null;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (let line of lines) {
    if (line.startsWith(' BLOCK')) { closeList(); html += line; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${h[2]}</h${h[1].length}>`; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += `<li>${ul[1]}</li>`; continue; }
    if (ol) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += `<li>${ol[1]}</li>`; continue; }
    closeList(); if (line.trim() !== '') html += `<p>${line}</p>`;
  }
  closeList();
  return html.replace(/ BLOCK(\d+) /g, (_m, i) => blocks[+i]);
}

// ---- UI helpers -----------------------------------------------------------
function showStatus(t) { els.statusText.textContent = t; els.status.hidden = false; }
function hideStatus() { els.status.hidden = true; }
function showAnswer() { els.settings.hidden = true; els.panel.hidden = false; }
function setAnswer(md, cursor) { els.answer.innerHTML = renderMarkdown(md); els.answer.classList.toggle('cursor', !!cursor); els.answer.scrollTop = els.answer.scrollHeight; }

// ---- Ask flow -------------------------------------------------------------
function startStream() { streaming = true; rawAnswer = ''; showAnswer(); setAnswer('', false); }
function ask(includeScreenshot) {
  if (streaming) return;
  const prompt = els.input.value.trim();
  if (masterMode && prompt) { startStream(); els.answerHint.textContent = 'From all your chats'; window.veil.askHistory(prompt); els.input.value = ''; return; }
  if (!prompt && !includeScreenshot) return;
  startStream(); els.answerHint.textContent = 'Hidden from screen share';
  window.veil.ask(prompt, includeScreenshot); els.input.value = '';
}
els.askScreen.addEventListener('click', () => ask(true));
els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(!masterMode && (e.ctrlKey || e.metaKey)); } });
els.hideBtn.addEventListener('click', () => window.veil.hide());
els.copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(rawAnswer); els.copyBtn.textContent = 'Copied'; setTimeout(() => (els.copyBtn.textContent = 'Copy'), 1200); } catch {} });

// ---- Master chat (all conversations) --------------------------------------
function setMasterMode(on) {
  masterMode = on;
  els.masterBtn.classList.toggle('active', on);
  els.input.placeholder = on ? 'Ask across ALL your chats…  e.g. "how many times did I say \'car\'?"' : 'Ask anything…  (⌘/Ctrl+↵ reads your screen)';
  if (on) els.input.focus();
}
els.masterBtn.addEventListener('click', () => setMasterMode(!masterMode));
window.veil.onMasterChat(() => setMasterMode(!masterMode));

// ---- Modes ----------------------------------------------------------------
els.modes.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  [...els.modes.children].forEach((c) => c.classList.toggle('active', c === chip));
  window.veil.setSettings({ mode: chip.dataset.mode });
});

// ---- Practice -------------------------------------------------------------
els.practiceBtn.addEventListener('click', () => window.veil.openPractice());

// ---- Streaming events -----------------------------------------------------
window.veil.onStatus((s) => { showAnswer(); showStatus(s === 'capturing' ? 'Reading screen…' : 'Thinking…'); });
window.veil.onChunk((d) => { hideStatus(); rawAnswer += d; setAnswer(rawAnswer, true); });
window.veil.onDone((t) => { streaming = false; hideStatus(); rawAnswer = t || rawAnswer; setAnswer(rawAnswer, false); });
window.veil.onError((err) => {
  streaming = false; hideStatus(); showAnswer();
  const msg = {
    'no-key': 'Add your key in Settings to start. Click the ⚙ icon.',
    'bad-key': 'That key was rejected. Check it in Settings.',
    'rate-limit': 'Rate limited. Wait a moment and try again.',
    'bad-request': 'The request was rejected: ' + (err.message || ''),
  }[err.code] || ('Something went wrong: ' + (err.message || 'unknown error'));
  setAnswer('**⚠ ' + msg + '**', false);
  if (err.code === 'no-key') { if ((cfg.keyMode || 'managed') === 'managed') showOnboarding(); else openSettings(); }
});

// ---- Hotkey commands ------------------------------------------------------
window.veil.onAskScreen(() => ask(true));
window.veil.onFocus(() => els.input.focus());
window.veil.onToggleListen(() => toggleListen());
window.veil.onClickThrough((on) => { els.clickThrough.checked = on; });

// ---- Storage / usage warnings ---------------------------------------------
function gb(bytes) { return (bytes / 1024 / 1024 / 1024).toFixed(1); }
window.veil.onStorageWarn((info) => {
  els.storageUpsell.hidden = true;
  els.storageMsg.textContent = `⚠ Low disk space — ${gb(info.free)} GB left. Veil saves your chats locally; free up room so it doesn't stop.`;
  els.storageBar.hidden = false;
});
els.storageDismiss.addEventListener('click', () => { els.storageBar.hidden = true; });
els.storageUpsell.addEventListener('click', () => { els.storageBar.hidden = true; openSettings(); });

async function refreshUsage() {
  const u = await window.veil.getUsage();
  if (!u || !u.cap) { els.usageBox.hidden = true; return; }
  const pct = Math.min(100, Math.round((u.used / u.cap) * 100));
  els.usageFill.style.width = pct + '%';
  els.usageText.textContent = `${u.used} / ${u.cap} this month`;
  els.usageBox.hidden = false;
  if (u.remaining <= u.cap * 0.1) {
    els.storageMsg.textContent = `You've used ${pct}% of your monthly limit. Upgrade for more.`;
    els.storageUpsell.hidden = false;
    els.storageBar.hidden = false;
  }
}

// ---- Live audio / Listen --------------------------------------------------
function suggestFromTranscript() {
  if (!transcriptText.trim() || streaming) return;
  startStream(); els.answerHint.textContent = 'From the live call';
  window.veil.ask('This is the live transcript of a call I am on (others + me). Based on what was just said, tell me exactly what to say next.\n\nTRANSCRIPT:\n' + transcriptText.slice(-2000), false);
}
function toggleListen() {
  if (listener && listener.active) { listener.stop(); return; }
  listener = new window.AudioListener({
    onTranscript: (t) => {
      transcriptText += (transcriptText ? ' ' : '') + t;
      els.transcript.textContent = transcriptText; els.transcript.scrollTop = els.transcript.scrollHeight;
      if (els.autoSuggest.checked && !streaming) { clearTimeout(suggestDebounce); suggestDebounce = setTimeout(suggestFromTranscript, 600); }
    },
    onState: (state, info) => {
      const live = state === 'listening';
      els.listenBtn.classList.toggle('live', live);
      els.listenLabel.textContent = live ? 'Listening' : 'Listen';
      els.transcriptPanel.hidden = !live;
      if (state === 'error') {
        showAnswer();
        if (String(info).includes('no-transcription-key')) { setAnswer('**⚠ Add a transcription key in Settings → Live audio (or switch to a Veil key, which includes it).**', false); openSettings(); }
        else setAnswer('**⚠ Listen: ' + (info || 'audio error') + '**', false);
      }
      if (state === 'stopped') { els.listenBtn.classList.remove('live'); els.listenLabel.textContent = 'Listen'; els.transcriptPanel.hidden = true; }
    },
  });
  transcriptText = ''; els.transcript.textContent = ''; listener.start();
}
els.listenBtn.addEventListener('click', toggleListen);
els.suggestBtn.addEventListener('click', suggestFromTranscript);
els.autoSuggest.addEventListener('change', () => window.veil.setSettings({ autoSuggest: els.autoSuggest.checked }));

// ---- Onboarding (no-key / managed default) --------------------------------
function showOnboarding() {
  els.panel.hidden = true; els.settings.hidden = true; els.transcriptPanel.hidden = true;
  els.onboard.hidden = false;
}
function obSay(msg, isErr) { els.obStatus.textContent = msg; els.obStatus.classList.toggle('err', !!isErr); els.obStatus.hidden = !msg; }

els.obStart.addEventListener('click', () => {
  if (cfg.checkoutUrl) {
    window.veil.openExternal(cfg.checkoutUrl);
    obSay('Opening checkout in your browser… after you pay, click the activation link and Veil turns on automatically. You can leave this open.');
  } else {
    obSay('Almost there — set your Stripe checkout link in Settings → Advanced (or use your own key below for now).', true);
  }
});
els.obSignIn.addEventListener('click', async () => {
  const email = (els.obEmail.value || '').trim();
  if (!email || !email.includes('@')) { obSay('Enter the email you paid with.', true); return; }
  obSay('Sending your sign-in link…');
  const r = await window.veil.signIn(email);
  if (r && r.error) obSay('Could not reach the server. Check your connection.', true);
  else obSay('Check your email for a link to activate Veil on this device.');
});
els.obByo.addEventListener('click', async (e) => {
  e.preventDefault();
  cfg = await window.veil.setSettings({ keyMode: 'byo' });
  els.onboard.hidden = true;
  applyKeyMode('byo');
  openSettings();
});
window.veil.onActivated((r) => {
  if (r && r.ok) {
    els.onboard.hidden = true;
    showAnswer();
    setAnswer(`**You're in — ${r.plan || 'Veil'} plan. 🎉**\n\nHit **Ctrl+Enter** to read your screen, or just ask anything above.`, false);
    els.input.focus();
  } else {
    obSay('Activation failed: ' + ((r && r.error) || 'unknown') + '. Try the link again.', true);
  }
});

// ---- Settings -------------------------------------------------------------
function applyKeyMode(km) {
  const managed = km === 'managed';
  els.managedFields.hidden = !managed;
  els.byoFields.hidden = managed;
  [...els.keyMode.children].forEach((b) => b.classList.toggle('active', b.dataset.km === km));
  if (managed) refreshUsage();
}
async function loadSettings() {
  const s = await window.veil.getSettings();
  cfg = s;
  els.apiKey.value = s.apiKey || '';
  els.licenseKey.value = s.licenseKey || '';
  els.managedUrl.value = s.managedUrl || '';
  els.checkoutUrl.value = s.checkoutUrl || '';
  els.model.value = s.model || 'claude-opus-4-8';
  els.context.value = s.context || '';
  els.transcriptionProvider.value = s.transcriptionProvider || 'groq';
  els.transcriptionKey.value = s.transcriptionKey || '';
  els.autoSuggest.checked = !!s.autoSuggest;
  els.invisible.checked = !!s.invisible;
  els.clickThrough.checked = !!s.clickThrough;
  els.opacity.value = s.opacity ?? 1;
  els.opacityVal.textContent = Math.round((s.opacity ?? 1) * 100) + '%';
  [...els.modes.children].forEach((c) => c.classList.toggle('active', c.dataset.mode === (s.mode || 'general')));
  applyKeyMode(s.keyMode || 'managed');
  // First run / not yet connected → onboarding (managed) or settings (BYO).
  const km = s.keyMode || 'managed';
  if (km === 'managed' && !s.licenseKey) showOnboarding();
  else if (km === 'byo' && !s.apiKey) openSettings();
}
function openSettings() { els.panel.hidden = true; els.settings.hidden = false; }

els.keyMode.addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg-btn'); if (!btn) return;
  applyKeyMode(btn.dataset.km);
  cfg = await window.veil.setSettings({ keyMode: btn.dataset.km });
});
els.settingsBtn.addEventListener('click', () => { if (els.settings.hidden) openSettings(); else els.settings.hidden = true; });
els.settingsDone.addEventListener('click', async () => {
  cfg = await window.veil.setSettings({
    apiKey: els.apiKey.value.trim(), licenseKey: els.licenseKey.value.trim(), managedUrl: els.managedUrl.value.trim(),
    checkoutUrl: els.checkoutUrl.value.trim(), model: els.model.value, context: els.context.value,
    transcriptionProvider: els.transcriptionProvider.value, transcriptionKey: els.transcriptionKey.value.trim(),
    onboarded: true,
  });
  els.settings.hidden = true; els.input.focus();
});
els.quitBtn.addEventListener('click', () => window.veil.quit());
if (els.getLicense) els.getLicense.addEventListener('click', (e) => e.preventDefault());

// live-save
els.apiKey.addEventListener('change', () => window.veil.setSettings({ apiKey: els.apiKey.value.trim(), onboarded: true }));
els.licenseKey.addEventListener('change', () => window.veil.setSettings({ licenseKey: els.licenseKey.value.trim(), onboarded: true }));
els.managedUrl.addEventListener('change', () => window.veil.setSettings({ managedUrl: els.managedUrl.value.trim() }));
els.checkoutUrl.addEventListener('change', async () => { cfg = await window.veil.setSettings({ checkoutUrl: els.checkoutUrl.value.trim() }); });
els.model.addEventListener('change', () => window.veil.setSettings({ model: els.model.value }));
els.context.addEventListener('change', () => window.veil.setSettings({ context: els.context.value }));
els.transcriptionProvider.addEventListener('change', () => window.veil.setSettings({ transcriptionProvider: els.transcriptionProvider.value }));
els.transcriptionKey.addEventListener('change', () => window.veil.setSettings({ transcriptionKey: els.transcriptionKey.value.trim() }));
els.invisible.addEventListener('change', () => window.veil.setSettings({ invisible: els.invisible.checked }));
els.clickThrough.addEventListener('change', () => window.veil.setSettings({ clickThrough: els.clickThrough.checked }));
els.opacity.addEventListener('input', () => { els.opacityVal.textContent = Math.round(els.opacity.value * 100) + '%'; window.veil.setSettings({ opacity: parseFloat(els.opacity.value) }); });

loadSettings();
els.input.focus();

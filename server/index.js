// Veil managed-key proxy.
//
// Lets non-technical users skip the API key entirely: the app sends a Veil
// license key, this server swaps in the REAL provider keys (held only here),
// forwards to Claude / Whisper, streams the response back, and meters usage so
// one runaway user can't run up your bill.
//
// Deploy this anywhere (Railway, Render, Fly, a VPS). Set the env vars in
// .env.example. The desktop app points "Managed URL" at this server's address.
const express = require('express');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 8787;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// Comma-separated valid license keys. In production, replace checkLicense() with
// a lookup against your Stripe/db so issuing & revoking is automatic.
const LICENSES = (process.env.VEIL_LICENSES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Rough monthly request cap per license (cost guard + the "upsell for more" hook).
const MONTHLY_CAP = parseInt(process.env.VEIL_MONTHLY_CAP || '8000', 10);

// In-memory usage. Swap for Redis/db if you run more than one instance.
const usage = new Map();
function meter(key) {
  const month = new Date().toISOString().slice(0, 7);
  let u = usage.get(key);
  if (!u || u.month !== month) { u = { month, count: 0 }; usage.set(key, u); }
  return u;
}
function checkLicense(key) {
  if (!key) return { ok: false, code: 401, msg: 'Missing license key.' };
  // Empty LICENSES list = dev mode (accept any non-empty key). Lock this down in prod.
  if (LICENSES.length && !LICENSES.includes(key)) {
    return { ok: false, code: 403, msg: 'Invalid or expired license key.' };
  }
  const u = meter(key);
  if (u.count >= MONTHLY_CAP) {
    return { ok: false, code: 429, msg: 'Monthly usage limit reached. Upgrade your plan for more.' };
  }
  u.count += 1;
  return { ok: true, used: u.count, cap: MONTHLY_CAP };
}

app.use(express.json({ limit: '30mb' })); // screenshots ride along as base64

app.get('/health', (_req, res) => res.json({ ok: true, anthropic: !!ANTHROPIC_KEY, transcription: !!(GROQ_KEY || OPENAI_KEY) }));

// Usage / quota — the app shows this and upsells when it's near the cap.
app.get('/v1/usage', (req, res) => {
  const key = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key) return res.status(401).json({ error: 'missing key' });
  if (LICENSES.length && !LICENSES.includes(key)) return res.status(403).json({ error: 'invalid key' });
  const u = meter(key);
  res.json({ used: u.count, cap: MONTHLY_CAP, remaining: Math.max(0, MONTHLY_CAP - u.count) });
});

// Reverse-proxy to Claude. The desktop app uses the Anthropic SDK pointed here,
// so it sends x-api-key:<license>. We validate, swap in the real key, forward,
// and stream the SSE/JSON response straight back — SDK streaming works unchanged.
app.post('/v1/messages', async (req, res) => {
  const chk = checkLicense(req.header('x-api-key'));
  if (!chk.ok) {
    return res.status(chk.code).json({ type: 'error', error: { type: 'authentication_error', message: chk.msg } });
  }
  if (!ANTHROPIC_KEY) return res.status(500).json({ type: 'error', error: { message: 'Server missing ANTHROPIC_API_KEY' } });
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': req.header('anthropic-version') || '2023-06-01',
        ...(req.header('anthropic-beta') ? { 'anthropic-beta': req.header('anthropic-beta') } : {}),
      },
      body: JSON.stringify(req.body),
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.setHeader('x-veil-usage', `${chk.used}/${chk.cap}`);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) {
    res.status(502).json({ type: 'error', error: { message: 'Upstream error: ' + String(e) } });
  }
});

// Transcription: app sends base64 audio; we build the multipart request to
// Groq (preferred, free) or OpenAI with the server-held key.
app.post('/v1/transcribe', async (req, res) => {
  const key = (req.header('authorization') || '').replace(/^Bearer\s+/i, '') || req.header('x-api-key');
  const chk = checkLicense(key);
  if (!chk.ok) return res.status(chk.code).json({ error: chk.msg });

  const provider = GROQ_KEY ? 'groq' : (OPENAI_KEY ? 'openai' : null);
  if (!provider) return res.status(500).json({ error: 'Server has no transcription key configured.' });
  const cfg = provider === 'groq'
    ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', key: GROQ_KEY }
    : { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', key: OPENAI_KEY };
  try {
    const { audio, mimeType } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'no audio' });
    const buf = Buffer.from(audio, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mimeType || 'audio/webm' }), 'audio.webm');
    form.append('model', cfg.model);
    form.append('response_format', 'text');
    const up = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form });
    if (!up.ok) return res.status(up.status).json({ error: (await up.text()).slice(0, 200) });
    res.json({ text: (await up.text()).trim() });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`[veil-server] listening on :${PORT}`));

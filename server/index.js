// Veil managed-key proxy + license backend.
//
// Lets non-technical users skip the API key entirely: they pay (Stripe), the app
// activates via a magic link, and from then on it sends a Veil license key. This
// server swaps in the REAL provider keys (held only here), forwards to Claude /
// Whisper, streams responses back, and meters usage per license.
const express = require('express');
const { Readable } = require('stream');
const db = require('./db');
const stripeLib = require('./stripe');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy → req.ip is the real client
const PORT = process.env.PORT || 8787;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || `http://localhost:${PORT}`;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
// The free tier runs on Groq's free Llama vision model ($0 to us). Override via env.
const FREE_MODEL = process.env.FREE_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

// Dev escape hatches (off in prod): a static license list + "accept any key".
const DEV_LICENSES = (process.env.VEIL_LICENSES || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEV_ACCEPT_ANY = process.env.DEV_ACCEPT_ANY === '1';
const DEV_CAP = parseInt(process.env.VEIL_MONTHLY_CAP || '8000', 10);
const devUsage = new Map();
function devMeter(key) {
  const month = new Date().toISOString().slice(0, 7);
  let u = devUsage.get(key);
  if (!u || u.month !== month) { u = { month, count: 0 }; devUsage.set(key, u); }
  return u;
}

// Returns { ok, code?, msg?, used?, cap? }. Real licenses come from the DB; dev
// lists/flags are a local-testing convenience only.
function checkLicense(key) {
  if (!key) return { ok: false, code: 401, msg: 'Missing license key.' };
  const lic = db.getLicense(key);
  if (lic) {
    if (lic.status !== 'active') return { ok: false, code: 403, msg: 'License inactive — renew to continue.' };
    const u = db.getUsage(key);
    if (u.remaining <= 0) {
      if (lic.plan === 'free') return { ok: false, code: 402, msg: "You've hit the free monthly limit — add your own key or upgrade for Claude." };
      return { ok: false, code: 429, msg: 'Monthly limit reached. Upgrade for more.' };
    }
    const after = db.incUsage(key);
    return { ok: true, used: after.used, cap: after.cap, plan: lic.plan };
  }
  if (DEV_LICENSES.includes(key) || DEV_ACCEPT_ANY) {
    const u = devMeter(key);
    if (u.count >= DEV_CAP) return { ok: false, code: 429, msg: 'Monthly limit reached.' };
    u.count += 1;
    return { ok: true, used: u.count, cap: DEV_CAP };
  }
  return { ok: false, code: 403, msg: 'Invalid or expired license key.' };
}

// Lightweight in-memory rate limiter (per key/IP). Bounds brute-force + cost abuse.
const rlBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const id = req.header('x-api-key') || (req.header('authorization') || '') || req.ip || 'anon';
    const now = Date.now();
    let b = rlBuckets.get(id);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; rlBuckets.set(id, b); }
    if (++b.n > max) return res.status(429).json({ error: 'Too many requests — slow down.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rlBuckets) if (now > v.reset) rlBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ---- Free tier: serve via Groq (Llama vision) in Anthropic's wire format ----
// Translate an Anthropic /v1/messages body → OpenAI/Groq chat format.
function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : '');
    if (sys) msgs.push({ role: 'system', content: sys });
  }
  for (const m of (body.messages || [])) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    const parts = [];
    for (const c of (m.content || [])) {
      if (c.type === 'text') parts.push({ type: 'text', text: c.text });
      else if (c.type === 'image' && c.source && c.source.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } });
      }
    }
    msgs.push({ role: m.role, content: parts });
  }
  return msgs;
}

// Emit a one-shot answer as Anthropic-style SSE, so the app's Anthropic SDK parses
// it unchanged (free answers arrive in one go — fits the "free is a bit slower" feel).
function sendAnthropicSSE(res, text) {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  const w = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  w('message_start', { type: 'message_start', message: { id: 'msg_free', type: 'message', role: 'assistant', model: 'veil-free', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  w('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  w('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  w('content_block_stop', { type: 'content_block_stop', index: 0 });
  w('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
  w('message_stop', { type: 'message_stop' });
  res.end();
}

async function handleFree(req, res) {
  if (process.env.FREE_FAKE === '1') return sendAnthropicSSE(res, 'Free AI test answer.'); // local testing without Groq
  if (!GROQ_KEY) return res.status(500).json({ type: 'error', error: { message: 'Free AI not configured (no GROQ_API_KEY).' } });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: FREE_MODEL,
        messages: anthropicToOpenAI(req.body),
        max_tokens: Math.min(req.body.max_tokens || 1024, 1024),
        temperature: 0.7,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 429) {
        return res.status(503).json({ type: 'error', error: { type: 'overloaded_error', message: 'The free AI is busy right now — try again, or add your own key / upgrade for instant Claude.' } });
      }
      return res.status(502).json({ type: 'error', error: { message: 'Free AI error: ' + t.slice(0, 150) } });
    }
    const j = await r.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    sendAnthropicSSE(res, text || '(no response)');
  } catch (e) {
    res.status(502).json({ type: 'error', error: { message: 'Free AI error: ' + String(e) } });
  }
}

// ---- Stripe webhook (RAW body — must be before express.json) ----
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await stripeLib.verifyAndHandle(req.body, req.header('stripe-signature'));
    if (result.type === 'activated') {
      // The real activation happens via the /success redirect; this is the backup
      // path. Don't log the email or token link (sensitive). Wire an email provider
      // here later to deliver `${APP_PUBLIC_URL}/go?token=<token>` to result.email.
      console.log(`[veil] license activated (plan=${result.plan})`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[veil] webhook error:', err.message);
    res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
});

app.use(express.json({ limit: '30mb' }));

app.get('/health', (_req, res) => res.json({
  ok: true, anthropic: !!ANTHROPIC_KEY, transcription: !!(GROQ_KEY || OPENAI_KEY), stripe: stripeLib.enabled,
}));

// ---- Free tier ----
// Every new device gets a free license — no API key, no payment. Free licenses
// run on the free Groq AI server-side (see /v1/messages), so they cost us nothing.
// One license per device id (idempotent), so reinstalling doesn't reset it.
app.post('/v1/free', rateLimit(30, 60000), (req, res) => {
  const deviceId = String((req.body && req.body.deviceId) || '').trim();
  if (!deviceId || deviceId.length > 128) return res.status(400).json({ error: 'invalid deviceId' });
  try {
    const lic = db.getOrCreateFree(deviceId);
    const u = db.getUsage(lic.key);
    res.json({ licenseKey: lic.key, plan: 'free', cap: lic.monthly_cap, remaining: u ? u.remaining : lic.monthly_cap });
  } catch (e) {
    console.error('[veil] /v1/free error:', e.message);
    res.status(500).json({ error: 'could not start free tier' });
  }
});

// ---- Activation (magic link) ----
// The app calls this with the token from veil://activate?token=…
app.post('/v1/activate', rateLimit(20, 60000), (req, res) => {
  const { token } = req.body || {};
  const out = db.consumeToken(token);
  if (!out) return res.status(400).json({ error: 'Invalid or expired activation link.' });
  res.json(out); // { licenseKey, plan }
});

// Post-payment redirect target. Set your Stripe Payment Link's success URL to
// https://<server>/success?session_id={CHECKOUT_SESSION_ID} — no email needed.
app.get('/success', async (req, res) => {
  const sid = String(req.query.session_id || '');
  if (!sid) return res.status(400).send('Missing session.');
  try {
    const license = await stripeLib.provisionFromSessionId(sid);
    if (!license) return res.status(425).send('Payment is still processing — refresh in a few seconds.');
    const token = db.newActivationToken(license.key);
    res.redirect(`/go?token=${token}`);
  } catch (e) {
    console.error('[veil] /success error:', e.message);
    res.status(400).send('Could not verify your payment. Contact support.');
  }
});

// Human-facing landing for the magic link (covers email clients that mangle
// custom-scheme links). Opens the app via veil://.
app.get('/go', (req, res) => {
  const token = String(req.query.token || '').replace(/[^a-f0-9]/gi, '');
  const deep = `veil://activate?token=${token}`;
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><title>Activate Veil</title>
  <style>body{background:#0a0b0f;color:#f3f4f8;font-family:-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
  a.btn{display:inline-block;margin-top:18px;padding:14px 28px;border-radius:12px;background:linear-gradient(135deg,#8b7bf0,#6a5ae0);color:#fff;text-decoration:none;font-weight:600}
  .dot{width:14px;height:14px;border-radius:50%;background:#6ee7d2;display:inline-block;margin-bottom:14px}</style>
  <div><div class="dot"></div><h1>You're in. 🎉</h1><p>Click below to open Veil and activate.</p>
  <a class="btn" href="${deep}">Open Veil →</a>
  <p style="color:#9aa1b2;font-size:13px;margin-top:22px">Veil not open yet? Launch it, then click again.</p></div>
  <script>setTimeout(function(){location.href=${JSON.stringify(deep)}},400)</script>`);
});

// "Sign in on a new device" — sends a fresh activation link to the account's
// EMAIL (so only the inbox owner can use it). The link is never returned in the
// response or logged — otherwise anyone could request a login link for someone
// else's email and take over the account.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/auth/magic', rateLimit(10, 60000), (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
  const customer = db.getCustomerByEmail(email);
  const lic = customer && db.licenseForCustomerId(customer.id);
  if (lic && lic.status === 'active') {
    const token = db.newActivationToken(lic.key);
    // TODO: email this link to `email` via a provider (Resend/Postmark/SES):
    //   `${APP_PUBLIC_URL}/go?token=${token}`
    // Until then this feature is a no-op by design — the link is NOT exposed here.
    void token;
  }
  // Always the same response — never reveal whether the email exists, never leak the link.
  res.json({ ok: true });
});

// Usage / quota — the app shows this and upsells when near the cap.
app.get('/v1/usage', rateLimit(60, 60000), (req, res) => {
  const key = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key) return res.status(401).json({ error: 'missing key' });
  const u = db.getUsage(key);
  if (u) return res.json(u);
  if (DEV_LICENSES.includes(key) || DEV_ACCEPT_ANY) { const m = devMeter(key); return res.json({ used: m.count, cap: DEV_CAP, remaining: Math.max(0, DEV_CAP - m.count) }); }
  res.status(403).json({ error: 'invalid key' });
});

// ---- Reverse-proxy to Claude (streaming) ----
app.post('/v1/messages', rateLimit(120, 60000), async (req, res) => {
  const chk = checkLicense(req.header('x-api-key'));
  if (!chk.ok) return res.status(chk.code).json({ type: 'error', error: { type: 'authentication_error', message: chk.msg } });
  // Free plan → free Groq AI. Paid/BYO → Claude.
  if (chk.plan === 'free') return handleFree(req, res);
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

// ---- Transcription (base64 audio → Groq/OpenAI) ----
app.post('/v1/transcribe', rateLimit(120, 60000), async (req, res) => {
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
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: mimeType || 'audio/webm' }), 'audio.webm');
    form.append('model', cfg.model);
    form.append('response_format', 'text');
    const up = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form });
    if (!up.ok) return res.status(up.status).json({ error: (await up.text()).slice(0, 200) });
    res.json({ text: (await up.text()).trim() });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[veil-server] listening on :${PORT}  (stripe=${stripeLib.enabled})`);
  if (DEV_ACCEPT_ANY) console.warn('⚠️  DEV_ACCEPT_ANY is ON — ANY key is accepted. NEVER set this in production (it lets anyone use your AI for free).');
  if (DEV_LICENSES.length) console.warn(`⚠️  VEIL_LICENSES is set (${DEV_LICENSES.length} static keys) — for local testing only; remove in production.`);
});

// Claude integration + audio transcription. Runs in the MAIN process only, so
// neither the Anthropic key nor the transcription key ever touches the renderer
// (the screen-share-visible surface). Streaming, so answers appear in <1s.
const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;

const BASE_SYSTEM = `You are Veil, a discreet real-time AI copilot living in an invisible overlay on the user's screen. The user triggers you mid-situation — a sales call, an interview, a meeting, a support chat, studying, or coding — and needs something they can act on in seconds.

Rules:
- Lead with the answer. No preamble ("Sure", "Here's", "I'd be happy to"). No sign-off.
- When given a screenshot, read the context first: which app, what's the actual question/email/code/chat/slide on screen — and respond to THAT.
- For "what do I say next" moments: give one crisp line they can say or paste, then 1–3 short supporting bullets.
- For questions or problems: answer first, then a one-line "why" if it helps.
- For code: output the working code in a fenced block, minimal prose.
- If the screenshot is unclear, give your single best read anyway. Never say "I can't see" or add disclaimers. Never reveal you are an AI.
- Be tight. Short bullets. **Bold** the one line that matters most. Markdown.`;

// Per-mode behavior. Beats single-purpose competitors — same app, sharpened for
// each situation (and each maps to a TikTok niche video).
const MODES = {
  general: '',
  interview:
    'CURRENT MODE — Job interview. The user is the candidate. When an interview question appears on screen or in the transcript, write a strong answer in the FIRST PERSON they can say out loud: concise, confident, structured (use STAR for behavioral questions). For coding questions, give the optimal solution in a code block with a one-line time/space complexity note.',
  sales:
    'CURRENT MODE — Sales call. The user is the rep. Spot objections and buying signals; give the EXACT line to say next to handle the objection or move the deal forward, then 1–2 backup angles. Keep it natural and human, not scripted.',
  meeting:
    'CURRENT MODE — Meeting. Give crisp talking points, the smartest question to ask next, and tight notes. If asked to summarize, give 3–5 bullets of what was decided and the action items.',
  study:
    'CURRENT MODE — Studying / practice. Explain so the user actually understands: give the answer, then the single key step or idea behind it. Brief.',
  code:
    'CURRENT MODE — Coding. Output the working solution in a fenced code block FIRST, minimal prose, then one line on the approach.',
};

function buildSystem(mode, context) {
  let sys = BASE_SYSTEM;
  const m = MODES[mode];
  if (m) sys += `\n\n${m}`;
  if (context && context.trim()) {
    sys += `\n\nUSER CONTEXT (personal background — use it when relevant, e.g. tailor interview answers to this experience or sales lines to this product):\n${context.trim()}`;
  }
  return sys;
}

function buildContent(prompt, imageBase64) {
  const content = [];
  if (imageBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });
  }
  content.push({
    type: 'text',
    text: prompt && prompt.trim()
      ? prompt.trim()
      : 'Look at my screen and tell me the single most useful thing to do or say right now.',
  });
  return content;
}

// System prompt for the "master chatbot" — answering across ALL past chats.
const MASTER_SYSTEM = `You are Veil's memory assistant. You can see the user's entire Veil history — every question they asked, every answer, every call transcript, with timestamps. Answer questions ABOUT that history: find conversations on a topic, count mentions, recall what was said, summarize patterns over time.

Rules:
- When an exact count is provided to you ("Exact occurrences: N"), trust and report that number — it was computed precisely.
- Cite when/where ("on Mar 3, in a Sales chat…") so the user can place it.
- If the history doesn't contain it, say so plainly. Don't invent.
- Be concise. Markdown.`;

// System prompt for mock-interview practice. The model plays the interviewer.
const PRACTICE_SYSTEM = `You are a sharp, fair interviewer running a realistic mock interview to help the user practice. Tailor questions to the role/context given.

- Ask ONE question at a time. Keep it to 1–3 sentences. No preamble.
- After the user answers, give brief, specific feedback (1–2 lines: what landed, what to tighten), then ask the next question that probes deeper.
- Mix behavioral and role-specific/technical questions. Escalate difficulty gradually.
- When the user says they're done (or after ~6 questions), give a short scorecard: a /10, two strengths, two things to improve.
- Be direct and encouraging. Markdown.`;

function makeClient(apiKey, baseURL) {
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

// Streams an answer. onText(delta) repeatedly, then onDone(full) or onError(err).
// baseURL set → managed mode (apiKey is a Veil license; requests hit the proxy).
// systemOverride/maxTokens let the master-chatbot and practice flows reuse this.
async function streamAnswer({
  apiKey, baseURL, model, mode, context, prompt, imageBase64, history = [],
  systemOverride, maxTokens, onText, onDone, onError,
}) {
  if (!apiKey) return onError({ code: 'no-key', message: 'No key set.' });
  try {
    const client = makeClient(apiKey, baseURL);
    const messages = [...history, { role: 'user', content: buildContent(prompt, imageBase64) }];

    const stream = client.messages.stream({
      model: model || 'claude-opus-4-8',
      max_tokens: maxTokens || 1200,
      system: systemOverride || buildSystem(mode, context),
      // No `thinking` block: latency-sensitive live copilot wants the fast path.
      messages,
    });

    stream.on('text', (t) => onText(t));
    const final = await stream.finalMessage();
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    onDone(text);
  } catch (err) {
    let code = 'error';
    const status = err && (err.status || err.statusCode);
    if (status === 401) code = 'bad-key';
    else if (status === 402) code = 'limit';      // free monthly limit reached → upgrade
    else if (status === 503) code = 'busy';       // free AI temporarily busy
    else if (status === 429) code = 'rate-limit';
    else if (status === 400) code = 'bad-request';
    onError({ code, message: (err && err.message) || String(err), status });
  }
}

// Whisper-compatible transcription (Groq or OpenAI). BYO key, main-process only.
const TRANSCRIBE_ENDPOINTS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
};

// Non-streaming single answer — used by the mock-interview practice flow.
async function askOnce({ apiKey, baseURL, model, system, messages }) {
  const client = makeClient(apiKey, baseURL);
  const msg = await client.messages.create({
    model: model || 'claude-opus-4-8',
    max_tokens: 700,
    system,
    messages,
  });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Managed-mode transcription — send base64 audio to the proxy, which holds the key.
async function transcribeViaProxy({ baseURL, licenseKey, audioBuffer, mimeType }) {
  const url = `${(baseURL || '').replace(/\/$/, '')}/v1/transcribe`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${licenseKey || 'veil'}` },
    body: JSON.stringify({ audio: Buffer.from(audioBuffer).toString('base64'), mimeType }),
  });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return (j.text || '').trim();
}

async function transcribe({ provider, key, audioBuffer, mimeType }) {
  const cfg = TRANSCRIBE_ENDPOINTS[provider] || TRANSCRIBE_ENDPOINTS.groq;
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), 'audio.webm');
  form.append('model', cfg.model);
  form.append('response_format', 'text');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`transcription ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

module.exports = {
  streamAnswer, askOnce, transcribe, transcribeViaProxy,
  MASTER_SYSTEM, PRACTICE_SYSTEM,
};

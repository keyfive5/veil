// Local-first settings store. Everything stays on this machine — this is the
// whole privacy pitch, so we deliberately keep it to a plain JSON file in the
// OS user-data dir. No telemetry, no cloud.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = path.join(app.getPath('userData'), 'veil-settings.json');

const DEFAULTS = {
  // How the app talks to Claude:
  //   'managed' → DEFAULT. No API key. App activates via a magic link after the
  //               user pays; requests go through our proxy, which holds the real key.
  //   'byo'     → user pastes their own Anthropic key (private, nothing leaves device).
  keyMode: 'managed',
  apiKey: '',                     // BYO Anthropic key — never leaves this machine
  licenseKey: '',                 // Veil license (set automatically on activation)
  plan: '',                       // 'pro' | 'lifetime' | 'enterprise' (set on activation)
  // Production Veil server (Render):
  managedUrl: 'https://veil-server-ydz9.onrender.com',
  // Stripe Payment Link the "Start" button opens (TEST link — swap for the live one when going live):
  checkoutUrl: 'https://buy.stripe.com/test_14A7sL09Ban3cjx6xg6c000',
  model: 'claude-opus-4-8',       // BYO model choice (managed uses a cost-guarded model)
  mode: 'general',                // general | interview | sales | meeting | study | code
  context: '',                    // user's resume / product notes / cheat-sheet, fed into prompts
  invisible: true,                // setContentProtection — hide from screen share / recording
  clickThrough: false,            // let mouse clicks pass through the overlay
  opacity: 1,                     // overlay opacity
  onboarded: false,               // have we shown the welcome / key prompt yet
  // Live audio (optional, BYO transcription key — Anthropic doesn't transcribe)
  transcriptionProvider: 'groq',  // groq (free, fast) | openai
  transcriptionKey: '',           // Groq or OpenAI key, local only
  autoSuggest: false,             // auto-suggest a reply after each transcript update
};

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  try {
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('[veil] failed to write settings:', err);
  }
  return next;
}

module.exports = { read, write, FILE, DEFAULTS };

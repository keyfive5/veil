// Local-first settings store. Everything stays on this machine — this is the
// whole privacy pitch, so we deliberately keep it to a plain JSON file in the
// OS user-data dir. No telemetry, no cloud.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = path.join(app.getPath('userData'), 'veil-settings.json');

const DEFAULTS = {
  // How the app talks to Claude:
  //   'byo'     → user pastes their own Anthropic key (private, nothing leaves device)
  //   'managed' → user pastes a Veil license key; requests go through the proxy server,
  //               which holds the real key. No API key needed — for non-technical users.
  keyMode: 'byo',
  apiKey: '',                     // BYO Anthropic key — never leaves this machine
  licenseKey: '',                 // Veil license key (managed mode)
  managedUrl: 'http://localhost:8787', // Veil proxy URL (managed mode); set to your deployed server
  model: 'claude-opus-4-8',       // configurable (Opus = smartest, Haiku = fastest)
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

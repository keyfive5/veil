// Persistent, local conversation log. Append-only JSONL in the OS user-data dir.
// This is what powers the "master chatbot" (ask across ALL your chats) and feeds
// the storage meter. Stays on the device — same privacy promise as everything else.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = path.join(app.getPath('userData'), 'veil-history.jsonl');

// entry: { ts, mode, kind: 'ask'|'transcript'|'practice', prompt, answer }
function append(entry) {
  try {
    fs.appendFileSync(FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch (err) {
    console.error('[veil] history append failed:', err);
  }
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Exact, case-insensitive count of a term across everything the user has said/seen.
// Local + exact, so "how many times did I say X" is accurate (the model alone would guess).
function countTerm(term) {
  if (!term) return 0;
  const needle = term.toLowerCase();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'gi');
  let n = 0;
  for (const e of readAll()) {
    const blob = `${e.prompt || ''}\n${e.answer || ''}`;
    const m = blob.match(re);
    if (m) n += m.length;
  }
  return n;
}

// Build a corpus (newest-first, capped) to hand to Claude as context for a
// cross-conversation question.
function corpus(maxChars = 120000) {
  const all = readAll().reverse(); // newest first
  let out = '';
  for (const e of all) {
    const when = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
    const line = `[${when} · ${e.mode || 'general'}] ${e.prompt ? 'Q: ' + e.prompt + '\n' : ''}${e.answer ? 'A: ' + e.answer : ''}\n---\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

function stats() {
  const all = readAll();
  const byMode = {};
  for (const e of all) byMode[e.mode || 'general'] = (byMode[e.mode || 'general'] || 0) + 1;
  let bytes = 0;
  try { bytes = fs.statSync(FILE).size; } catch {}
  return {
    entries: all.length,
    byMode,
    bytes,
    first: all.length ? all[0].ts : null,
    last: all.length ? all[all.length - 1].ts : null,
  };
}

module.exports = { append, readAll, countTerm, corpus, stats, FILE };

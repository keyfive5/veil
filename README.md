# Veil

**The private AI copilot that sees your screen, hears your call, and hides from screen share.**

Veil is an invisible desktop overlay. Hit a hotkey, it reads your screen (or listens to your call), and Claude streams an answer you can act on in seconds — during interviews, sales calls, meetings, support chats, studying, or coding. It's a Cluely-style assistant rebuilt around what people actually dislike about the incumbents:

| Cluely problem | What Veil does |
|---|---|
| Invisibility costs **~$150/mo** on Cluely | **Invisible is free** — built into every install. |
| 2025 breach exposed **83k users'** transcripts | **Local-first.** No backend, no account, no breach to be part of. |
| $20/mo and climbing | **Bring your own Claude key** (or a managed Veil key). Per-user inference ≈ $0. |
| Single-purpose rivals (interviews only…) | **Six modes in one app** + a master chatbot over your whole history. |
| Mac-first, weak Windows | **Windows-first**, Electron so Mac/Linux come along. |

Full competitive breakdown with sources: [COMPETITORS.md](COMPETITORS.md).

---

## Features

- **Invisible overlay** — `setContentProtection` hides Veil from Zoom/Meet/Teams/OBS. Free, on by default.
- **Read my screen** — `Ctrl+Enter` screenshots the screen and answers the exact question/email/code/chat in front of you (Claude vision).
- **Listen mode** — `Ctrl+Shift+L` captures the *other person's* call audio + your mic, transcribes it live, and suggests your reply.
- **6 modes** — Interview · Sales · Meeting · Study · Code · General, each tuned for that situation.
- **Personal context** — paste your resume / product details once; every answer gets tailored to you.
- **Master chatbot** — `Ctrl+Shift+M` asks across **all** your past conversations: *"how many times did I say 'car'?"*, *"which chats were about pricing?"*. Exact counts are computed locally; Claude handles the semantic recall.
- **Practice interview** — a built-in AI interviewer with webcam self-view, spoken questions, voice answers, and a scorecard.
- **Storage guard** — warns before you run out of disk (the silent-stop failure people hit on Cluely), with an upsell hook in managed mode.
- **Two ways to connect** — *Own key* (private, nothing leaves device) or *Veil key* (managed — no API key needed; we run the AI for you).

---

## Quick start (dev)

```bash
npm install
npm start
```

First launch opens Settings. Pick one:
- **Own key — private:** paste an Anthropic key (`sk-ant-…`, from <https://console.anthropic.com/settings/keys>). For Listen mode, add a free Groq key under *Live audio*.
- **Veil key — easy:** paste a license key and point *Managed server URL* at your running proxy (see `server/`). No API key needed.

### Build a shippable installer
```bash
npm run dist:win    # → dist/Veil-Setup-0.1.0.exe (installer) + portable .exe
npm run dist:mac    # → dist/Veil-0.1.0.dmg (run on a Mac)
```

---

## Hotkeys

| Shortcut | Action |
|---|---|
| `Ctrl + Enter` | Read my screen → ask Claude |
| `Enter` (in box) | Ask the typed question |
| `Ctrl + Shift + M` | Ask across ALL your chats (master chatbot) |
| `Ctrl + Shift + L` | Listen to the call → suggest replies |
| `Ctrl + \` | Show / hide the overlay |
| `Ctrl + Shift + Space` | Focus the input |
| `Ctrl + Shift + \` | Toggle click-through |
| `Ctrl + ↑ ↓ ← →` | Move the overlay |
| `Ctrl + Shift + Q` | Quit |

Practice interview opens from the **▶ Practice** button.

---

## How it works

```
Electron main (src/) — invisible window · content protection · hotkeys · screen capture
  ├─ ai.js       Claude streaming (vision) + Whisper transcription + practice/master prompts
  ├─ history.js  append-only local log of every Q/A + transcript (powers the master chatbot)
  ├─ store.js    local settings (no telemetry)
  └─ main.js     wires it together; routes BYO vs managed
        │ preload.js (contextIsolation) — tiny bridge, never exposes a key
  renderer/  overlay UI (index/styles/renderer/audio) + practice window (practice.html/js)
  server/    OPTIONAL managed-key proxy (skip the API key) — see server/README.md
  site/      marketing landing page (with the competitor comparison)
```

- **Keys never reach the renderer** (the screen-share-visible surface) — all Claude/Whisper calls run in the main process.
- **Local-first**: in *Own key* mode, your screen, audio, and history live only on your machine.
- **Managed mode** trades some of that privacy for zero setup: requests go through `server/`, which holds the real keys and meters usage per license.

---

## Managed-key server (skip the API key)

`server/` is a small proxy so non-technical users never touch an API key. It holds the real Claude/Whisper keys, validates Veil license keys, and meters usage (the basis for the upsell). Run it locally or deploy to Railway/Render/Fly/VPS — see [server/README.md](server/README.md). Wire license issuance to Stripe for production.

---

## Roadmap to ship
- Code-sign builds (Windows EV cert, Apple Developer) so SmartScreen/Gatekeeper don't scare users.
- Deploy `site/` (Netlify) + Stripe/Lemon Squeezy for Pro/Lifetime/Enterprise.
- Wire license issuance + persistent usage store (Redis/DB) into the server.
- Auto-updater (electron-updater).
- Real generated video-avatar interviewer (premium add-on) on top of the current voice practice.

---

## The business (to $10k/mo)

Because inference runs on the user's own key (or a metered managed key), Veil is nearly free to run — so it's priced like it:

- **Free** (BYO key) — the growth engine; costs you nothing. Drives TikTok conversion.
- **Pro $8/mo** — sync, presets, optional managed key (no setup).
- **Lifetime $99** — kills the subscription objection.
- **White-label / Agency $9,997/mo** — unlimited seats, your branding, managed keys, SLA. **One client ≈ your whole monthly goal.**

**TikTok play:** screen-recorded "watch it work" clips, one per niche (interviews / sales / meetings / students / coders), CTA "free, link in bio", and lean on the two defensible angles competitors can't copy cheaply: **invisible is free** and **nothing leaves your device** (after the 83k-user breach, that lands).

---

## Disclaimer
Veil is a productivity tool for live work. Don't use it to violate the rules of exams, certifications, or any platform's terms of service.

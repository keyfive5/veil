# Veil managed-key proxy

Lets users skip the API key. Holds the real provider keys server-side, validates
Veil license keys, forwards to Claude / Whisper, and meters usage per license.

```
App (Managed mode)  ──x-api-key: VEIL-…──►  this proxy  ──real key──►  Claude / Whisper
                    ◄──────── streamed answer ───────────────────────
```

## Run locally
```bash
cd server
npm install
cp .env.example .env     # fill in ANTHROPIC_API_KEY (+ GROQ_API_KEY for Listen)
npm start                # → http://localhost:8787
```
In the desktop app: Settings → "Veil key — easy", set Managed URL to `http://localhost:8787`
and license key to one from `VEIL_LICENSES` (any non-empty key works while that list is blank).

## Deploy (pick one)
- **Railway / Render / Fly.io** — point at this folder, set the env vars, expose port `8787`.
- **VPS** — `npm start` behind nginx/caddy with TLS. Then set the app's Managed URL to your https domain.

## Endpoints
- `POST /v1/messages` — reverse-proxy to Claude (streaming). App's Anthropic SDK points its baseURL here.
- `POST /v1/transcribe` — `{ audio: base64, mimeType }` → `{ text }` via Groq/OpenAI.
- `GET  /v1/usage` — `{ used, cap, remaining }` for the in-app usage meter + upsell.
- `GET  /health`.

## Going to production
Replace the in-memory `checkLicense()` / usage map with a real store:
1. On Stripe checkout success, generate a license key and save `{ key, plan, monthlyCap }` to a DB.
2. `checkLicense` looks the key up; `meter` increments in Redis/DB (survives restarts, scales horizontally).
3. When `used` nears `cap`, the app already shows the upsell — wire the button to a Stripe upgrade link.

# Going live — the calm, copy-paste guide

Goal: turn Veil into something people can **pay for and use with no API key.** About **30–45 minutes**, ~**$7/month** to run.

Do the steps **in order**. Don't skip ahead. Each step ends with something you copy and paste into the next.

You'll make 4 free accounts as you go: **Anthropic**, **Groq**, **Stripe**, **Render**, **Netlify**. Get them as you hit each step — no need to do it all upfront.

---

## Step 1 — Get your two AI keys (5 min)

These are the keys *you* hold on the server (customers never see them).

1. **Anthropic** → https://console.anthropic.com/settings/keys → "Create Key" → copy it (starts `sk-ant-`). Add ~$20 of credit under Billing.
2. **Groq** (free, powers the Listen feature) → https://console.groq.com/keys → "Create API Key" → copy it (starts `gsk_`).

Paste both into a notes file for a minute. You'll need them in Step 3.

---

## Step 2 — Deploy the server (10 min)

1. Go to https://render.com → sign up with your GitHub.
2. **New +** → **Blueprint** → pick the **`veil`** repo → Render finds `render.yaml` automatically → **Apply**.
3. It'll ask for the secret values. Fill in what you have so far:
   - `ANTHROPIC_API_KEY` → your `sk-ant-…` key
   - `GROQ_API_KEY` → your `gsk_…` key
   - `APP_PUBLIC_URL` → **leave blank for now** (you'll get the URL in a second)
   - The `STRIPE_*` ones → **leave blank for now** (Step 3)
4. Click **Create**. Wait ~2 min for it to go live.
5. Copy your server URL (looks like `https://veil-server.onrender.com`).
6. Go to the service → **Environment** → set `APP_PUBLIC_URL` to that URL → save (it redeploys).
7. Test it: open `https://your-url.onrender.com/health` in a browser. You should see `{"ok":true,"anthropic":true,...}`. ✅

---

## Step 3 — Set up payments (Stripe, 10 min)

1. Go to https://stripe.com → create an account. **Stay in Test mode** (toggle, top right) until the very end.
2. **Products** → **Add product**: name "Veil Pro", price **$12 / month, recurring**. Save. Copy the **price ID** (looks like `price_…`).
3. **Payment Links** → **New** → choose the Veil Pro price → under **After payment**, choose **"Don't show confirmation page — redirect"** and set the URL to:
   ```
   https://your-url.onrender.com/success?session_id={CHECKOUT_SESSION_ID}
   ```
   (paste your real Render URL). Create the link and **copy it** (looks like `https://buy.stripe.com/…`).
4. **Developers → Webhooks → Add endpoint**:
   - Endpoint URL: `https://your-url.onrender.com/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Save, then copy the **Signing secret** (starts `whsec_`).
5. Back in **Render → Environment**, set:
   - `STRIPE_SECRET_KEY` → from Stripe **Developers → API keys** (the *secret* key)
   - `STRIPE_WEBHOOK_SECRET` → the `whsec_…` from step 4
   - `STRIPE_PRICE_PRO` → the `price_…` from step 2
   - Save (it redeploys).

---

## Step 4 — Point the app at your live server (2 min — I can do this for you)

The app needs to know your server URL and your payment link. Tell me both:
- your Render URL (`https://…onrender.com`)
- your Stripe Payment Link (`https://buy.stripe.com/…`)

…and I'll set them in `src/store.js` for you and rebuild. (Or do it yourself: in `src/store.js`, set `managedUrl` to your Render URL and `checkoutUrl` to your Payment Link.)

---

## Step 5 — Build the app + put it where people download it (5 min)

1. `npm run dist:win` → produces `dist/Veil-Setup-0.1.0.exe`.
2. On GitHub → your `veil` repo → **Releases** → **Draft a new release** → tag `v0.1.0` → drag in `Veil-Setup-0.1.0.exe` → **Publish**.
   (The landing page's Download buttons already point at `releases/latest`, so they'll just work.)

---

## Step 6 — Put the landing page online (5 min)

1. https://netlify.com → sign up with GitHub.
2. **Add new site → Import an existing project** → pick the `veil` repo → it reads `netlify.toml` → **Deploy**.
3. You get a URL like `your-site.netlify.app`. (Add a custom domain later if you want.)

---

## Step 7 — Test the whole thing (5 min)

1. Install the app from your GitHub Release.
2. Open it → **Get Veil — no setup**. It opens your Stripe Payment Link.
3. Pay with Stripe's **test card**: `4242 4242 4242 4242`, any future date, any CVC.
4. Stripe redirects you → "You're in 🎉" → click **Open Veil** → the app activates itself. **No key typed.** ✅
5. Hit `Ctrl+Enter` — you get an answer. You just sold (test) your first copy.

When it all works: in Stripe, flip from **Test** to **Live mode**, redo the Payment Link + webhook with live keys, update those two env vars on Render. Now it takes real money.

---

## If something breaks
- `/health` shows `anthropic:false` → the `ANTHROPIC_API_KEY` env var isn't set/saved on Render.
- Paid but app didn't activate → check the Payment Link's redirect URL has `/success?session_id={CHECKOUT_SESSION_ID}` exactly.
- "Could not verify payment" → `STRIPE_SECRET_KEY` on Render is wrong or still a test key while you're live (or vice-versa).
- Tell me the symptom and I'll debug it with you.

That's the whole thing. Steps 1–3 are the only "thinky" parts; the rest is clicking Deploy.

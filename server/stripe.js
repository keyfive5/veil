// Stripe integration for the managed (no-key) tier.
//
// v1 uses Stripe **Payment Links** (configured in the Stripe dashboard) — no
// checkout endpoint to build. We just listen to the webhook: a completed payment
// provisions a license and an activation token, which becomes the magic link.
const db = require('./db');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const enabled = !!SECRET;
const stripe = enabled ? require('stripe')(SECRET) : null;

// Map a Stripe price ID → our plan name (set these env vars to your price IDs).
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_PRO || '']: 'pro',
  [process.env.STRIPE_PRICE_LIFETIME || '']: 'lifetime',
  [process.env.STRIPE_PRICE_ENTERPRISE || '']: 'enterprise',
};
function priceToPlan(priceId) { return PRICE_TO_PLAN[priceId] || null; }

async function planForSession(session) {
  if (session.metadata && session.metadata.plan) return session.metadata.plan;
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const priceId = items.data[0] && items.data[0].price && items.data[0].price.id;
    return priceToPlan(priceId) || 'pro';
  } catch {
    return 'pro';
  }
}

// Stripe is our durable, free store. We stamp the license key onto the Stripe
// customer so a user can restore their subscription from just the key — even if our
// local cache (SQLite) was wiped (e.g. a free-tier server with no persistent disk).
async function saveLicenseToCustomer(customerId, key, plan) {
  if (!enabled || !customerId) return;
  try {
    await stripe.customers.update(customerId, { metadata: { veil_license: key, veil_plan: plan } });
  } catch (e) {
    console.error('[veil] could not save license to Stripe customer:', e.message);
  }
}

// Look a license key up in Stripe and decide if it's still entitled. Lifetime /
// enterprise = always active; subscription plans = active only if a live subscription
// exists (so cancellations revoke access without needing our own database).
// Returns { key, plan, customerId } or null.
async function restoreByLicenseKey(key) {
  if (!enabled || !key) return null;
  let res;
  try {
    res = await stripe.customers.search({ query: `metadata['veil_license']:'${key}'`, limit: 1 });
  } catch (e) {
    console.error('[veil] stripe customer search failed:', e.message);
    return null;
  }
  const customer = res && res.data && res.data[0];
  if (!customer) return null;
  const plan = (customer.metadata && customer.metadata.veil_plan) || 'pro';
  if (plan === 'lifetime' || plan === 'enterprise') return { key, plan, customerId: customer.id };
  try {
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
    if (subs.data.length) return { key, plan, customerId: customer.id };
  } catch (e) {
    console.error('[veil] subscription check failed:', e.message);
  }
  return null;
}

// Verify the webhook signature and act on the event.
// Returns { type, email?, token? }. Throws on invalid signature.
async function verifyAndHandle(rawBody, signature) {
  if (!enabled) return { type: 'disabled' };
  // Require a verified signature. Refuse to process unverified webhooks (without
  // this, anyone who finds the URL could POST a fake "paid" event and mint licenses).
  // Set ALLOW_UNVERIFIED_WEBHOOKS=1 ONLY for local testing without a secret.
  if (!WEBHOOK_SECRET && process.env.ALLOW_UNVERIFIED_WEBHOOKS !== '1') {
    throw new Error('STRIPE_WEBHOOK_SECRET not set — refusing unverified webhook');
  }
  const event = WEBHOOK_SECRET
    ? stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET)
    : JSON.parse(rawBody.toString()); // only reached with ALLOW_UNVERIFIED_WEBHOOKS=1

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const plan = await planForSession(session);
      const { license } = db.createCustomerWithLicense({
        email: session.customer_details ? session.customer_details.email : session.customer_email,
        stripeCustomerId: session.customer,
        plan,
      });
      await saveLicenseToCustomer(session.customer, license.key, plan);
      const token = db.newActivationToken(license.key);
      return { type: 'activated', email: session.customer_email || (session.customer_details && session.customer_details.email), token, plan };
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const obj = event.data.object;
      if (obj.customer) db.deactivateByStripeCustomer(obj.customer);
      return { type: 'deactivated' };
    }
    default:
      return { type: 'ignored', event: event.type };
  }
}

// Provision (idempotently) from a completed Checkout Session id. Lets the
// post-payment redirect activate the user WITHOUT needing an email provider:
// Stripe → /success?session_id=… → we mint a token → veil:// opens the app.
async function provisionFromSessionId(sessionId) {
  if (!enabled) throw new Error('stripe disabled');
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) return null;
  const plan = await planForSession(session);
  const email = (session.customer_details && session.customer_details.email) || session.customer_email;
  const { license } = db.createCustomerWithLicense({ email, stripeCustomerId: session.customer, plan });
  await saveLicenseToCustomer(session.customer, license.key, plan);
  return license;
}

module.exports = { enabled, verifyAndHandle, provisionFromSessionId, priceToPlan, restoreByLicenseKey };

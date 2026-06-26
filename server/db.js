// License + account store for the managed (no-key) tier. SQLite via better-sqlite3
// — a single file, zero external service. All SQL lives behind this module, so
// swapping to Postgres later is a localized change.
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'veil.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    stripe_customer_id TEXT,
    plan TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY,
    customer_id INTEGER,
    plan TEXT,
    monthly_cap INTEGER,
    status TEXT DEFAULT 'active',
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS usage (
    license_key TEXT,
    month TEXT,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (license_key, month)
  );
  CREATE TABLE IF NOT EXISTS activation_tokens (
    token TEXT PRIMARY KEY,
    license_key TEXT,
    expires_at INTEGER,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS trials (
    device_id TEXT PRIMARY KEY,
    license_key TEXT,
    created_at INTEGER
  );
  -- First-party, cookieless website analytics: aggregate counts only, no IP / no PII.
  CREATE TABLE IF NOT EXISTS analytics (
    event TEXT,
    day TEXT,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (event, day)
  );
  CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers (stripe_customer_id);
  CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
`);

// Per-plan monthly request cap (the cost guard + upsell trigger).
const PLAN_CAPS = {
  free: parseInt(process.env.CAP_FREE || '500', 10),   // monthly free uses/device (runs on free Groq AI, $0 to us)
  pro: parseInt(process.env.CAP_PRO || '8000', 10),
  lifetime: parseInt(process.env.CAP_LIFETIME || '8000', 10),
  enterprise: parseInt(process.env.CAP_ENTERPRISE || '200000', 10),
};
const capFor = (plan) => PLAN_CAPS[plan] || PLAN_CAPS.pro;

function genLicenseKey() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `VEIL-${part()}-${part()}-${part()}`;
}

const monthKey = () => new Date().toISOString().slice(0, 7);

// Create (or reuse) a customer for a Stripe customer id, and issue a license.
function createCustomerWithLicense({ email, stripeCustomerId, plan }) {
  const now = Date.now();
  let customer = stripeCustomerId
    ? db.prepare('SELECT * FROM customers WHERE stripe_customer_id = ?').get(stripeCustomerId)
    : null;
  if (!customer) {
    const info = db.prepare(
      'INSERT INTO customers (email, stripe_customer_id, plan, status, created_at) VALUES (?,?,?,?,?)'
    ).run(email || null, stripeCustomerId || null, plan, 'active', now);
    customer = { id: info.lastInsertRowid, email, plan };
  } else {
    db.prepare('UPDATE customers SET plan = ?, status = ?, email = COALESCE(?, email) WHERE id = ?')
      .run(plan, 'active', email || null, customer.id);
  }
  // Reuse an existing active license for this customer, else mint one.
  let lic = db.prepare("SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1").get(customer.id);
  if (!lic) {
    const key = genLicenseKey();
    db.prepare('INSERT INTO licenses (key, customer_id, plan, monthly_cap, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(key, customer.id, plan, capFor(plan), 'active', now);
    lic = { key, plan, monthly_cap: capFor(plan), status: 'active' };
  } else {
    db.prepare('UPDATE licenses SET plan = ?, monthly_cap = ?, status = ? WHERE key = ?')
      .run(plan, capFor(plan), 'active', lic.key);
    lic = { ...lic, plan, monthly_cap: capFor(plan), status: 'active' };
  }
  return { customerId: customer.id, license: lic };
}

const getLicense = (key) => db.prepare('SELECT * FROM licenses WHERE key = ?').get(key) || null;

// Insert or refresh a license in the local cache. Used when restoring a paid license
// from Stripe after the ephemeral cache was cleared (e.g. a free-tier server restart),
// so the SQLite file is just a rebuildable cache — Stripe is the source of truth.
function upsertLicense({ key, plan, customerId = null }) {
  const existing = getLicense(key);
  if (existing) {
    db.prepare('UPDATE licenses SET plan = ?, monthly_cap = ?, status = ? WHERE key = ?')
      .run(plan, capFor(plan), 'active', key);
  } else {
    db.prepare('INSERT INTO licenses (key, customer_id, plan, monthly_cap, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(key, customerId, plan, capFor(plan), 'active', Date.now());
  }
  return getLicense(key);
}

function deactivateByStripeCustomer(stripeCustomerId) {
  const c = db.prepare('SELECT id FROM customers WHERE stripe_customer_id = ?').get(stripeCustomerId);
  if (!c) return;
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run('inactive', c.id);
  db.prepare('UPDATE licenses SET status = ? WHERE customer_id = ?').run('inactive', c.id);
}

function getUsage(key) {
  const lic = getLicense(key);
  if (!lic) return null;
  const row = db.prepare('SELECT count FROM usage WHERE license_key = ? AND month = ?').get(key, monthKey());
  const used = row ? row.count : 0;
  return { used, cap: lic.monthly_cap, remaining: Math.max(0, lic.monthly_cap - used), plan: lic.plan };
}
function incUsage(key) {
  const m = monthKey();
  db.prepare(`INSERT INTO usage (license_key, month, count) VALUES (?, ?, 1)
              ON CONFLICT(license_key, month) DO UPDATE SET count = count + 1`).run(key, m);
  return getUsage(key);
}

// One free license per device. Idempotent: same device id always gets the same
// license (reinstalling doesn't hand out a fresh allowance). Free licenses run on
// the free Groq AI server-side, so they cost us nothing.
function getOrCreateFree(deviceId) {
  const existing = db.prepare('SELECT license_key FROM trials WHERE device_id = ?').get(deviceId);
  if (existing) {
    const lic = getLicense(existing.license_key);
    if (lic) return lic;
  }
  const key = genLicenseKey();
  const cap = PLAN_CAPS.free;
  const now = Date.now();
  db.prepare('INSERT INTO licenses (key, customer_id, plan, monthly_cap, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(key, null, 'free', cap, 'active', now);
  db.prepare('INSERT OR REPLACE INTO trials (device_id, license_key, created_at) VALUES (?,?,?)')
    .run(deviceId, key, now);
  return { key, plan: 'free', monthly_cap: cap, status: 'active' };
}

function newActivationToken(licenseKey, ttlMs = 15 * 60 * 1000) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO activation_tokens (token, license_key, expires_at, used) VALUES (?,?,?,0)')
    .run(token, licenseKey, Date.now() + ttlMs);
  return token;
}
function consumeToken(token) {
  const row = db.prepare('SELECT * FROM activation_tokens WHERE token = ?').get(token);
  if (!row || row.used || row.expires_at < Date.now()) return null;
  db.prepare('UPDATE activation_tokens SET used = 1 WHERE token = ?').run(token);
  const lic = getLicense(row.license_key);
  if (!lic || lic.status !== 'active') return null;
  return { licenseKey: lic.key, plan: lic.plan };
}

// ---- First-party analytics (aggregate counts only) ----
const today = () => new Date().toISOString().slice(0, 10);

function bumpHit(event) {
  db.prepare(`INSERT INTO analytics (event, day, count) VALUES (?, ?, 1)
              ON CONFLICT(event, day) DO UPDATE SET count = count + 1`).run(event, today());
}

// Everything the stats dashboard needs: site events + license/usage signal.
function analyticsSummary() {
  const t = today();
  const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const events = {};
  for (const r of db.prepare('SELECT event, day, count FROM analytics').all()) {
    const e = events[r.event] || (events[r.event] = { total: 0, last7: 0, today: 0 });
    e.total += r.count;
    if (r.day >= since) e.last7 += r.count;
    if (r.day === t) e.today += r.count;
  }
  const m = monthKey();
  const licenses = {
    total: db.prepare('SELECT COUNT(*) c FROM licenses').get().c,
    byPlan: db.prepare('SELECT plan, COUNT(*) c FROM licenses GROUP BY plan').all(),
    activeThisMonth: db.prepare('SELECT COUNT(DISTINCT license_key) c FROM usage WHERE month = ? AND count > 0').get(m).c,
    requestsThisMonth: db.prepare('SELECT COALESCE(SUM(count),0) c FROM usage WHERE month = ?').get(m).c,
  };
  return { events, licenses, month: m };
}

module.exports = {
  db,
  createCustomerWithLicense, getLicense, upsertLicense,
  deactivateByStripeCustomer,
  getUsage, incUsage, getOrCreateFree, newActivationToken, consumeToken,
  bumpHit, analyticsSummary,
};

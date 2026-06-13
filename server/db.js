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
  CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers (stripe_customer_id);
  CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
`);

// Per-plan monthly request cap (the cost guard + upsell trigger).
const PLAN_CAPS = {
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
const getCustomerByEmail = (email) => db.prepare('SELECT * FROM customers WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email) || null;
const licenseForCustomerId = (id) => db.prepare('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1').get(id) || null;

function setLicenseStatus(key, status) {
  db.prepare('UPDATE licenses SET status = ? WHERE key = ?').run(status, key);
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
  return { used, cap: lic.monthly_cap, remaining: Math.max(0, lic.monthly_cap - used) };
}
function incUsage(key) {
  const m = monthKey();
  db.prepare(`INSERT INTO usage (license_key, month, count) VALUES (?, ?, 1)
              ON CONFLICT(license_key, month) DO UPDATE SET count = count + 1`).run(key, m);
  return getUsage(key);
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

module.exports = {
  db, capFor,
  createCustomerWithLicense, getLicense, getCustomerByEmail, licenseForCustomerId,
  setLicenseStatus, deactivateByStripeCustomer,
  getUsage, incUsage, newActivationToken, consumeToken,
};

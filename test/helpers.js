const fs = require('fs'); const path = require('path');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!process.env.DATABASE_URL || !/test/i.test(process.env.DATABASE_URL))
  throw new Error('Refusing to run: set TEST_DATABASE_URL to a database whose name contains "test" (the tests DROP the schema)');
process.env.JWT_SECRET = 'test-secret';
process.env.DEMO_PASSWORD = 'LedgerLine#2026';

const pool = require('../src/db');
const ledger = require('../src/ledger');
const app = require('../src/app');
const { seed } = require('../src/seed');
const crypto = require('crypto');

let server, base;
async function setup() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  ledger.resetCache();
  await seed({ demo: true });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function teardown() { await new Promise((r) => server.close(r)); await pool.end(); }

async function call(token, method, url, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, replay: res.headers.get('idempotent-replay') === 'true' };
}
async function login(email) {
  const r = await call(null, 'POST', '/api/auth/login', { email, password: 'LedgerLine#2026' });
  return r.body.token;
}
const k = () => crypto.randomUUID();
async function accountOf(token) { return (await call(token, 'GET', '/api/accounts')).body[0].id; }
async function balance(token, id) { return (await call(token, 'GET', `/api/accounts/${id}`)).body.balance_paise; }

// Fresh, isolated accounts for each test so tests do not depend on each other's balances.
async function freshAccount(adminTok, ownerEmail, fundPaise = 0) {
  const u = (await call(adminTok, 'GET', '/api/users')).body.find((x) => x.email === ownerEmail);
  const a = (await call(adminTok, 'POST', '/api/accounts', { name: 'test-' + k().slice(0, 6), owner_id: u.id })).body;
  if (fundPaise) await call(adminTok, 'POST', `/api/accounts/${a.id}/deposits`, { amount_paise: fundPaise }, k());
  return a.id;
}
module.exports = { setup, teardown, call, login, k, accountOf, balance, freshAccount, pool, ledger };

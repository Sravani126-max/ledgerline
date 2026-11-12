const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const ledger = require('./ledger');
const { HttpError } = require('./errors');

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required in production');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { // request id for correlating errors
  req.id = crypto.randomUUID(); res.setHeader('X-Request-Id', req.id); next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- authentication: role is always re-read from the database, never trusted from the token ----
const auth = wrap(async (req, _res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  let payload;
  try { payload = jwt.verify(m[1], JWT_SECRET); } catch { throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token'); }
  const { rows } = await pool.query('SELECT id, email, role FROM users WHERE id=$1', [payload.sub]);
  if (!rows.length) throw new HttpError(401, 'UNAUTHENTICATED', 'Unknown user');
  req.user = rows[0];
  next();
});
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) {
    ledger.audit(req.user.id, 'FORBIDDEN_ROUTE', { route: `${req.method} ${req.path}`, role: req.user.role }).catch(() => {});
    return next(new HttpError(403, 'FORBIDDEN', 'Your role may not perform this action'));
  }
  next();
};
const int = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v);

app.get('/health', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

// ---- login (constant-ish work for unknown users to blunt user enumeration) ----
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'INVALID_INPUT', 'email and password required');
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { await ledger.audit(u ? u.id : null, 'LOGIN_FAILED', { email: email.slice(0, 100) }); throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid email or password'); }
  await ledger.audit(u.id, 'LOGIN_OK');
  res.json({ token: jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '8h' }), user: { id: u.id, email: u.email, role: u.role } });
}));

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---- administration ----
app.post('/api/users', auth, requireRole('admin'), wrap(async (req, res) => {
  const { email, password, role } = req.body || {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'INVALID_EMAIL', 'valid email required');
  if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'WEAK_PASSWORD', 'password must be at least 10 characters');
  if (!['admin', 'holder', 'auditor'].includes(role)) throw new HttpError(400, 'INVALID_ROLE', 'role must be admin, holder or auditor');
  try {
    const { rows } = await pool.query('INSERT INTO users(email, password_hash, role) VALUES ($1,$2,$3) RETURNING id,email,role',
      [email.toLowerCase(), await bcrypt.hash(password, 10), role]);
    await ledger.audit(req.user.id, 'USER_CREATED', { user: rows[0].id, role });
    res.status(201).json(rows[0]);
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'EMAIL_TAKEN', 'email already registered'); throw e; }
}));
app.get('/api/users', auth, requireRole('admin', 'auditor'), wrap(async (_req, res) => {
  res.json((await pool.query('SELECT id,email,role,created_at FROM users ORDER BY id')).rows);
}));

app.post('/api/accounts', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name } = req.body || {}; const owner = int(req.body && req.body.owner_id);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new HttpError(400, 'INVALID_NAME', 'name required (max 100 chars)');
  if (!Number.isSafeInteger(owner)) throw new HttpError(400, 'INVALID_OWNER', 'owner_id required');
  const u = (await pool.query('SELECT role FROM users WHERE id=$1', [owner])).rows[0];
  if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'owner not found');
  if (u.role === 'auditor') throw new HttpError(400, 'INVALID_OWNER', 'auditors cannot own accounts');
  const { rows } = await pool.query('INSERT INTO accounts(name, owner_id) VALUES ($1,$2) RETURNING id,name,owner_id,balance_paise,created_at', [name.trim(), owner]);
  await ledger.audit(req.user.id, 'ACCOUNT_CREATED', { account: rows[0].id, owner });
  res.status(201).json(rows[0]);
}));

app.get('/api/accounts', auth, wrap(async (req, res) => {
  const priv = req.user.role !== 'holder';
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.owner_id, u.email AS owner_email, a.balance_paise FROM accounts a LEFT JOIN users u ON u.id=a.owner_id
      WHERE NOT a.is_external AND ($1 OR a.owner_id=$2) ORDER BY a.id`, [priv, req.user.id]);
  res.json(rows);
}));

// Holders get 404 (not 403) for accounts that are not theirs, so account ids cannot be probed.
async function viewable(req) {
  const id = int(req.params.id);
  if (!Number.isSafeInteger(id) || !(await ledger.canView(req.user, id))) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  return id;
}
app.get('/api/accounts/:id', auth, wrap(async (req, res) => {
  const id = await viewable(req);
  res.json((await pool.query('SELECT id,name,owner_id,balance_paise FROM accounts WHERE id=$1', [id])).rows[0]);
}));
app.get('/api/accounts/:id/statement', auth, wrap(async (req, res) => {
  const id = await viewable(req);
  res.json(await ledger.statement(req.user, id));
}));

// ---- money movement ----
function respond(res, { replay, txn }) {
  if (replay) res.setHeader('Idempotent-Replay', 'true');
  const body = { transaction: ledger.shape(txn) };
  if (txn.status === 'REFUSED') return res.status(422).json({ error: txn.reason, message: 'The movement was refused and recorded', ...body });
  res.status(201).json(body);
}
const key = (req) => req.get('Idempotency-Key');
const body = (req) => req.body || {};

app.post('/api/accounts/:id/deposits', auth, wrap(async (req, res) => {
  respond(res, await ledger.deposit(req.user, int(req.params.id), body(req).amount_paise, key(req), body(req).memo));
}));
app.post('/api/accounts/:id/withdrawals', auth, wrap(async (req, res) => {
  respond(res, await ledger.withdraw(req.user, int(req.params.id), body(req).amount_paise, key(req), body(req).memo));
}));
app.post('/api/transfers', auth, wrap(async (req, res) => {
  const b = body(req);
  respond(res, await ledger.transfer(req.user, int(b.from_account_id), int(b.to_account_id), b.amount_paise, key(req), b.memo));
}));

// ---- oversight (read-only) ----
app.get('/api/audit-log', auth, requireRole('admin', 'auditor'), wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json((await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).rows);
}));
app.get('/api/replays', auth, requireRole('admin', 'auditor'), wrap(async (_req, res) => {
  res.json((await pool.query(`SELECT r.*, t.idempotency_key FROM idempotency_replays r JOIN transactions t ON t.id=r.txn_id ORDER BY r.id DESC LIMIT 200`)).rows);
}));
app.get('/api/reconcile', auth, requireRole('admin', 'auditor'), wrap(async (_req, res) => res.json(await ledger.reconcile())));

// ---- errors ----
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint')));
app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON' });
  console.error(`[${req.id}]`, err); // never leak internals; the request id lets an operator find this line
  res.status(500).json({ error: 'INTERNAL', message: 'Unexpected error', request_id: req.id });
});

module.exports = app;

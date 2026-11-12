const crypto = require('crypto');
const pool = require('./db');
const { HttpError } = require('./errors');

const MAX_AMOUNT_PAISE = parseInt(process.env.MAX_AMOUNT_PAISE || '1000000000', 10); // Rs 1 crore per movement
const RETRY = Symbol('retry');

let externalIdCache = null;
async function externalId() {
  if (externalIdCache) return externalIdCache;
  const { rows } = await pool.query('SELECT id FROM accounts WHERE is_external');
  if (!rows.length) throw new Error('external account missing: run npm run seed');
  externalIdCache = rows[0].id;
  return externalIdCache;
}
function resetCache() { externalIdCache = null; }

async function audit(actorId, action, detail = {}, client = pool) {
  await client.query('INSERT INTO audit_log(actor_id, action, detail) VALUES ($1,$2,$3)', [actorId, action, detail]);
}

function requestHash(p) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([p.kind, p.from, p.to, p.amount, p.memo || '']))
    .digest('hex');
}

function validate(p) {
  const key = p.key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars: A-Z a-z 0-9 . _ : -) is required');
  if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT_PAISE)
    throw new HttpError(400, 'INVALID_AMOUNT', `amount_paise must be an integer between 1 and ${MAX_AMOUNT_PAISE}`);
  if (p.memo != null && (typeof p.memo !== 'string' || p.memo.length > 200))
    throw new HttpError(400, 'INVALID_MEMO', 'memo must be a string up to 200 chars');
  for (const id of [p.from, p.to])
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'INVALID_ACCOUNT', 'account ids must be positive integers');
  if (p.from === p.to) throw new HttpError(400, 'SAME_ACCOUNT', 'source and destination must differ');
}

// Authorisation is decided here, on the server, for every request. The role comes from the DB row, not the token.
async function authorize(user, p, accts) {
  const deny = async (why) => {
    await audit(user.id, 'FORBIDDEN_MOVEMENT', { kind: p.kind, from: p.from, to: p.to, amount: p.amount, why });
    throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to perform this movement on this account');
  };
  if (user.role === 'auditor') return deny('auditor is read-only');
  const owns = (a) => a.owner_id === user.id;
  if (p.kind === 'DEPOSIT') {
    if (!(user.role === 'admin' || owns(accts.get(p.to)))) return deny('not owner/admin of destination');
  } else if (p.kind === 'WITHDRAWAL') {
    if (!owns(accts.get(p.from))) return deny('not owner of source');
  } else if (p.kind === 'TRANSFER') {
    if (!owns(accts.get(p.from))) return deny('not owner of source');
  }
}

async function findByKey(client, userId, key) {
  const { rows } = await client.query('SELECT * FROM transactions WHERE initiated_by=$1 AND idempotency_key=$2', [userId, key]);
  return rows[0];
}

function shape(t) {
  return {
    id: t.id, seq: t.seq, kind: t.kind, status: t.status, reason: t.reason, amount_paise: t.amount_paise,
    from_account_id: t.from_account_id, to_account_id: t.to_account_id, memo: t.memo,
    source_balance_seen_paise: t.source_balance_seen_paise, created_at: t.created_at,
  };
}

async function attempt(user, p, hash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');                       // READ COMMITTED + explicit row locks (see THREATS.md T1)
    // 1. Lock every account involved, ALWAYS in ascending id order => no lock-order deadlocks.
    const ids = [p.from, p.to].sort((a, b) => a - b);
    const { rows: locked } = await client.query(
      'SELECT id, balance_paise, is_external FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
    const lockedById = new Map(locked.map((r) => [r.id, r]));

    // 2. Idempotency check AFTER taking the locks, so a concurrent duplicate that waited sees the committed original.
    const existing = await findByKey(client, user.id, p.key);
    if (existing) {
      const matched = existing.request_hash === hash;
      await client.query('INSERT INTO idempotency_replays(txn_id, replayed_by, payload_matched) VALUES ($1,$2,$3)', [existing.id, user.id, matched]);
      if (!matched) await audit(user.id, 'IDEMPOTENCY_KEY_REUSE_MISMATCH', { key: p.key, txn: existing.id }, client);
      await client.query('COMMIT');
      if (!matched) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request');
      return { replay: true, txn: existing };
    }

    // 3. Decide. The balance we read is the balance we will debit: we hold the row lock until COMMIT.
    const src = lockedById.get(p.from);
    let status = 'POSTED', reason = null;
    if (!src.is_external && src.balance_paise < p.amount) { status = 'REFUSED'; reason = 'INSUFFICIENT_FUNDS'; }

    // 4. Record the attempt (posted or refused). ON CONFLICT is the final exactly-once guard.
    const ins = await client.query(
      `INSERT INTO transactions(kind,status,reason,amount_paise,from_account_id,to_account_id,initiated_by,idempotency_key,request_hash,source_balance_seen_paise,memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (initiated_by, idempotency_key) DO NOTHING RETURNING *`,
      [p.kind, status, reason, p.amount, p.from, p.to, user.id, p.key, hash, src.balance_paise, p.memo || null]);
    if (!ins.rows.length) { await client.query('ROLLBACK'); return RETRY; }
    const txn = ins.rows[0];

    // 5. Post both legs. Triggers update balances, hash chain, and enforce zero-sum + floor at COMMIT.
    if (status === 'POSTED') {
      await client.query('INSERT INTO entries(txn_id, account_id, amount_paise) VALUES ($1,$2,$3)', [txn.id, p.from, -p.amount]);
      await client.query('INSERT INTO entries(txn_id, account_id, amount_paise) VALUES ($1,$2,$3)', [txn.id, p.to, p.amount]);
    }
    await client.query('COMMIT');
    return { replay: false, txn };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already finished */ }
    throw e;
  } finally {
    client.release();
  }
}

async function move(user, p) {
  validate(p);
  const { rows } = await pool.query('SELECT id, owner_id, is_external FROM accounts WHERE id = ANY($1::bigint[])', [[p.from, p.to]]);
  const accts = new Map(rows.map((r) => [r.id, r]));
  const ext = await externalId();
  for (const id of [p.from, p.to]) if (!accts.has(id)) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  // The external counterparty is only reachable through deposit/withdraw; it can never be named by a client.
  if (p.kind === 'TRANSFER' && (p.from === ext || p.to === ext)) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  await authorize(user, p, accts);
  const hash = requestHash(p);
  for (let i = 0; i < 3; i++) {
    const r = await attempt(user, p, hash);
    if (r !== RETRY) return r;
  }
  throw new HttpError(409, 'CONFLICT', 'Concurrent request with the same key; retry');
}

async function deposit(user, accountId, amount, key, memo) {
  return move(user, { kind: 'DEPOSIT', from: await externalId(), to: accountId, amount, key, memo });
}
async function withdraw(user, accountId, amount, key, memo) {
  return move(user, { kind: 'WITHDRAWAL', from: accountId, to: await externalId(), amount, key, memo });
}
async function transfer(user, from, to, amount, key, memo) {
  return move(user, { kind: 'TRANSFER', from, to, amount, key, memo });
}

async function canView(user, accountId) {
  if (user.role === 'admin' || user.role === 'auditor') return true;
  const { rows } = await pool.query('SELECT 1 FROM accounts WHERE id=$1 AND owner_id=$2 AND NOT is_external', [accountId, user.id]);
  return rows.length > 0;
}

async function statement(user, accountId) {
  const { rows } = await pool.query(
    `SELECT t.seq, t.id, t.kind, t.status, t.reason, t.amount_paise, t.from_account_id, t.to_account_id,
            t.initiated_by, u.email AS initiated_by_email, t.memo, t.created_at,
            e.amount_paise AS signed_amount_paise,
            CASE WHEN t.status='POSTED' THEN e.balance_after_paise
                 WHEN t.from_account_id=$1 THEN t.source_balance_seen_paise END AS running_balance_paise
       FROM transactions t
       JOIN users u ON u.id = t.initiated_by
       LEFT JOIN entries e ON e.txn_id = t.id AND e.account_id = $1
      WHERE t.from_account_id = $1 OR t.to_account_id = $1
      ORDER BY t.seq`, [accountId]);
  const privileged = user.role === 'admin' || user.role === 'auditor';
  return rows.map((r) => {
    const mine = r.initiated_by === user.id;
    const out = { ...r, initiated_by_email: privileged || mine ? r.initiated_by_email : null };
    if (!privileged && !mine) out.initiated_by = null; // a counterparty does not learn the sender's identity
    return out;
  });
}

// Reconciliation: proves the invariants from the data itself.
async function reconcile() {
  const q = async (sql) => (await pool.query(sql)).rows;
  const [{ total }] = await q('SELECT COALESCE(SUM(balance_paise),0)::bigint AS total FROM accounts');
  const [{ ext }] = await q('SELECT COALESCE(SUM(balance_paise),0)::bigint AS ext FROM accounts WHERE is_external');
  const [{ net }] = await q(`SELECT COALESCE(SUM(CASE kind WHEN 'DEPOSIT' THEN amount_paise WHEN 'WITHDRAWAL' THEN -amount_paise ELSE 0 END),0)::bigint AS net
                               FROM transactions WHERE status='POSTED'`);
  const unbalanced = await q('SELECT txn_id FROM entries GROUP BY txn_id HAVING SUM(amount_paise) <> 0');
  const drift = await q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, SUM(amount_paise) s FROM entries GROUP BY 1) e ON e.account_id=a.id
                          WHERE a.balance_paise <> COALESCE(e.s,0)`);
  const chains = await q('SELECT id FROM accounts WHERE NOT account_chain_ok(id)');
  const negatives = await q('SELECT id FROM accounts WHERE NOT is_external AND balance_paise < 0');
  const postedNoEntries = await q(`SELECT t.id FROM transactions t WHERE t.status='POSTED' AND (SELECT COUNT(*) FROM entries e WHERE e.txn_id=t.id) <> 2`);
  const checks = {
    all_balances_sum_to_zero: total === 0,
    customer_money_equals_net_external_flow: -ext === net,
    every_transaction_nets_to_zero: unbalanced.length === 0,
    no_balance_differs_from_its_entries: drift.length === 0,
    hash_chains_intact: chains.length === 0,
    no_account_below_zero: negatives.length === 0,
    every_posted_txn_has_two_legs: postedNoEntries.length === 0,
  };
  return {
    ok: Object.values(checks).every(Boolean), checks,
    totals: { sum_of_all_balances_paise: total, customer_balances_paise: -ext, net_external_flow_paise: net },
    problems: { unbalanced, drift, broken_chains: chains, negatives, postedNoEntries },
  };
}

module.exports = { deposit, withdraw, transfer, statement, canView, reconcile, audit, shape, externalId, resetCache, MAX_AMOUNT_PAISE };

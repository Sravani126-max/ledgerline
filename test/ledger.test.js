const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { call, k, pool } = H;

let admin, h1, h2, aud;
before(async () => {
  await H.setup();
  [admin, h1, h2, aud] = await Promise.all(['admin', 'holder1', 'holder2', 'auditor'].map((n) => H.login(`${n}@ledgerline.test`)));
});
after(() => H.teardown());

const reconcileOk = async () => {
  const r = await call(aud, 'GET', '/api/reconcile');
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r.body;
};

// ---------------- Requirement 7 / Threat T1: concurrency ----------------
test('T1 concurrent withdrawals cannot overdraw: exactly floor(balance/amount) succeed, the rest are cleanly refused', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const rs = await Promise.all(Array.from({ length: 30 }, () => call(h1, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 100 }, k())));
  const ok = rs.filter((r) => r.status === 201).length;
  const refused = rs.filter((r) => r.status === 422 && r.body.error === 'INSUFFICIENT_FUNDS').length;
  assert.equal(ok, 10);
  assert.equal(refused, 20);                       // anything else (e.g. a 500 from the DB floor) means a lock is missing
  assert.equal(await H.balance(h1, a), 0);
  await reconcileOk();
});

test('T1 concurrent transfers out of one account cannot overdraw it', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 5000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const rs = await Promise.all(Array.from({ length: 40 }, () => call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 300 }, k())));
  assert.equal(rs.filter((r) => r.status === 201).length, 16);          // 5000/300 = 16
  assert.equal(rs.filter((r) => r.status === 422).length, 24);
  assert.equal(await H.balance(h1, a), 200);
  assert.equal(await H.balance(h2, b), 4800);
  await reconcileOk();
});

test('T2 opposing concurrent transfers (A->B and B->A) never deadlock or error', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 10000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test', 10000);
  const reqs = [];
  for (let i = 0; i < 25; i++) {
    reqs.push(call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 100 }, k()));
    reqs.push(call(h2, 'POST', '/api/transfers', { from_account_id: b, to_account_id: a, amount_paise: 100 }, k()));
  }
  const rs = await Promise.all(reqs);
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.filter((r) => r.status !== 201)[0]));
  assert.equal((await H.balance(h1, a)) + (await H.balance(h2, b)), 20000);
  await reconcileOk();
});

// ---------------- Requirement 6 / Threat T3: idempotency ----------------
test('T3 sequential replay of a transfer moves money once and returns the original result', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const key = k();
  const first = await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 400 }, key);
  const second = await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 400 }, key);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(second.replay, true); assert.equal(first.replay, false);
  assert.equal(second.body.transaction.id, first.body.transaction.id);
  assert.equal(await H.balance(h1, a), 600);
  const { rows } = await pool.query('SELECT count(*)::int n FROM idempotency_replays r JOIN transactions t ON t.id=r.txn_id WHERE t.idempotency_key=$1', [key]);
  assert.equal(rows[0].n, 1);                       // the duplicate is provable in the data
});

test('T3 20 simultaneous requests with the SAME key (double-click / retry storm) post exactly once', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const key = k();
  const rs = await Promise.all(Array.from({ length: 20 }, () => call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 250 }, key)));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.find((r) => r.status !== 201)));
  assert.equal(new Set(rs.map((r) => r.body.transaction.id)).size, 1);
  assert.equal(rs.filter((r) => !r.replay).length, 1);
  assert.equal(await H.balance(h1, a), 750);
  const { rows } = await pool.query('SELECT count(*)::int n FROM transactions WHERE idempotency_key=$1', [key]);
  assert.equal(rows[0].n, 1);
  await reconcileOk();
});

test('T3 same key + different payload is rejected and moves nothing', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const key = k();
  await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 100 }, key);
  const r = await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 900 }, key);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'IDEMPOTENCY_KEY_REUSE');
  assert.equal(await H.balance(h1, a), 900);
});

test('T3 a REFUSED request replayed after funds arrive stays refused (never pays later)', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 100);
  const key = k();
  const r1 = await call(h1, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 500 }, key);
  assert.equal(r1.status, 422);
  await call(admin, 'POST', `/api/accounts/${a}/deposits`, { amount_paise: 10000 }, k());
  const r2 = await call(h1, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 500 }, key);
  assert.equal(r2.status, 422); assert.equal(r2.replay, true);
  assert.equal(await H.balance(h1, a), 10100);
});

test('T3 an idempotency key is scoped per user: another user reusing it gets their own transaction', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 100);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test', 100);
  const key = k();
  const r1 = await call(h1, 'POST', `/api/accounts/${a}/deposits`, { amount_paise: 10 }, key);
  const r2 = await call(h2, 'POST', `/api/accounts/${b}/deposits`, { amount_paise: 10 }, key);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.notEqual(r1.body.transaction.id, r2.body.transaction.id);
});

// ---------------- Requirement 9 / Threat T4: authorisation ----------------
test('T4 a holder cannot withdraw from, transfer out of, or view another holder\'s account', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 5000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const w = await call(h2, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 100 }, k());
  const t = await call(h2, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 100 }, k());
  assert.equal(w.status, 403); assert.equal(t.status, 403);
  assert.equal((await call(h2, 'GET', `/api/accounts/${a}`)).status, 404);
  assert.equal((await call(h2, 'GET', `/api/accounts/${a}/statement`)).status, 404);
  assert.equal(await H.balance(h1, a), 5000);
  const log = (await call(aud, 'GET', '/api/audit-log')).body;
  assert.ok(log.some((l) => l.action === 'FORBIDDEN_MOVEMENT'));
});

test('T4 holder cannot deposit into someone else\'s account; admin cannot withdraw/transfer out of a holder\'s account; auditor cannot move money', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  assert.equal((await call(h2, 'POST', `/api/accounts/${a}/deposits`, { amount_paise: 1 }, k())).status, 403);
  assert.equal((await call(admin, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 1 }, k())).status, 403);
  assert.equal((await call(admin, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 1 }, k())).status, 403);
  assert.equal((await call(aud, 'POST', `/api/accounts/${a}/deposits`, { amount_paise: 1 }, k())).status, 403);
  assert.equal((await call(aud, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 1 }, k())).status, 403);
  assert.equal(await H.balance(h1, a), 1000);
});

test('T4 role gates: holders/auditors cannot administer; unauthenticated is 401', async () => {
  assert.equal((await call(h1, 'POST', '/api/users', { email: 'x@y.z', password: 'longenough1', role: 'admin' })).status, 403);
  assert.equal((await call(aud, 'POST', '/api/accounts', { name: 'x', owner_id: 1 })).status, 403);
  assert.equal((await call(h1, 'GET', '/api/audit-log')).status, 403);
  assert.equal((await call(h1, 'GET', '/api/reconcile')).status, 403);
  assert.equal((await call(null, 'GET', '/api/accounts')).status, 401);
  assert.equal((await call('garbage', 'GET', '/api/accounts')).status, 401);
});

test('T4 the external counterparty account cannot be named by a client', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const { rows } = await pool.query('SELECT id FROM accounts WHERE is_external');
  const ext = rows[0].id;
  assert.equal((await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: ext, amount_paise: 100 }, k())).status, 404);
  assert.equal((await call(admin, 'POST', '/api/transfers', { from_account_id: ext, to_account_id: a, amount_paise: 100 }, k())).status, 404);
  assert.equal((await call(h1, 'GET', `/api/accounts/${ext}`)).status, 404);
});

// ---------------- input validation ----------------
test('T5 invalid amounts / keys / accounts are rejected before touching money', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  const tr = (amount_paise, key = k(), to = b) => call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: to, amount_paise }, key);
  for (const bad of [0, -5, 1.5, '100', null, undefined, 1e18, NaN, Infinity]) assert.equal((await tr(bad)).status, 400, `amount ${bad}`);
  assert.equal((await tr(100, null)).status, 400);            // missing key (null => no header sent)
  assert.equal((await tr(100, 'short')).status, 400);
  assert.equal((await tr(100, k(), a)).status, 400);          // self transfer
  assert.equal((await tr(100, k(), 99999999)).status, 404);
  assert.equal(await H.balance(h1, a), 1000);
});

// ---------------- Requirement 4 / Threat T6: conservation ----------------
test('T6 conservation: a storm of mixed concurrent operations leaves every invariant intact', async () => {
  const accts = [];
  for (let i = 0; i < 4; i++) accts.push(await H.freshAccount(admin, i % 2 ? 'holder2@ledgerline.test' : 'holder1@ledgerline.test', 2000));
  const tok = (i) => (i % 2 ? h2 : h1);
  const reqs = [];
  for (let n = 0; n < 150; n++) {
    const i = n % 4, j = (n * 7 + 1) % 4; const amount = 50 + (n * 37) % 700;
    if (n % 5 === 0) reqs.push(call(tok(i), 'POST', `/api/accounts/${accts[i]}/withdrawals`, { amount_paise: amount }, k()));
    else if (n % 7 === 0) reqs.push(call(admin, 'POST', `/api/accounts/${accts[i]}/deposits`, { amount_paise: amount }, k()));
    else if (i !== j) reqs.push(call(tok(i), 'POST', '/api/transfers', { from_account_id: accts[i], to_account_id: accts[j], amount_paise: amount }, k()));
  }
  const rs = await Promise.all(reqs);
  assert.ok(rs.every((r) => [201, 422].includes(r.status)), JSON.stringify(rs.find((r) => ![201, 422].includes(r.status))));
  const rec = await reconcileOk();
  assert.equal(rec.totals.sum_of_all_balances_paise, 0);
  assert.equal(rec.totals.customer_balances_paise, rec.totals.net_external_flow_paise);
});

// ---------------- Requirement 8: statement ----------------
test('R8 statement lists debits, credits and refused attempts with running balance; counterparty identity is masked', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 1000);
  const b = await H.freshAccount(admin, 'holder2@ledgerline.test');
  await call(h1, 'POST', '/api/transfers', { from_account_id: a, to_account_id: b, amount_paise: 300, memo: 'rent' }, k());
  await call(h1, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 99999 }, k());
  const s = (await call(h1, 'GET', `/api/accounts/${a}/statement`)).body;
  assert.deepEqual(s.map((r) => [r.kind, r.status, r.running_balance_paise]), [['DEPOSIT', 'POSTED', 1000], ['TRANSFER', 'POSTED', 700], ['WITHDRAWAL', 'REFUSED', 700]]);
  assert.equal(s[1].signed_amount_paise, -300);
  assert.equal(s[0].initiated_by_email, null);                               // holder does not see the admin's identity on their deposit
  const sb = (await call(h2, 'GET', `/api/accounts/${b}/statement`)).body;
  assert.equal(sb[sb.length - 1].initiated_by_email, null);                  // recipient does not learn sender's email
  assert.equal((await call(aud, 'GET', `/api/accounts/${b}/statement`)).body.at(-1).initiated_by_email, 'holder1@ledgerline.test');
});

// ---------------- Requirement 5: the floor, enforced by the DB itself ----------------
test('T7 the database itself refuses a negative balance even if the application were bypassed', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 100);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = await c.query(`INSERT INTO transactions(kind,status,amount_paise,from_account_id,to_account_id,initiated_by,idempotency_key,request_hash)
      VALUES ('WITHDRAWAL','POSTED',500,$1,(SELECT id FROM accounts WHERE is_external),1,$2,'x') RETURNING id`, [a, k() + 'xxxx']);
    await assert.rejects(c.query(`INSERT INTO entries(txn_id,account_id,amount_paise) VALUES ($1,$2,-500)`, [t.rows[0].id, a]), /balance_floor/);
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('T8 the database refuses an unbalanced transaction at commit (conservation)', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 100);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = await c.query(`INSERT INTO transactions(kind,status,amount_paise,from_account_id,to_account_id,initiated_by,idempotency_key,request_hash)
      VALUES ('DEPOSIT','POSTED',500,(SELECT id FROM accounts WHERE is_external),$1,1,$2,'x') RETURNING id`, [a, k() + 'yyyy']);
    await c.query(`INSERT INTO entries(txn_id,account_id,amount_paise) VALUES ($1,$2,500)`, [t.rows[0].id, a]);   // credit with no matching debit
    await assert.rejects(c.query('COMMIT'), /does not balance/);
  } finally { try { await c.query('ROLLBACK'); } catch {} c.release(); }
  await reconcileOk();
});

// ---------------- Requirement 3 / Threat T9: append-only + tamper evidence ----------------
test('T9 ledger rows cannot be updated, deleted or truncated; balances cannot be set directly', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 100);
  for (const sql of [
    `UPDATE entries SET amount_paise = 1`, `DELETE FROM entries`, `TRUNCATE entries`,
    `UPDATE transactions SET amount_paise = 1`, `DELETE FROM transactions`, `TRUNCATE transactions CASCADE`,
    `UPDATE audit_log SET action = 'x'`, `DELETE FROM audit_log`, `UPDATE idempotency_replays SET payload_matched = false`,
    `UPDATE accounts SET balance_paise = 999999 WHERE id = ${a}`, `DELETE FROM accounts WHERE id = ${a}`,
  ]) await assert.rejects(pool.query(sql), /append-only|only change by posting/, sql);
});

test('T9 a ledger row altered by someone who bypasses the triggers is DETECTED by reconciliation', async () => {
  const a = await H.freshAccount(admin, 'holder1@ledgerline.test', 700);
  await call(h1, 'POST', `/api/accounts/${a}/withdrawals`, { amount_paise: 200 }, k());
  await reconcileOk();
  await pool.query('ALTER TABLE entries DISABLE TRIGGER USER');
  try {
    await pool.query('UPDATE entries SET amount_paise = -1 WHERE account_id=$1 AND amount_paise = -200', [a]);   // hide a payment
    const r = await call(aud, 'GET', '/api/reconcile');
    assert.equal(r.body.ok, false);
    assert.ok(r.body.problems.broken_chains.some((x) => x.id === a));
    await pool.query('UPDATE entries SET amount_paise = -200 WHERE account_id=$1 AND amount_paise = -1', [a]);   // restore
  } finally { await pool.query('ALTER TABLE entries ENABLE TRIGGER USER'); }
  await reconcileOk();
});

test('T10 the audit log records logins and administrative actions; failed logins are recorded', async () => {
  await call(null, 'POST', '/api/auth/login', { email: 'holder1@ledgerline.test', password: 'wrong-password' });
  const log = (await call(aud, 'GET', '/api/audit-log')).body;
  assert.ok(log.some((l) => l.action === 'LOGIN_FAILED'));
  assert.ok(log.some((l) => l.action === 'ACCOUNT_CREATED'));
});

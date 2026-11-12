# THREATS

How I believe the money or the ledger could be broken, what stops it, and what I knowingly left open. "Test" names the automated test that exercises it; I removed each guard in turn to confirm the matching test fails.

## Closed

| # | Attack | Defence | Test |
|---|---|---|---|
| T1 | **Overdraw by race.** Two withdrawals both read enough balance. | One transaction per movement. `SELECT … FOR UPDATE` on every account involved before the balance is read, held to COMMIT, so the balance checked is the balance debited. Backstop: `CHECK (is_external OR balance_paise >= 0)`. Isolation is READ COMMITTED + explicit row locks. | T1 ×2 (30 and 40 parallel requests; losers must be clean 422s, so a 500 from the backstop still fails the test) |
| T2 | **Deadlock** from opposing transfers A→B and B→A. | Locks always taken in ascending account id. | T2 |
| T3 | **Double payment** by retry, double-click, replay. | `UNIQUE(initiated_by, idempotency_key)` on the transactions table; the key row and the postings commit atomically, so there is no "key stored but money not moved" state. The lookup runs *after* the account locks, so a concurrent duplicate waits and then sees the committed original. `ON CONFLICT DO NOTHING` is the last guard and triggers a re-read. A failure halfway rolls back key and money together, so a retry is a clean first attempt. If the COMMIT is acknowledged but the response is lost, the retry replays the stored result. | T3 ×5 (incl. 20 simultaneous same-key requests) |
| T3b | Same key, different payload to smuggle a different payment. | Request hash stored; mismatch → 422, nothing moves, audit-logged. | T3 |
| T3c | A **refused** request retried after funds arrive pays later. | Refusals are recorded under the key too; replay returns the refusal. | T3 |
| T3d | Cross-user key collision / key guessing. | Keys are scoped per user. | T3 |
| T4 | **Moving someone else's money** (IDOR). | Owner check on the server for every movement; role re-read from the DB each request (not from the token). Admin may fund but not withdraw/transfer out. Auditor can never write. Non-owners get 404 on balance/statement so ids cannot be probed. The external account cannot be named by a client. Forbidden attempts go to the audit log. | T4 ×4 |
| T5 | Floats, negatives, huge or NaN amounts, self-transfer. | Integer paise only, range-checked; per-movement cap keeps every value far below 2^53. | T5 |
| T6 | **Money created or lost** (credit without debit, half-failed transfer). | Double-entry: every movement is two legs. A deferred constraint trigger rejects at COMMIT any transaction whose entries do not sum to zero. Balances change only via an entry insert (trigger depth check blocks direct `UPDATE accounts`). | T6, T8, T9 |
| T7 | Negative balance if the app check is ever wrong. | DB `CHECK` constraint. | T7 |
| T8 | **Quietly editing or deleting a ledger row.** | Row triggers reject UPDATE/DELETE and statement triggers reject TRUNCATE on `transactions`, `entries`, `idempotency_replays`, `audit_log`; accounts cannot be deleted. | T9 |
| T8b | Tampering by someone who *can* disable triggers. | Per-account hash chain: each entry's hash covers the previous hash, txn, amount and running balance; the account stores the head. `/api/reconcile` recomputes every chain, every balance from its entries, and the global sum. Tampering is **detected**. | T9b |
| T9 | Injection / XSS. | Parameterised SQL throughout; UI escapes all user text (memo, names). | review |
| T10 | Error leakage. | Unknown errors return a generic 500 with a request id; details go to the server log only. | review |

## Knowingly accepted

1. **A DB superuser/owner can defeat tamper evidence.** Someone who can disable triggers *and* recompute every hash and the head can rewrite history undetected. Mitigation I would add: run the app as a role with INSERT/SELECT only, and publish chain heads to an external store. Not built.
2. **The external account is a hotspot.** Every deposit and withdrawal locks the one external row, so they serialise globally (transfers between holders do not). Throughput is bounded by commit latency. Fine for this scale; the fix is sharding the counterparty per currency/bank account.
3. **No rate limiting or lockout on login.** bcrypt (cost 10) slows guessing but does not stop it. Tokens last 8h and cannot be revoked early (a deleted user fails immediately because the row is re-read, but there is no logout-everywhere).
4. **Admin can create money from outside** by depositing into any account, with no maker-checker. It is audit-logged and visible in reconciliation as external inflow, but a single rogue admin is not prevented.
5. **Idempotency keys are kept forever** (they are the transaction rows). Safe, but storage grows; a TTL would need to be a deliberate decision about the replay window.
6. **Account-id oracle on transfers:** a holder can learn whether a destination id exists (404 vs proceeding). Needed for a usable transfer form; no names are revealed.
7. **Refusals for forbidden attempts are in the audit log, not on the victim's statement**, so nobody can spam another holder's statement. A holder's own statement shows their insufficient-funds refusals.
8. **Public demo credentials** are in the README because the brief requires it; rotate `DEMO_PASSWORD` after judging.
9. **Not tested by automation:** multi-instance deployment (locks are in Postgres so it should hold), and DB crash recovery (relies on Postgres durability).

## Not built (deliberately)

Overdraft, holds/authorisations, reversals and refunds, multiple currencies, scheduled/batch transfers, AI anomaly flagging. Each adds states that must also be atomic and idempotent; I chose a smaller system that is provably correct.

# LedgerLine

Money movement with a ledger you can prove. Node 22 + Express + PostgreSQL. Double-entry, append-only, idempotent, concurrency-safe.

**Live:** `<PASTE LIVE URL>` · **Repo:** `<PASTE REPO URL>` · **Demo video:** `<PASTE LINK>`

## Demo accounts (one per role)

| Role | Email | Password |
|---|---|---|
| Administrator | admin@ledgerline.test | `LedgerLine#2026` |
| Account holder 1 | holder1@ledgerline.test | `LedgerLine#2026` |
| Account holder 2 | holder2@ledgerline.test | `LedgerLine#2026` |
| Auditor (read-only) | auditor@ledgerline.test | `LedgerLine#2026` |

Suggested first run: sign in as admin, deposit ₹1,000 into account 2 (holder 1), then sign in as holder 1 and transfer to account 3.

## Roles

| | Admin | Holder | Auditor |
|---|---|---|---|
| Create users / accounts | yes | no | no |
| Deposit | into any account | into own accounts | no |
| Withdraw | own accounts only | own accounts | no |
| Transfer | out of own accounts only | out of own accounts | no |
| View balance / statement | all | own only (others return 404) | all |
| Audit log, reconciliation, duplicate-request log | yes | no | yes |

An admin can fund accounts but **cannot** withdraw or transfer a holder's money.

## Run locally from a clean clone

```bash
# needs Node >= 20 and PostgreSQL >= 13
createdb ledgerline && createdb ledgerline_test
npm ci
export DATABASE_URL=postgres://localhost/ledgerline JWT_SECRET=change-me
npm start                      # applies db/schema.sql once, seeds demo users, serves UI+API on :3000

TEST_DATABASE_URL=postgres://localhost/ledgerline_test npm test   # DROPS and recreates the schema of that DB
```

Env: `DATABASE_URL` (required) · `JWT_SECRET` (required in production) · `PGSSL=true` for managed Postgres · `SEED_DEMO=false` to skip demo users · `DEMO_PASSWORD` · `MAX_AMOUNT_PAISE` (default 1,000,000,000 = ₹1 crore per movement) · `PG_POOL_MAX`.

## Deploy (Render, free tier)

Push to GitHub → Render → **New → Blueprint** → select the repo. `render.yaml` provisions the web service and Postgres; the start command runs the migration and seed automatically. Set `DEMO_PASSWORD` if you want something other than the default, and keep the same value in this README.

## Where to look

- `db/schema.sql`: every invariant (floor, zero-sum, append-only, hash chain) lives in the database.
- `src/ledger.js`: lock → idempotency check → decide → post. Read `attempt()` first.
- `docs/API.md`: endpoints, who may call them, effect on money.
- `THREATS.md` · `PROMPTS.md` · `WRITEUP.md`
- `test/ledger.test.js`: races, replays, authorisation, tamper detection.

# API

JSON over HTTPS. `Authorization: Bearer <token>` on everything except login and `/health`. Amounts are **integer paise** (`amount_paise`), 1 ≤ n ≤ `MAX_AMOUNT_PAISE`. Money-moving calls **require** an `Idempotency-Key` header (8–128 chars of `A-Za-z0-9._:-`), scoped per user.

Money-moving responses: `201` posted · `422` refused and recorded (`INSUFFICIENT_FUNDS`) · `403` not permitted (audit-logged, nothing recorded on any statement) · `400` invalid · `404` unknown account · `422 IDEMPOTENCY_KEY_REUSE` same key, different request. A replay returns the **original** status and body plus header `Idempotent-Replay: true`.

| Endpoint | Who | Effect on money |
|---|---|---|
| `POST /api/auth/login` `{email,password}` | anyone | none |
| `GET /api/me` | any signed-in | none |
| `POST /api/users` `{email,password,role}` | admin | none |
| `GET /api/users` | admin, auditor | none |
| `POST /api/accounts` `{name,owner_id}` | admin | creates a zero-balance account |
| `GET /api/accounts` | any (holder: own only) | none |
| `GET /api/accounts/:id` | owner, admin, auditor | none |
| `GET /api/accounts/:id/statement` | owner, admin, auditor | none. Every posting and refusal with running balance. Counterparty identity masked for holders |
| `POST /api/accounts/:id/deposits` `{amount_paise,memo?}` | owner of the account, or admin | external → account (total money +amount) |
| `POST /api/accounts/:id/withdrawals` `{amount_paise,memo?}` | owner only | account → external (total money −amount); refused if balance < amount |
| `POST /api/transfers` `{from_account_id,to_account_id,amount_paise,memo?}` | owner of source only | account → account; total unchanged; refused if source balance < amount |
| `GET /api/audit-log?limit=` | admin, auditor | none |
| `GET /api/replays` | admin, auditor | none. Lists requests that were duplicates |
| `GET /api/reconcile` | admin, auditor | none. Recomputes invariants from the data |
| `GET /health` | anyone | none |

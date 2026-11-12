# Write-up

## What I built
LedgerLine: accounts, deposits, withdrawals and transfers with three roles (admin, holder, auditor), a per-account statement including refused attempts, an append-only audit log, a duplicate-request log, and a reconciliation endpoint that proves the invariants from the data. Node/Express + PostgreSQL, plain-JS single-page UI.

## Integrity and concurrency model (in short)
- **Ledger:** double-entry. A movement is two signed entries that must sum to zero (checked at COMMIT by a deferred constraint trigger). External deposits/withdrawals use one external counterparty account, so total money across all accounts is always zero and customer money equals net external flow.
- **Atomicity/isolation:** one DB transaction per request, READ COMMITTED, explicit `FOR UPDATE` row locks on the accounts involved, taken in id order. The balance is read under the lock and the debit is written under the same lock.
- **Exactly once:** `UNIQUE(user, key)` on the transactions table; key and money commit together. Refusals are stored under the key too.
- **Proof:** append-only triggers, per-account hash chains, and `/api/reconcile`.
- **Defence in depth:** the DB `CHECK` floor and zero-sum trigger hold even if the app code were wrong.

## What I did not build
See THREATS.md → "Not built" and "Knowingly accepted".

## How I used AI and where it was wrong
`<Fill in from PROMPTS.md. Be specific.>`

## Unfinished
`<List honestly.>`

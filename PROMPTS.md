# PROMPTS

**Tool used:** Claude (chat, with a sandbox that can run code against a real PostgreSQL 16).
**How I worked:** I gave Claude the LedgerLine brief and directed it to build the system, then ran, attacked and reviewed what it produced. I also deliberately broke the money logic to see whether the tests noticed. Entries are in the order they happened. Commit links point to the commit that contains the corrected file; several defects were fixed before the first commit.

**Honest summary of where the AI was wrong.** The core integrity logic (row locking, idempotency, authorisation) had no defect that I could find. The mistakes I caught were in the AI-written **tests** of that logic (entries 3 and 4) and in tooling and deployment commands (entries 1, 2 and 6). Entries 3 and 4 matter most: each would have let a broken guard look verified. Entry 5 shows how I checked the integrity code itself.

---

## 1. Scaffolding the system from the brief
**Date:** 2026-11-12
**Asked:** "build the model", with the full LedgerLine brief pasted in. Claude chose Node/Express + PostgreSQL, a double-entry ledger, `SELECT … FOR UPDATE` row locks, a `UNIQUE(user, idempotency_key)` constraint for exactly-once, and append-only triggers.
**Produced:** `db/schema.sql`, `src/ledger.js`, `src/app.js`, a small UI, tests and docs.
**What was wrong:** The command that created the folders used shell brace expansion (`mkdir -p x/{src,db,public,...}`) under `/bin/sh`, which does not expand braces. It created one directory literally named `{src,db,public,test,scripts,docs}`, and the next step failed with `Directory nonexistent` when writing `db/schema.sql`. I spotted it from the error and from listing the tree.
**What I did instead:** Created each directory with an explicit loop, deleted the stray directory, and applied the schema with `psql -v ON_ERROR_STOP=1` until it reported success.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<c8cd1b7>

## 2. Test runner command and a corrupted package.json
**Date:** 2026-11-12
**Asked:** Make `npm test` run the suite with `node --test`.
**Produced:** `"test": "node --test --test-concurrency=1 test/"`.
**What was wrong:** On Node 22 a directory argument is treated as a module to load, so no test ran. My first fix used `sed` to inject quotes into the JSON and produced an invalid `package.json` (`npm error JSON.parse Invalid package.json`). Separately, PostgreSQL had stopped between steps, so one full run showed connection-refused failures that looked like test failures but were not. I only trusted the next run after confirming the database answered `select 1`.
**What I did instead:** Used a glob (`test/*.test.js`), rewrote the line with a small Node script that re-parses the JSON before saving, and restarted Postgres before re-running.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<c8cd1b7>

## 3. A "key required" test that did not test the key rule (idempotency)
**Date:** 2026-11-12
**Asked:** Tests that reject invalid input, including a missing `Idempotency-Key`, before any money moves.
**Produced:** A helper `tr(amount, key = k(), to = b)` and the case `tr(100, undefined)`, meant to send no key.
**What was wrong:** In JavaScript, passing `undefined` triggers the default parameter, so a fresh key was generated and the request succeeded with `201` instead of `400`. The server was correct; the test was silently not exercising the "key is required" rule. The run showed `expected: 400, actual: 201`, and I traced it to the default parameter instead of changing the server.
**What I did instead:** Changed the case to pass `null` (the helper sends no header for a falsy key). All 20 tests pass, and the server returns `400 IDEMPOTENCY_KEY_REQUIRED` when no key is sent.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<1059059>

## 4. An append-only test that depended on another test's data (integrity)
**Date:** 2026-11-12
**Asked:** A test proving ledger rows cannot be updated, deleted or truncated.
**Produced:** `T9`, which runs `UPDATE idempotency_replays SET …` and expects the trigger to reject it.
**What was wrong:** It only passed because earlier replay tests (`T3`) had already created rows in that table. An `UPDATE` that matches zero rows fires no row trigger and raises nothing, so run alone the test failed with `Missing expected rejection`. I found it because a mutation run (entry 5) made `T9` fail even though I had only touched the idempotency lookup. That was suspicious, so I ran `T9` in isolation on unmodified code and reproduced the failure.
**What I did instead:** `T9` now creates its own duplicate request first, so the table is guaranteed to have a row to try to change. It passes alone and in the full suite.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<1059059>

## 5. Proving the tests catch broken guards (integrity and concurrency: how I checked it)
**Date:** 2026-11-12
**Asked:** Not a request to the AI; this is my check of AI-written money logic. I removed one guard at a time from `src/ledger.js` and re-ran `npm test`, because a test that still passes without the guard is not testing it.
**Code checked:** `attempt()`: the `FOR UPDATE` lock, the idempotency lookup, the owner check, the funds check.
**Results:**
- Remove `FOR UPDATE`: four tests failed (both overdraw races, the opposing-transfer test, the mixed storm). The database `CHECK` constraint still prevented any overdraw, but the losing requests returned `500` instead of a clean `422`. My tests assert exact success and refusal counts (30 parallel withdrawals of ₹1 against ₹10 must give exactly 10 `201` and 20 `422`), so a missing lock cannot hide behind the database backstop.
- Disable the idempotency lookup: the replay tests failed (plus `T9`, see entry 4).
- Remove the owner check: both authorisation tests failed.
- Remove the funds check: the overdraw races, the refused-replay test and the statement test failed.
- Restore the code: 20 of 20 pass.
**What I did instead:** Kept the exact-count assertions; a test that only checked the final balance would have passed with the lock removed.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<1059059>

## 6. Deployment config reviewed before deploying
**Date:** 2026-11-12
**Asked:** A `render.yaml` Blueprint so the service and database deploy from the repo.
**Produced:** A web service and Postgres definition with the start command running the migration and seed.
**What was wrong:** The web service had no `plan` line. Render defaults a Blueprint service to a paid plan when none is given, so deploying as written could have created a billed instance. Claude's own follow-up review flagged it before I applied the Blueprint.
**What I did instead:** Added `plan: free` to the web service, pushed, then deployed. The service shows the Free plan and is live. I also noted in the README that the free instance sleeps when idle and the first request can take about 50 seconds.
**Commit:** https://github.com/Sravani126-max/ledgerline/commit/<8b85358>

## How I used AI and where it was wrong

I used Claude (chat with a sandbox capable of running code against PostgreSQL 16) to develop LedgerLine. I provided the complete project brief and asked it to build the system, including the database schema, backend APIs, frontend UI, tests and documentation.

I did not blindly accept the generated code. I ran the application, reviewed the implementation, investigated errors and deliberately removed important integrity guards to check whether the automated tests detected the resulting problems.

The main mistakes I identified were in AI-generated tests, tooling commands and deployment configuration rather than the core money-handling logic.

**1. Incorrect directory creation command**

The AI suggested shell brace expansion using `mkdir -p`, which did not work under `/bin/sh`. It created an incorrectly named directory instead of the required project folders. I identified the problem, created the directories explicitly and successfully applied the database schema.

**2. Incorrect test runner command**

The generated test command used `node --test --test-concurrency=1 test/`, which did not correctly discover the tests in Node 22. An initial `sed` fix also corrupted `package.json`. I corrected the command to use `test/*.test.js`, validated the JSON and restarted PostgreSQL before trusting the test results.

**3. Incorrect idempotency test**

The AI-generated missing-key test passed `undefined` to a JavaScript helper with a default parameter. This generated a new key instead of testing a missing key. I changed the test to pass `null` and verified that the server returns `400 IDEMPOTENCY_KEY_REQUIRED`.

**4. Append-only test depended on previous test data**

An append-only test attempted to update a replay record without creating one itself. It passed in the full test suite only because an earlier test had populated the table. I reproduced the problem by running the test independently and fixed it by creating its own duplicate request first.

**5. Deliberately testing integrity guards**

I independently removed the row-locking, idempotency, ownership and insufficient-funds checks from the ledger implementation one at a time. The relevant tests failed as expected. In particular, removing `FOR UPDATE` caused concurrency tests to fail because requests returned server errors instead of clean refusals.

I restored the implementation and confirmed that all 20 tests passed.

**6. Deployment configuration**

The generated Render configuration did not explicitly specify a service plan. A follow-up review identified the risk of accidentally creating a paid service. I added `plan: free` before deploying and documented the free instance's inactivity and startup delay in the README.

Overall, AI helped accelerate development, but I treated its output as something that needed independent verification. The testing mistakes demonstrated why tests must be checked for whether they actually exercise the intended security and integrity rules.

## Unfinished

The following limitations are knowingly accepted or deliberately not implemented.

**Knowingly accepted limitations:**

1. A database superuser who can disable triggers and recompute all hashes can defeat the tamper-evidence mechanism. An application role with restricted permissions and externally published hash-chain heads would improve protection.
2. The shared external counterparty account can become a throughput bottleneck because deposits and withdrawals serialize on its row.
3. Login has no rate limiting or account lockout. bcrypt slows password guessing but does not prevent it.
4. Admin users can deposit money into accounts without a maker-checker approval process.
5. Idempotency records are retained indefinitely, so database storage will grow over time.
6. Transfer destination account IDs can reveal whether an account exists through different responses.
7. Forbidden attempts are recorded in the audit log rather than the victim's statement.
8. Public demo credentials are included in the README as required for evaluation and should be rotated after judging.
9. Multi-instance deployment and database crash recovery have not been verified through automated tests.

**Features deliberately not built:**

- Overdraft facilities.
- Holds and authorisations.
- Reversals and refunds.
- Multiple currencies.
- Scheduled or batch transfers.
- AI-based anomaly detection.

These features were intentionally excluded to keep the implementation focused on a smaller financial system with strong transaction integrity, concurrency safety and auditable behaviour.

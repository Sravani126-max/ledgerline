# PROMPTS

> Write one entry **at the time it happens**, with a real commit link. The brief requires ≥5 dated entries, ≥2 about money-integrity / concurrency / idempotency, each showing what the AI got wrong. Entries below are templates only: delete them and replace them with your own. Do not copy an entry you did not live.

## Entry template

**Date:** 2026-11-DD
**Asked:** what you told the tool to do (paste the prompt).
**Produced:** what it gave you (summarise or quote the relevant lines).
**What was wrong:** the specific defect, and how you found it (test, log, reading the code).
**What I did instead:** the change, in your own words.
**Commit:** https://github.com/<you>/<repo>/commit/<sha>

## Things worth genuinely checking in this codebase (then write them up if you find/fix anything)

- `src/ledger.js attempt()`: where is the balance read, and is that row lock still held when the debit is written? Remove `FOR UPDATE` and run `npm test`: which tests fail, and why does the DB `CHECK` not make them pass?
- Why is the idempotency lookup *after* the lock rather than before it? What breaks if it moves?
- Why must a refused request also be stored under its key?
- Why `ORDER BY id` in the lock query?

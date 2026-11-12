-- LedgerLine schema. Double-entry, append-only ledger. All amounts are integer paise (INR).
-- The database, not the application, is the last line of defence for every invariant below.

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','holder','auditor')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  owner_id      bigint REFERENCES users(id),
  is_external   boolean NOT NULL DEFAULT false,   -- the single counterparty for deposits/withdrawals
  balance_paise bigint NOT NULL DEFAULT 0,
  head_hash     text NOT NULL DEFAULT 'GENESIS',  -- tip of this account's hash chain
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- THE FLOOR: no overdraft. Only the external counterparty may be negative.
  CONSTRAINT balance_floor CHECK (is_external OR balance_paise >= 0),
  CONSTRAINT owner_required CHECK (is_external OR owner_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_external_account ON accounts ((is_external)) WHERE is_external;

CREATE TABLE transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigserial UNIQUE,
  kind             text   NOT NULL CHECK (kind IN ('DEPOSIT','WITHDRAWAL','TRANSFER')),
  status           text   NOT NULL CHECK (status IN ('POSTED','REFUSED')),
  reason           text,
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  from_account_id  bigint NOT NULL REFERENCES accounts(id),
  to_account_id    bigint NOT NULL REFERENCES accounts(id),
  initiated_by     bigint NOT NULL REFERENCES users(id),
  idempotency_key  text   NOT NULL,
  request_hash     text   NOT NULL,
  source_balance_seen_paise bigint,               -- source balance observed under lock (for refusals)
  memo             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id),
  CHECK ((status = 'REFUSED') = (reason IS NOT NULL)),
  -- EXACTLY-ONCE: one row per (user, key), enforced by the index. Concurrent duplicates block on it.
  UNIQUE (initiated_by, idempotency_key)
);

CREATE TABLE entries (
  id                  bigserial PRIMARY KEY,
  txn_id              uuid   NOT NULL REFERENCES transactions(id),
  account_id          bigint NOT NULL REFERENCES accounts(id),
  amount_paise        bigint NOT NULL CHECK (amount_paise <> 0),  -- signed: debit < 0, credit > 0
  balance_after_paise bigint NOT NULL,
  prev_hash           text   NOT NULL,
  row_hash            text   NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (txn_id, account_id)
);
CREATE INDEX entries_account_idx ON entries (account_id, id);

CREATE TABLE idempotency_replays (       -- proof of which requests were duplicates
  id          bigserial PRIMARY KEY,
  txn_id      uuid   NOT NULL REFERENCES transactions(id),
  replayed_by bigint NOT NULL REFERENCES users(id),
  payload_matched boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor_id bigint,
  action   text  NOT NULL,
  detail   jsonb NOT NULL DEFAULT '{}'
);

-- ---------- APPEND-ONLY: updates, deletes and truncates are rejected ----------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: the ledger is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER replays_append_only BEFORE UPDATE OR DELETE ON idempotency_replays FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER replays_no_truncate BEFORE TRUNCATE ON idempotency_replays FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Balances may change ONLY as a side effect of inserting an entry (trigger depth >= 2).
CREATE FUNCTION accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.balance_paise <> OLD.balance_paise OR NEW.head_hash <> OLD.head_hash) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'balance may only change by posting a ledger entry' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- Posting an entry atomically updates the balance and extends the account's hash chain.
CREATE FUNCTION entries_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint; head text;
BEGIN
  SELECT balance_paise, head_hash INTO bal, head FROM accounts WHERE id = NEW.account_id FOR UPDATE;
  NEW.balance_after_paise := bal + NEW.amount_paise;
  NEW.prev_hash := head;
  NEW.row_hash := encode(sha256(convert_to(
      head||'|'||NEW.txn_id::text||'|'||NEW.account_id::text||'|'||NEW.amount_paise::text||'|'||NEW.balance_after_paise::text,'UTF8')),'hex');
  UPDATE accounts SET balance_paise = NEW.balance_after_paise, head_hash = NEW.row_hash WHERE id = NEW.account_id;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_apply BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION entries_apply();

-- CONSERVATION: at COMMIT every transaction's entries must sum to exactly zero.
CREATE FUNCTION check_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount_paise),0) FROM entries WHERE txn_id = NEW.txn_id) <> 0 THEN
    RAISE EXCEPTION 'transaction % does not balance', NEW.txn_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

-- TAMPER EVIDENCE: recompute an account's chain from its entries and compare with stored values.
CREATE FUNCTION account_chain_ok(acct bigint) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev text := 'GENESIS'; bal bigint := 0; h text; a accounts%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM entries WHERE account_id = acct ORDER BY id LOOP
    bal := bal + r.amount_paise;
    h := encode(sha256(convert_to(
        prev||'|'||r.txn_id::text||'|'||r.account_id::text||'|'||r.amount_paise::text||'|'||bal::text,'UTF8')),'hex');
    IF r.prev_hash <> prev OR r.row_hash <> h OR r.balance_after_paise <> bal THEN RETURN false; END IF;
    prev := h;
  END LOOP;
  SELECT * INTO a FROM accounts WHERE id = acct;
  RETURN a.head_hash = prev AND a.balance_paise = bal;
END $$;

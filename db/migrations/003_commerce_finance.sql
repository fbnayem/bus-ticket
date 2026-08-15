-- 003_commerce_finance.sql — booking, payment, ticket, and the double-entry ledger
-- Phase 1 workstream P1-H. The finance UI is Phase 2, but the ledger records
-- entries from day one so Phase 2 opens the books on real data, not a backfill.

SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS commerce;
CREATE SCHEMA IF NOT EXISTS finance;

-- ---------------------------------------------------------------- bookings --
CREATE TABLE commerce.bookings (
    booking_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pnr            text UNIQUE NOT NULL,
    trip_id        uuid NOT NULL,              -- plain column: no FK across service DBs
    operator_id    uuid NOT NULL,
    hold_id        uuid NOT NULL,
    user_id        uuid,
    channel        text NOT NULL DEFAULT 'WEB',
    status         text NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','PAYMENT_PENDING','CONFIRMED','TICKETED','COMPLETED',
                                     'FAILED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED',
                                     'PARTIALLY_REFUNDED','FAILED_REFUNDED')),
    board_stop_seq int  NOT NULL,
    drop_stop_seq  int  NOT NULL,
    -- copied from the hold; never recomputed
    price_snapshot jsonb  NOT NULL DEFAULT '{}'::jsonb,
    total_poisha   bigint NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bookings_trip_idx ON commerce.bookings (trip_id);
CREATE INDEX bookings_user_idx ON commerce.bookings (user_id);

CREATE TABLE commerce.booking_seats (
    booking_id uuid NOT NULL REFERENCES commerce.bookings(booking_id) ON DELETE CASCADE,
    seat_no    text NOT NULL,
    PRIMARY KEY (booking_id, seat_no)
);

CREATE TABLE commerce.booking_status_history (
    id          bigserial PRIMARY KEY,
    booking_id  uuid NOT NULL REFERENCES commerce.bookings(booking_id) ON DELETE CASCADE,
    from_status text,
    to_status   text NOT NULL,
    reason      text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- payments --
CREATE TABLE commerce.payments (
    payment_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id     uuid NOT NULL REFERENCES commerce.bookings(booking_id),
    provider       text NOT NULL CHECK (provider IN ('BKASH','NAGAD','CARD','BANK','CASH','AGENT_WALLET')),
    provider_txn_id text,
    amount_poisha  bigint NOT NULL CHECK (amount_poisha > 0),
    currency       text   NOT NULL DEFAULT 'BDT',
    status         text   NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','PENDING','PAID','FAILED','REFUNDED')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- THIS CONSTRAINT IS THE IDEMPOTENCY DEFENCE. It exists in migration #1
    -- because adding it later would require deduplicating live history.
    -- 100 duplicate webhooks collapse to exactly one payment row here.
    UNIQUE (provider, provider_txn_id)
);

-- Every public mutation stores its key + response so retries replay, never re-execute.
CREATE TABLE commerce.idempotency_keys (
    idem_key     text PRIMARY KEY,
    endpoint     text NOT NULL,
    request_hash text NOT NULL,
    response     jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commerce.payment_webhooks (
    webhook_id      bigserial PRIMARY KEY,
    provider        text NOT NULL,
    provider_txn_id text,
    signature_ok    boolean NOT NULL,
    accepted        boolean NOT NULL,
    reject_reason   text,
    raw             jsonb   NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- tickets --
CREATE TABLE commerce.tickets (
    ticket_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  uuid NOT NULL REFERENCES commerce.bookings(booking_id),
    pnr         text NOT NULL,
    seat_no     text NOT NULL,
    -- signed opaque token, key-id prefixed for rotation. No PII inside, ever.
    qr_token    text NOT NULL UNIQUE,
    qr_key_id   text NOT NULL DEFAULT 'k1',
    status      text NOT NULL DEFAULT 'VALID'
                CHECK (status IN ('VALID','BOARDED','CANCELLED','USED','EXPIRED')),
    issued_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (booking_id, seat_no)
);

-- ------------------------------------------------------------------ ledger --
CREATE TABLE finance.ledger_accounts (
    account_code text PRIMARY KEY,
    name         text NOT NULL,
    normal_side  text NOT NULL CHECK (normal_side IN ('DR','CR'))
);

CREATE TABLE finance.journal_entries (
    journal_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id uuid,
    description    text NOT NULL,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only. Corrections are reversing entries; history is never edited.
CREATE TABLE finance.ledger_entries (
    entry_id      bigserial PRIMARY KEY,
    journal_id    uuid   NOT NULL REFERENCES finance.journal_entries(journal_id),
    account_code  text   NOT NULL REFERENCES finance.ledger_accounts(account_code),
    side          text   NOT NULL CHECK (side IN ('DR','CR')),
    amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
    party_ref     text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_journal_idx ON finance.ledger_entries (journal_id);

-- Every journal must balance. Enforced in the database, not in a code review.
CREATE OR REPLACE FUNCTION finance.assert_journal_balanced(p_journal uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE dr bigint; cr bigint;
BEGIN
    SELECT COALESCE(SUM(amount_poisha) FILTER (WHERE side='DR'),0),
           COALESCE(SUM(amount_poisha) FILTER (WHERE side='CR'),0)
      INTO dr, cr
      FROM finance.ledger_entries WHERE journal_id = p_journal;
    IF dr <> cr THEN
        RAISE EXCEPTION 'journal % unbalanced: DR=% CR=%', p_journal, dr, cr;
    END IF;
END $$;

-- Trial balance across the whole ledger; the proof suite asserts this is zero.
CREATE OR REPLACE VIEW finance.trial_balance AS
SELECT COALESCE(SUM(amount_poisha) FILTER (WHERE side='DR'),0)
     - COALESCE(SUM(amount_poisha) FILTER (WHERE side='CR'),0) AS variance_poisha
  FROM finance.ledger_entries;

INSERT INTO finance.ledger_accounts (account_code, name, normal_side) VALUES
    ('1001','Cash','DR'),
    ('1101','Gateway Clearing','DR'),
    ('1201','Customer Receivable','DR'),
    ('2101','Operator Payable','CR'),
    ('2102','Agent Payable','CR'),
    ('2201','Refund Payable','CR'),
    ('2301','Tax Payable','CR'),
    ('4101','Platform Revenue','CR'),
    ('5101','Commission Expense','DR'),
    ('5102','Gateway Fee Expense','DR'),
    ('5201','Promotional Expense','DR');

-- --------------------------------------------------------------- audit log --
-- Append-only at the GRANT level, not by convention. The app role below can
-- INSERT and SELECT; it holds no UPDATE or DELETE privilege on this table.
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.audit_log (
    audit_id    bigserial PRIMARY KEY,
    actor_id    uuid,
    actor_role  text,
    action      text NOT NULL,
    resource    text NOT NULL,
    before_val  jsonb,
    after_val   jsonb,
    ip          inet,
    request_id  uuid,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA audit TO app_rw;
GRANT INSERT, SELECT ON audit.audit_log TO app_rw;
REVOKE UPDATE, DELETE ON audit.audit_log FROM app_rw;
GRANT USAGE, SELECT ON SEQUENCE audit.audit_log_audit_id_seq TO app_rw;

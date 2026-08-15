-- 011_platform.sql — the rest of the platform:
--   analytics read model (P2-L)          promotions and referrals (P2-H)
--   operations control centre (P2-J)     three-way reconciliation (P2-F)
--   partner API and webhooks (P3-B)      risk and fraud (P3-A)
--
-- Two things recur through this file and are worth stating once.
--
-- Analytics never reads the transactional tables. The plan is explicit that
-- reporting must not load the booking database; here that is enforced by
-- analytics.facts being fed from the event log and by every report reading only
-- from the analytics schema.
--
-- Anything that can over-issue — a limited coupon, a referral reward, a partner
-- quota — is guarded by a conditional UPDATE whose rowcount is the verdict,
-- exactly as seats are. A SELECT-then-INSERT would race, and a coupon capped at
-- 100 that redeems 137 times under load is the same class of bug as a
-- double-booked seat.

SET client_min_messages = warning;

-- =========================================================================== --
--                          ANALYTICS (P2-L)                                   --
-- =========================================================================== --
CREATE SCHEMA IF NOT EXISTS analytics;

-- The ClickHouse stand-in: one denormalised row per business event, written by
-- the analytics-ingest consumer, never by a request handler.
CREATE TABLE analytics.facts (
    fact_id      bigserial PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE,
    event_type   text NOT NULL,
    occurred_at  timestamptz NOT NULL,
    day          date NOT NULL,
    hour         int  NOT NULL,
    operator_id  uuid,
    trip_id      uuid,
    route_name   text,
    channel      text,
    pnr          text,
    seats        int    NOT NULL DEFAULT 0,
    amount_poisha bigint NOT NULL DEFAULT 0,
    payload      jsonb  NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX facts_day_idx      ON analytics.facts (day, event_type);
CREATE INDEX facts_operator_idx ON analytics.facts (operator_id, day);

-- What the real-time dashboard reads. Recomputed on a short ticker so a
-- dashboard refresh is one indexed read rather than nine aggregate scans.
CREATE TABLE analytics.live_metrics (
    metric      text PRIMARY KEY,
    value       numeric NOT NULL,
    unit        text NOT NULL DEFAULT '',
    computed_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================== --
--                    PROMOTIONS AND REFERRALS (P2-H)                          --
-- =========================================================================== --
CREATE SCHEMA IF NOT EXISTS promo;

CREATE TABLE promo.campaigns (
    campaign_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text UNIQUE,
    title         text NOT NULL,
    kind          text NOT NULL CHECK (kind IN
                  ('COUPON','AUTOMATIC','NEW_USER','ROUTE','OPERATOR','PAYMENT','REFERRAL','AGENT','LIMITED')),
    discount_pct  int    NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
    discount_poisha bigint NOT NULL DEFAULT 0,
    max_discount_poisha bigint NOT NULL DEFAULT 0,
    min_amount_poisha   bigint NOT NULL DEFAULT 0,
    operator_id   uuid REFERENCES catalog.operators(operator_id),
    route_id      uuid REFERENCES catalog.routes(route_id),
    channel       text,
    payment_provider text,
    -- NULL means unlimited. When it is set, redeemed can never exceed it,
    -- because the redemption is a conditional UPDATE and not a check.
    max_redemptions int,
    redeemed        int NOT NULL DEFAULT 0,
    per_user_limit  int NOT NULL DEFAULT 1,
    starts_at     timestamptz NOT NULL DEFAULT now(),
    ends_at       timestamptz,
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT redemption_cap_respected CHECK (max_redemptions IS NULL OR redeemed <= max_redemptions)
);

CREATE TABLE promo.redemptions (
    redemption_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   uuid NOT NULL REFERENCES promo.campaigns(campaign_id),
    booking_id    uuid,
    user_key      text NOT NULL,
    discount_poisha bigint NOT NULL,
    redeemed_at   timestamptz NOT NULL DEFAULT now(),
    -- One redemption per booking per campaign, enforced rather than assumed.
    UNIQUE (campaign_id, booking_id)
);

CREATE INDEX redemptions_user_idx ON promo.redemptions (campaign_id, user_key);

-- Per-user usage as a counter rather than a COUNT(*). A limit enforced by
-- counting rows and then inserting one races exactly the way a seat check
-- would; a conditional UPDATE on this row does not.
CREATE TABLE promo.user_usage (
    campaign_id uuid NOT NULL REFERENCES promo.campaigns(campaign_id) ON DELETE CASCADE,
    user_key    text NOT NULL,
    used        int  NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, user_key)
);

CREATE TABLE promo.referrals (
    referral_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text UNIQUE NOT NULL,
    referrer_key text NOT NULL,
    invitee_key  text,
    status       text NOT NULL DEFAULT 'INVITED'
                 CHECK (status IN ('INVITED','REGISTERED','QUALIFIED','REWARDED','VOID')),
    qualifying_booking_id uuid,
    reward_kind  text NOT NULL DEFAULT 'COUPON' CHECK (reward_kind IN ('COUPON','WALLET_CREDIT','POINTS')),
    reward_poisha bigint NOT NULL DEFAULT 20000,
    reward_code  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    qualified_at timestamptz,
    rewarded_at  timestamptz
);

CREATE INDEX referrals_referrer_idx ON promo.referrals (referrer_key);

-- =========================================================================== --
--                  OPERATIONS CONTROL CENTRE (P2-J)                           --
-- =========================================================================== --
-- The seven alert types are a CHECK constraint, not a comment, so a new alert
-- kind is a migration and a conversation rather than a string typed in a
-- handler somewhere.
CREATE TABLE ops.alerts (
    alert_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid NOT NULL,
    operator_id uuid NOT NULL,
    kind        text NOT NULL CHECK (kind IN (
                  'LATE_DEPARTURE','LONG_STOP','ROUTE_DEVIATION','GPS_OFFLINE',
                  'UNEXPECTED_STOP','TRIP_CANCELLATION','BUS_BREAKDOWN')),
    severity    text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
    detail      text NOT NULL,
    raised_at   timestamptz NOT NULL DEFAULT now(),
    cleared_at  timestamptz,
    acknowledged_by uuid REFERENCES staff.staff_users(staff_id),
    acknowledged_at timestamptz
);

-- One OPEN alert of a kind per trip. The detector re-runs every thirty seconds
-- and would otherwise produce a wall of identical rows; this makes the second
-- detection an update. A plain UNIQUE would not do it, because NULLs do not
-- collide and cleared_at is NULL exactly while the alert is open.
CREATE UNIQUE INDEX alerts_one_open_per_kind ON ops.alerts (trip_id, kind)
    WHERE cleared_at IS NULL;

CREATE INDEX alerts_open_idx ON ops.alerts (raised_at DESC) WHERE cleared_at IS NULL;

-- A bus swap, with the seat remap it forces. The conflicts are the point: a
-- replacement with fewer or differently-numbered seats must produce a list for
-- the crew to resolve, never a silent double assignment.
CREATE TABLE ops.replacements (
    replacement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id        uuid NOT NULL,
    from_bus_id    uuid NOT NULL REFERENCES catalog.buses(bus_id),
    to_bus_id      uuid NOT NULL REFERENCES catalog.buses(bus_id),
    reason         text NOT NULL,
    seats_remapped int NOT NULL DEFAULT 0,
    conflicts      int NOT NULL DEFAULT 0,
    created_by     uuid REFERENCES staff.staff_users(staff_id),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.seat_remaps (
    replacement_id uuid NOT NULL REFERENCES ops.replacements(replacement_id) ON DELETE CASCADE,
    booking_id     uuid NOT NULL,
    pnr            text NOT NULL,
    old_seat       text NOT NULL,
    new_seat       text,
    status         text NOT NULL CHECK (status IN ('REMAPPED','CONFLICT','RESOLVED')),
    resolved_by    uuid REFERENCES staff.staff_users(staff_id),
    resolved_at    timestamptz,
    PRIMARY KEY (replacement_id, booking_id, old_seat)
);

-- =========================================================================== --
--                   THREE-WAY RECONCILIATION (P2-F)                           --
-- =========================================================================== --
-- Until now settlement reconciled against the platform's own records, which is
-- one leg of three. These two tables are the other two: what the gateway says
-- it settled, and what the bank says it paid.
CREATE TABLE finance.gateway_files (
    file_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     text NOT NULL CHECK (provider IN ('BKASH','NAGAD','CARD','BANK')),
    business_date date NOT NULL,
    filename     text NOT NULL,
    line_count   int  NOT NULL DEFAULT 0,
    gross_poisha bigint NOT NULL DEFAULT 0,
    fee_poisha   bigint NOT NULL DEFAULT 0,
    net_poisha   bigint NOT NULL DEFAULT 0,
    imported_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, business_date, filename)
);

CREATE TABLE finance.gateway_lines (
    line_id        bigserial PRIMARY KEY,
    file_id        uuid NOT NULL REFERENCES finance.gateway_files(file_id) ON DELETE CASCADE,
    provider       text NOT NULL,
    provider_txn_id text NOT NULL,
    amount_poisha  bigint NOT NULL,
    fee_poisha     bigint NOT NULL DEFAULT 0,
    currency       text NOT NULL DEFAULT 'BDT',
    kind           text NOT NULL DEFAULT 'SALE' CHECK (kind IN ('SALE','REFUND','REVERSAL')),
    settled_at     timestamptz NOT NULL,
    matched_payment_id uuid
);

CREATE INDEX gateway_lines_txn_idx ON finance.gateway_lines (provider, provider_txn_id);

CREATE TABLE finance.bank_lines (
    bank_line_id bigserial PRIMARY KEY,
    account_ref  text NOT NULL,
    value_date   date NOT NULL,
    reference    text NOT NULL,
    amount_poisha bigint NOT NULL,
    direction    text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
    narrative    text NOT NULL DEFAULT '',
    matched_file_id uuid REFERENCES finance.gateway_files(file_id),
    imported_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_ref, value_date, reference)
);

-- Every exception class the plan names, as a constraint. An exception that
-- cannot be classified is an exception nobody triages.
CREATE TABLE finance.recon_exceptions (
    exception_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date date NOT NULL,
    provider     text,
    kind         text NOT NULL CHECK (kind IN (
                   'MISSING_IN_GATEWAY','MISSING_IN_PLATFORM','DUPLICATE_IN_GATEWAY',
                   'AMOUNT_MISMATCH','REVERSED_TRANSACTION','CALLBACK_FAILURE',
                   'FAILED_REFUND','MISSING_BANK_SETTLEMENT')),
    reference    text NOT NULL,
    expected_poisha bigint NOT NULL DEFAULT 0,
    actual_poisha   bigint NOT NULL DEFAULT 0,
    detail       text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','WRITTEN_OFF')),
    assigned_to  uuid REFERENCES staff.staff_users(staff_id),
    resolution   text,
    detected_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz,
    UNIQUE (business_date, kind, reference)
);

CREATE INDEX recon_open_idx ON finance.recon_exceptions (status, business_date);

-- A run of the three-way match, kept so "when did we last reconcile?" has an
-- answer that is a row rather than a memory.
CREATE TABLE finance.recon_runs (
    run_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date date NOT NULL,
    platform_poisha bigint NOT NULL DEFAULT 0,
    gateway_poisha  bigint NOT NULL DEFAULT 0,
    bank_poisha     bigint NOT NULL DEFAULT 0,
    exceptions_found int NOT NULL DEFAULT 0,
    ran_at       timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================== --
--                     PARTNER API AND WEBHOOKS (P3-B)                         --
-- =========================================================================== --
CREATE SCHEMA IF NOT EXISTS partner;

CREATE TABLE partner.partners (
    partner_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    contact_email text NOT NULL,
    -- A partner starts in SANDBOX and cannot be moved to LIVE until they pass
    -- the certification checklist below.
    tier        text NOT NULL DEFAULT 'SANDBOX' CHECK (tier IN ('SANDBOX','LIVE','SUSPENDED')),
    daily_quota int  NOT NULL DEFAULT 10000,
    rate_per_min int NOT NULL DEFAULT 120,
    ip_allowlist text[] NOT NULL DEFAULT '{}',
    certified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner.api_keys (
    key_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id  uuid NOT NULL REFERENCES partner.partners(partner_id) ON DELETE CASCADE,
    client_id   text UNIQUE NOT NULL,
    -- Only the hash of the secret is stored, and the signing secret is separate
    -- from it so a leaked signing secret does not also authenticate.
    secret_hash text NOT NULL,
    signing_secret text NOT NULL,
    status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

-- Replay defence for signed requests: a nonce is good exactly once inside the
-- signature's five-minute window.
CREATE TABLE partner.request_nonces (
    partner_id uuid NOT NULL,
    nonce      text NOT NULL,
    seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (partner_id, nonce)
);

CREATE INDEX request_nonces_age_idx ON partner.request_nonces (seen_at);

CREATE TABLE partner.quota_usage (
    partner_id uuid NOT NULL REFERENCES partner.partners(partner_id) ON DELETE CASCADE,
    day        date NOT NULL,
    calls      int  NOT NULL DEFAULT 0,
    rejected   int  NOT NULL DEFAULT 0,
    PRIMARY KEY (partner_id, day)
);

CREATE TABLE partner.subscriptions (
    subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id  uuid NOT NULL REFERENCES partner.partners(partner_id) ON DELETE CASCADE,
    url         text NOT NULL,
    event_types text[] NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The partner-visible delivery log: every attempt, its response, and when the
-- next retry is due. Partners ask "did you send it?" and this answers.
CREATE TABLE partner.deliveries (
    delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id uuid NOT NULL REFERENCES partner.subscriptions(subscription_id) ON DELETE CASCADE,
    partner_id  uuid NOT NULL,
    event_id    uuid NOT NULL,
    event_type  text NOT NULL,
    -- text, not jsonb, and deliberately so: the signature covers the exact
    -- bytes that go on the wire. jsonb normalises key order and whitespace on
    -- the way back out, which would leave every delivery signed for a body the
    -- partner never receives.
    payload     text NOT NULL,
    signature   text NOT NULL,
    status      text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','DELIVERED','RETRYING','DEAD')),
    attempts    int NOT NULL DEFAULT 0,
    last_status_code int,
    last_error  text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    UNIQUE (subscription_id, event_id)
);

CREATE INDEX deliveries_due_idx ON partner.deliveries (next_attempt_at)
    WHERE status IN ('PENDING','RETRYING');

-- The sandbox endpoint a partner integrates against before they are given
-- production keys. It is also where this build's own webhooks land, so the
-- signing, the delivery, the retry and the verification are all exercised for
-- real rather than asserted.
CREATE TABLE partner.sandbox_receipts (
    receipt_id  bigserial PRIMARY KEY,
    partner_id  uuid,
    event_id    uuid,
    event_type  text NOT NULL,
    signature_ok boolean NOT NULL,
    body        jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================== --
--                        RISK AND FRAUD (P3-A)                                --
-- =========================================================================== --
CREATE SCHEMA IF NOT EXISTS risk;

-- Rules are rows, versioned and hot-reloadable, and every one of them starts in
-- shadow mode. A rule that has never been observed is a rule nobody should be
-- blocked by.
CREATE TABLE risk.rules (
    rule_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text UNIQUE NOT NULL,
    description text NOT NULL,
    signal      text NOT NULL CHECK (signal IN (
                  'HOLD_RATE','BOOKING_RATE','CANCELLATION_RATE','REFUND_RATE',
                  'PAYMENT_FAILURES','IP_VELOCITY','DEVICE_VELOCITY','PHONE_VELOCITY',
                  'HOLD_TO_BOOK_RATIO','AMOUNT')),
    window_minutes int NOT NULL DEFAULT 60,
    threshold   numeric NOT NULL,
    outcome     text NOT NULL CHECK (outcome IN ('ALLOW','CHALLENGE','REVIEW','RATE_LIMIT','BLOCK')),
    -- SHADOW rules are evaluated and recorded but never enforced. Nothing moves
    -- to ENFORCING without two weeks of observed false-positive rate.
    mode        text NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','ENFORCING','DISABLED')),
    version     int  NOT NULL DEFAULT 1,
    hits        bigint NOT NULL DEFAULT 0,
    false_positives bigint NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risk.events (
    risk_event_id bigserial PRIMARY KEY,
    subject_kind text NOT NULL CHECK (subject_kind IN ('IP','DEVICE','PHONE','USER','PARTNER')),
    subject      text NOT NULL,
    action       text NOT NULL,
    rule_code    text,
    outcome      text NOT NULL CHECK (outcome IN ('ALLOW','CHALLENGE','REVIEW','RATE_LIMIT','BLOCK')),
    enforced     boolean NOT NULL DEFAULT false,
    score        numeric NOT NULL DEFAULT 0,
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
    latency_us   int NOT NULL DEFAULT 0,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX risk_events_subject_idx ON risk.events (subject_kind, subject, occurred_at DESC);
CREATE INDEX risk_events_recent_idx  ON risk.events (occurred_at DESC);

CREATE TABLE risk.cases (
    case_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_kind text NOT NULL,
    subject     text NOT NULL,
    reason      text NOT NULL,
    status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLEARED','CONFIRMED')),
    opened_at   timestamptz NOT NULL DEFAULT now(),
    closed_at   timestamptz,
    closed_by   uuid REFERENCES staff.staff_users(staff_id),
    note        text,
    UNIQUE (subject_kind, subject, status)
);

-- A block is always reversible and always attributable.
CREATE TABLE risk.blocks (
    subject_kind text NOT NULL,
    subject      text NOT NULL,
    reason       text NOT NULL,
    blocked_by   uuid REFERENCES staff.staff_users(staff_id),
    blocked_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz,
    lifted_by    uuid REFERENCES staff.staff_users(staff_id),
    lifted_at    timestamptz,
    PRIMARY KEY (subject_kind, subject)
);

-- =========================================================================== --
--                                SEED                                          --
-- =========================================================================== --

INSERT INTO risk.rules (code, description, signal, window_minutes, threshold, outcome, mode) VALUES
 ('HOLD_FLOOD_IP',  'One address holding seats far faster than a person books', 'HOLD_RATE',        10, 25, 'RATE_LIMIT', 'ENFORCING'),
 ('HOLD_NO_BOOK',   'Holds far outnumber bookings from one device',             'HOLD_TO_BOOK_RATIO',60, 10, 'CHALLENGE',  'SHADOW'),
 ('PAY_FAIL_BURST', 'Repeated payment failures from one phone number',          'PAYMENT_FAILURES', 30,  6, 'REVIEW',     'ENFORCING'),
 ('CANCEL_CHURN',   'Cancellation rate far above the platform norm',            'CANCELLATION_RATE',1440, 5, 'REVIEW',    'SHADOW'),
 ('PHONE_VELOCITY', 'Many accounts from one address in a short window',         'PHONE_VELOCITY',   60, 15, 'CHALLENGE',  'SHADOW'),
 ('HIGH_VALUE',     'A single booking far above the usual ticket value',        'AMOUNT',           60, 5000000, 'REVIEW', 'SHADOW');

INSERT INTO promo.campaigns
    (code, title, kind, discount_pct, max_discount_poisha, min_amount_poisha,
     max_redemptions, per_user_limit, ends_at)
VALUES
 ('EIDSAFAR2',  'Eid Safar — 12% off',        'COUPON',  12, 30000, 100000, NULL, 2, now() + interval '60 days'),
 ('FIRST100',   'First 100 riders — 20% off', 'LIMITED', 20, 50000,  50000,  100, 1, now() + interval '30 days'),
 ('NEWRIDER',   'Welcome — 15% off',          'NEW_USER',15, 25000,      0, NULL, 1, now() + interval '365 days'),
 ('BKASHPAY',   'Pay with bKash — 8% off',    'PAYMENT',  8, 20000,      0, NULL, 5, now() + interval '90 days');

UPDATE promo.campaigns SET payment_provider = 'BKASH' WHERE code = 'BKASHPAY';

INSERT INTO partner.partners (name, contact_email, tier, daily_quota, rate_per_min)
VALUES ('Shohoz Sandbox', 'api@shohoz.test', 'SANDBOX', 5000, 60),
       ('GoZayaan',       'dev@gozayaan.test','LIVE',   50000, 600);

-- Demo credentials, exactly as weak and as public as the staff fixtures, and
-- for the same reason: a local harness must not carry a real secret.
INSERT INTO partner.api_keys (partner_id, client_id, secret_hash, signing_secret)
SELECT partner_id,
       'pk_' || lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')),
       encode(sha256(('sk_' || lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) || '_demo')::bytea), 'hex'),
       'whsec_' || lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) || '_demo'
  FROM partner.partners;

-- Pointed at this build's own sandbox sink so the delivery loop is real: signed,
-- posted over HTTP, verified at the other end, retried when it fails.
INSERT INTO partner.subscriptions (partner_id, url, event_types)
SELECT partner_id, 'http://localhost:8080/api/v1/partner/sandbox/sink',
       '{booking.confirmed,booking.cancelled,payment.success,refund.completed,trip.cancelled,trip.delayed}'
  FROM partner.partners;

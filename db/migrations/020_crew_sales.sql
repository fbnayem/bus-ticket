-- 020_crew_sales.sql — the conductor as a sales channel.
--
-- Until now the crew app was a boarding tool: list trips, read a manifest,
-- scan at the door, report an incident. On a real intercity route in
-- Bangladesh the conductor is also the salesperson. Passengers get on at
-- Cumilla with no ticket, negotiate a fare, pay cash, and the conductor
-- settles up with the owner at the end of the run. None of that was
-- representable.
--
-- What this file adds, and why each part earns its rows:
--
--   crew.duties            the cash bag. Without a container, cash taken on a
--                          bus is cash nobody can reconcile.
--   crew.duty_trips        the same money sliced per bus run, sealed without a
--                          physical count. The owner asked for both views.
--   crew.cash_transactions signed movements, so "expected" is a sum and not an
--                          opinion.
--   crew.discount_*        the authority to charge less, bounded and reasoned.
--   crew.commission_*      what the crew earns, and what a discount costs them.
--
-- Two constraints here are load-bearing and live in the database rather than
-- in a service, for the same reason the two in 007_channels.sql do:
--
--   1. crew.duties UNIQUE partial index on one OPEN duty per staff member.
--      Two open bags make every taka in a pocket unattributable, and no amount
--      of later reporting recovers the attribution.
--   2. crew.commissions CHECK (amount_poisha = gross_amount_poisha - forfeit_poisha)
--      AND (forfeit_poisha <= gross_amount_poisha). Commission cannot go
--      negative however large a discount was granted. A service can forget the
--      floor; a CHECK cannot.
--
-- The architectural rule is untouched: an on-board sale acquires seats through
-- inventory-service like every other channel. There is no seat table here.

BEGIN;

CREATE SCHEMA IF NOT EXISTS crew;

-- ==================================================================== duty ==

-- The cash bag. Deliberately the same shape as counter.shifts — it is the same
-- problem (money in someone's keeping, counted at the end) and answering it two
-- different ways would mean two different reconciliation stories.
CREATE TABLE crew.duties (
    duty_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id             uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    operator_id          uuid NOT NULL REFERENCES catalog.operators(operator_id),
    status               text NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','BALANCED','VARIANCE')),
    opening_float_poisha bigint NOT NULL DEFAULT 0 CHECK (opening_float_poisha >= 0),
    counted_cash_poisha  bigint,
    expected_cash_poisha bigint,
    variance_poisha      bigint,
    note                 text,
    opened_at            timestamptz NOT NULL DEFAULT now(),
    closed_at            timestamptz
);

-- One bag open per person at a time. See the header.
CREATE UNIQUE INDEX duties_one_open_per_staff
    ON crew.duties (staff_id) WHERE status = 'OPEN';
CREATE INDEX ON crew.duties (staff_id, opened_at DESC);

-- The per-trip half of the answer. Sealed with a snapshot rather than a count:
-- a conductor running four trips in a day should count money once, but a
-- dispute about the 22:00 run needs that run's own numbers.
CREATE TABLE crew.duty_trips (
    duty_id            uuid NOT NULL REFERENCES crew.duties(duty_id) ON DELETE CASCADE,
    trip_id            uuid NOT NULL,
    sales_count        integer NOT NULL DEFAULT 0,
    gross_poisha       bigint  NOT NULL DEFAULT 0,
    discount_poisha    bigint  NOT NULL DEFAULT 0,
    commission_poisha  bigint  NOT NULL DEFAULT 0,
    opened_at          timestamptz NOT NULL DEFAULT now(),
    closed_at          timestamptz,
    PRIMARY KEY (duty_id, trip_id)
);

-- Signed: what the bag physically gained (+) or lost (-). Same convention as
-- counter.cash_transactions. A separate table only because that one's foreign
-- key points at counter.shifts.
CREATE TABLE crew.cash_transactions (
    txn_id        bigserial PRIMARY KEY,
    duty_id       uuid NOT NULL REFERENCES crew.duties(duty_id),
    trip_id       uuid,
    kind          text NOT NULL
                  CHECK (kind IN ('SALE','REFUND','PAY_IN','PAY_OUT','WRITEDOWN')),
    booking_id    uuid REFERENCES commerce.bookings(booking_id),
    amount_poisha bigint NOT NULL,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON crew.cash_transactions (duty_id, created_at);

-- ================================================================ discount ==

-- What a role may take off a published fare, set by the operator.
--
-- An operator with no row here cannot discount at all. That is the safe
-- default rather than the permissive one: the absence of a policy is not
-- permission, and a bug that fails to find a policy must refuse rather than
-- wave a sale through.
CREATE TABLE crew.discount_policies (
    policy_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id       uuid NOT NULL REFERENCES catalog.operators(operator_id),
    crew_role         text NOT NULL CHECK (crew_role IN ('DRIVER','HELPER','SUPERVISOR')),
    -- Basis points, never a float. 12.5% is exactly 1250.
    max_pct_bp        integer NOT NULL DEFAULT 0 CHECK (max_pct_bp BETWEEN 0 AND 10000),
    max_amount_poisha bigint  NOT NULL DEFAULT 0 CHECK (max_amount_poisha >= 0),
    active            boolean NOT NULL DEFAULT true,
    UNIQUE (operator_id, crew_role)
);

-- Why the fare was reduced. Required on every discounted sale: an unexplained
-- discount is indistinguishable from a conductor pocketing the difference.
CREATE TABLE crew.discount_reasons (
    code       text PRIMARY KEY,
    label      text NOT NULL,
    label_bn   text NOT NULL,
    -- A reason may cap tighter than the role policy. The binding cap is the
    -- lower of the two; 0 here means "the role policy alone decides".
    max_pct_bp integer NOT NULL DEFAULT 0 CHECK (max_pct_bp BETWEEN 0 AND 10000),
    active     boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO crew.discount_reasons (code, label, label_bn, max_pct_bp, sort_order) VALUES
    ('CHILD',      'Child',      'শিশু',          5000, 1),
    ('STUDENT',    'Student',    'শিক্ষার্থী',      2500, 2),
    ('SENIOR',     'Senior',     'প্রবীণ',         2500, 3),
    ('STAFF',      'Staff',      'কর্মী',          10000, 4),
    ('NEGOTIATED', 'Negotiated', 'দরদাম করা',        0, 5)
ON CONFLICT (code) DO NOTHING;

-- ============================================================== commission ==

-- Same columns and the same PCT/FLAT + priority resolution as
-- agent.commission_rules. Two commission engines would drift.
CREATE TABLE crew.commission_rules (
    rule_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id   uuid REFERENCES catalog.operators(operator_id),
    route_id      uuid REFERENCES catalog.routes(route_id),
    crew_role     text CHECK (crew_role IN ('DRIVER','HELPER','SUPERVISOR')),
    kind          text NOT NULL CHECK (kind IN ('PCT','FLAT')),
    value_bp      integer,
    amount_poisha bigint,
    priority      integer NOT NULL DEFAULT 0,
    active        boolean NOT NULL DEFAULT true,
    CONSTRAINT crew_commission_value_present
        CHECK ((kind = 'PCT' AND value_bp IS NOT NULL)
            OR (kind = 'FLAT' AND amount_poisha IS NOT NULL))
);

-- All three amounts are stored, not just the net. It is the difference between
-- a crew member seeing "৳15" and seeing "you earned ৳40 and gave up ৳25" —
-- and only the second one explains itself at the end of a shift.
CREATE TABLE crew.commissions (
    commission_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          uuid NOT NULL UNIQUE REFERENCES commerce.bookings(booking_id),
    staff_id            uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    duty_id             uuid REFERENCES crew.duties(duty_id),
    rule_id             uuid REFERENCES crew.commission_rules(rule_id),
    gross_amount_poisha bigint NOT NULL CHECK (gross_amount_poisha >= 0),
    forfeit_poisha      bigint NOT NULL DEFAULT 0 CHECK (forfeit_poisha >= 0),
    amount_poisha       bigint NOT NULL CHECK (amount_poisha >= 0),
    journal_id          uuid REFERENCES finance.journal_entries(journal_id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- The commission floor, in the schema. However large the discount, a crew
    -- member is never asked to pay for a sale out of their own pocket.
    CONSTRAINT crew_commission_arithmetic
        CHECK (forfeit_poisha <= gross_amount_poisha
           AND amount_poisha = gross_amount_poisha - forfeit_poisha)
);
CREATE INDEX ON crew.commissions (staff_id, created_at DESC);

-- ================================================== the rest of the system ==

-- On-board is a channel like the other five. Widened rather than dropped: a
-- channel value that nothing writes is still a typo waiting to be accepted.
ALTER TABLE inventory.seat_holds
    DROP CONSTRAINT IF EXISTS seat_holds_channel_check;
ALTER TABLE inventory.seat_holds
    ADD CONSTRAINT seat_holds_channel_check
    CHECK (channel IN ('WEB','APP','COUNTER','COUNTER_OFFLINE','AGENT','PARTNER',
                       'AI','OPERATOR','ONBOARD'));

-- price_snapshot already carries the detail of a discounted sale. These columns
-- exist because the crew's own report, and any settlement dispute six months
-- from now, need to filter and sum on it rather than dig through jsonb.
ALTER TABLE commerce.bookings
    ADD COLUMN IF NOT EXISTS discount_poisha bigint NOT NULL DEFAULT 0
        CHECK (discount_poisha >= 0),
    ADD COLUMN IF NOT EXISTS discount_reason text,
    ADD COLUMN IF NOT EXISTS duty_id uuid REFERENCES crew.duties(duty_id);

CREATE INDEX IF NOT EXISTS bookings_duty_idx ON commerce.bookings (duty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_soldby_idx ON commerce.bookings (sold_by, created_at DESC);

-- Two accounts the crew channel posts to.
--
-- Crew cash is deliberately NOT 1001 Cash alongside counter drawers. A drawer
-- is in a locked room; a cash bag is in a pocket on a moving bus. Giving it its
-- own account makes "how much cash is in pockets right now" a single balance
-- query, which is the control this whole feature exists to provide.
INSERT INTO finance.ledger_accounts (account_code, name, normal_side) VALUES
    ('1002', 'Cash in Transit — Crew', 'DR'),
    ('2103', 'Crew Payable',           'CR')
ON CONFLICT (account_code) DO NOTHING;

-- ============================================================= permissions ==

-- crew.discount is separate from crew.sell on purpose: an operator must be able
-- to let a conductor sell a ticket without letting them negotiate the price.
INSERT INTO catalog.permissions (permission) VALUES
    ('crew.sell'), ('crew.duty'), ('crew.discount'), ('crew.report')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    -- DRIVER
    ('c0000000-0000-0000-0000-000000000016','crew.sell'),
    ('c0000000-0000-0000-0000-000000000016','crew.duty'),
    ('c0000000-0000-0000-0000-000000000016','crew.discount'),
    ('c0000000-0000-0000-0000-000000000016','crew.report'),
    -- HELPER: sells and runs a bag, but does not set prices.
    ('c0000000-0000-0000-0000-000000000017','crew.sell'),
    ('c0000000-0000-0000-0000-000000000017','crew.duty'),
    ('c0000000-0000-0000-0000-000000000017','crew.report')
ON CONFLICT DO NOTHING;

-- ============================================================ demo fixtures ==

-- Scoped to the demo operator only. A seeded fixture is not a policy: any other
-- operator starts with no discount authority and full-fare selling.
INSERT INTO crew.discount_policies (operator_id, crew_role, max_pct_bp, max_amount_poisha) VALUES
    ('11111111-1111-1111-1111-111111111111','DRIVER',     2000, 20000),
    ('11111111-1111-1111-1111-111111111111','HELPER',     1000, 10000),
    ('11111111-1111-1111-1111-111111111111','SUPERVISOR', 3000, 30000)
ON CONFLICT (operator_id, crew_role) DO NOTHING;

INSERT INTO crew.commission_rules (operator_id, crew_role, kind, value_bp, priority)
SELECT '11111111-1111-1111-1111-111111111111', NULL, 'PCT', 500, 0
 WHERE NOT EXISTS (
    SELECT 1 FROM crew.commission_rules
     WHERE operator_id = '11111111-1111-1111-1111-111111111111' AND crew_role IS NULL);

COMMIT;

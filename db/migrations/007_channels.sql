-- 007_channels.sql — the domains the non-passenger channels need.
--
-- Six applications land on top of this file: operator ERP, counter POS, agent
-- portal, admin console, support console and the driver/crew app. Not one of
-- them gets a seat table. Seats live in inventory.trip_seats and are mutated
-- only by inventory-service, exactly as in 002_inventory.sql. What is added
-- here is who may act (staff), where money physically sits (counter drawers,
-- agent wallets), who is owed it (settlements) and what happened at the bus
-- door (boarding scans).
--
-- Two constraints in this file are load-bearing and deliberately expressed in
-- the database rather than in application code:
--
--   1. finance.approvals CHECK (approved_by <> requested_by) — maker-checker.
--      A service can forget to check. A CHECK constraint cannot.
--   2. counter.shifts UNIQUE partial index on an open shift per counter — two
--      concurrently open drawers on one counter make cash unattributable.

BEGIN;

CREATE SCHEMA IF NOT EXISTS staff;
CREATE SCHEMA IF NOT EXISTS counter;
CREATE SCHEMA IF NOT EXISTS agent;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS support;

-- ============================================================== staff & RBAC =

-- Roles are data. Creating "Regional Supervisor" is an INSERT, never a deploy.
CREATE TABLE staff.staff_users (
    staff_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    full_name     text NOT NULL,
    phone         text,
    -- PBKDF2-HMAC-SHA256. The salt is per-user; the iteration count is stored
    -- alongside so it can be raised for new passwords without invalidating old.
    password_hash text NOT NULL,
    password_salt text NOT NULL,
    password_iter integer NOT NULL DEFAULT 210000,
    -- Tenancy. A NULL operator_id means platform staff; anything else is
    -- scoped and every operator-facing query filters on it.
    operator_id   uuid REFERENCES catalog.operators(operator_id),
    counter_id    uuid,
    agency_id     uuid,
    mfa_enabled   boolean NOT NULL DEFAULT false,
    mfa_secret    text,
    status        text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','SUSPENDED','LOCKED')),
    failed_logins integer NOT NULL DEFAULT 0,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff.user_roles (
    staff_id uuid NOT NULL REFERENCES staff.staff_users(staff_id) ON DELETE CASCADE,
    role_id  uuid NOT NULL REFERENCES catalog.roles(role_id) ON DELETE CASCADE,
    PRIMARY KEY (staff_id, role_id)
);

-- Sessions store only a hash of the bearer token. A database dump does not
-- hand the reader a working session.
CREATE TABLE staff.sessions (
    session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   uuid NOT NULL REFERENCES staff.staff_users(staff_id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    issued_at  timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    ip         inet,
    user_agent text
);
CREATE INDEX ON staff.sessions (staff_id, expires_at DESC);

-- ================================================================== counters =

CREATE TABLE counter.counters (
    counter_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid NOT NULL REFERENCES catalog.operators(operator_id),
    name        text NOT NULL,
    location_id uuid REFERENCES catalog.locations(location_id),
    address     text,
    status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counter.shifts (
    shift_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    counter_id           uuid NOT NULL REFERENCES counter.counters(counter_id),
    staff_id             uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    status               text NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','BALANCED','VARIANCE')),
    opening_float_poisha bigint NOT NULL DEFAULT 0 CHECK (opening_float_poisha >= 0),
    counted_cash_poisha  bigint,
    expected_cash_poisha bigint,
    variance_poisha      bigint,
    approved_by          uuid REFERENCES staff.staff_users(staff_id),
    note                 text,
    opened_at            timestamptz NOT NULL DEFAULT now(),
    closed_at            timestamptz
);

-- One drawer open per counter at a time. Two open shifts make every taka in
-- the till ambiguous, and no amount of reporting recovers the attribution.
CREATE UNIQUE INDEX shifts_one_open_per_counter
    ON counter.shifts (counter_id) WHERE status = 'OPEN';

CREATE TABLE counter.cash_transactions (
    txn_id        bigserial PRIMARY KEY,
    shift_id      uuid NOT NULL REFERENCES counter.shifts(shift_id),
    kind          text NOT NULL
                  CHECK (kind IN ('SALE','REFUND','PAY_IN','PAY_OUT','WRITEDOWN')),
    method        text NOT NULL DEFAULT 'CASH'
                  CHECK (method IN ('CASH','BKASH','NAGAD','CARD')),
    booking_id    uuid REFERENCES commerce.bookings(booking_id),
    -- Signed: what the drawer physically gained (+) or lost (-).
    amount_poisha bigint NOT NULL,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON counter.cash_transactions (shift_id, created_at);

-- Counter quota: seats a counter exclusively owns so it can keep selling when
-- the network drops. The seats are BLOCKED in inventory.trip_seats — the same
-- bitmask every other channel respects — so a quota seat is invisible to the
-- website for as long as the counter holds it. This table records only who
-- owns which block; it is not a second seat table.
CREATE TABLE counter.quota_items (
    quota_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    counter_id   uuid NOT NULL REFERENCES counter.counters(counter_id),
    trip_id      uuid NOT NULL,
    seat_no      text NOT NULL,
    segment_mask bigint NOT NULL,
    board_seq    integer NOT NULL,
    drop_seq     integer NOT NULL,
    status       text NOT NULL DEFAULT 'ALLOCATED'
                 CHECK (status IN ('ALLOCATED','SOLD','RELEASED')),
    allocated_at timestamptz NOT NULL DEFAULT now(),
    settled_at   timestamptz,
    UNIQUE (trip_id, seat_no, segment_mask, counter_id)
);
CREATE INDEX ON counter.quota_items (counter_id, status);

-- An offline sale replays exactly once. client_ref is minted on the terminal
-- before the sale is made, so replaying the queue ten times still books once.
CREATE TABLE counter.offline_sales (
    client_ref   text PRIMARY KEY,
    counter_id   uuid NOT NULL REFERENCES counter.counters(counter_id),
    terminal_seq bigint NOT NULL,
    payload      jsonb NOT NULL,
    booking_id   uuid REFERENCES commerce.bookings(booking_id),
    pnr          text,
    status       text NOT NULL DEFAULT 'REPLAYED'
                 CHECK (status IN ('REPLAYED','REJECTED')),
    reject_reason text,
    sold_at      timestamptz NOT NULL,
    replayed_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ agents & wallet =

CREATE TABLE agent.agencies (
    agency_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    parent_id   uuid REFERENCES agent.agencies(agency_id),
    operator_id uuid REFERENCES catalog.operators(operator_id),
    phone       text,
    address     text,
    kyc_status  text NOT NULL DEFAULT 'PENDING'
                CHECK (kyc_status IN ('PENDING','VERIFIED','REJECTED')),
    status      text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- available_poisha and held_poisha are a CACHE, not the truth. The truth is
-- agent.wallet_transactions, which is append-only. wallet.Recompute() rebuilds
-- both from the transaction log and the proof suite asserts they match.
CREATE TABLE agent.wallets (
    wallet_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id          uuid NOT NULL UNIQUE REFERENCES agent.agencies(agency_id),
    available_poisha   bigint NOT NULL DEFAULT 0,
    held_poisha        bigint NOT NULL DEFAULT 0 CHECK (held_poisha >= 0),
    credit_limit_poisha bigint NOT NULL DEFAULT 0 CHECK (credit_limit_poisha >= 0),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Spending power may never go below the negative of the credit limit.
    -- This is the backstop behind the conditional UPDATE in wallet.Hold.
    CONSTRAINT wallet_within_credit
        CHECK (available_poisha - held_poisha >= -credit_limit_poisha)
);

CREATE TABLE agent.wallet_transactions (
    txn_id        bigserial PRIMARY KEY,
    wallet_id     uuid NOT NULL REFERENCES agent.wallets(wallet_id),
    kind          text NOT NULL
                  CHECK (kind IN ('RECHARGE','SALE','REFUND','COMMISSION','ADJUSTMENT')),
    delta_poisha  bigint NOT NULL,
    booking_id    uuid REFERENCES commerce.bookings(booking_id),
    ref           text,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON agent.wallet_transactions (wallet_id, txn_id DESC);
REVOKE UPDATE, DELETE ON agent.wallet_transactions FROM PUBLIC;

CREATE TABLE agent.wallet_holds (
    wallet_hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id      uuid NOT NULL REFERENCES agent.wallets(wallet_id),
    amount_poisha  bigint NOT NULL CHECK (amount_poisha > 0),
    status         text NOT NULL DEFAULT 'HELD'
                   CHECK (status IN ('HELD','CAPTURED','RELEASED')),
    seat_hold_id   uuid,
    booking_id     uuid REFERENCES commerce.bookings(booking_id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    settled_at     timestamptz
);
CREATE INDEX ON agent.wallet_holds (wallet_id, status);

CREATE TABLE agent.recharges (
    recharge_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id     uuid NOT NULL REFERENCES agent.wallets(wallet_id),
    amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
    method        text NOT NULL CHECK (method IN ('BKASH','NAGAD','BANK')),
    reference     text,
    status        text NOT NULL DEFAULT 'REQUESTED'
                  CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
    requested_by  uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    approved_by   uuid REFERENCES staff.staff_users(staff_id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    approved_at   timestamptz,
    -- Money entering the platform is never self-approved.
    CONSTRAINT recharge_maker_is_not_checker
        CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- Most-specific rule wins: a rule matching this agency AND this route beats a
-- rule matching the operator alone. `priority` breaks remaining ties.
CREATE TABLE agent.commission_rules (
    rule_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid REFERENCES catalog.operators(operator_id),
    agency_id   uuid REFERENCES agent.agencies(agency_id),
    route_id    uuid REFERENCES catalog.routes(route_id),
    channel     text,
    kind        text NOT NULL CHECK (kind IN ('PCT','FLAT')),
    -- PCT is in basis points so 2.5% is exactly 250, never 0.025.
    value_bp    integer,
    amount_poisha bigint,
    priority    integer NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    CONSTRAINT commission_value_present
        CHECK ((kind = 'PCT' AND value_bp IS NOT NULL)
            OR (kind = 'FLAT' AND amount_poisha IS NOT NULL))
);

CREATE TABLE agent.commissions (
    commission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id    uuid NOT NULL UNIQUE REFERENCES commerce.bookings(booking_id),
    agency_id     uuid NOT NULL REFERENCES agent.agencies(agency_id),
    rule_id       uuid REFERENCES agent.commission_rules(rule_id),
    amount_poisha bigint NOT NULL,
    journal_id    uuid REFERENCES finance.journal_entries(journal_id),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================== operations: crew & the road =

CREATE TABLE ops.trip_crew (
    trip_id   uuid NOT NULL,
    staff_id  uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    crew_role text NOT NULL CHECK (crew_role IN ('DRIVER','HELPER','SUPERVISOR')),
    PRIMARY KEY (trip_id, staff_id)
);
CREATE INDEX ON ops.trip_crew (staff_id);

-- client_ref is minted on the scanning device before the scan is attempted, so
-- an offline scan queue can be flushed repeatedly without double-marking.
CREATE TABLE ops.boarding_scans (
    scan_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_ref  text NOT NULL UNIQUE,
    trip_id     uuid NOT NULL,
    pnr         text,
    seat_no     text,
    ticket_id   uuid REFERENCES commerce.tickets(ticket_id),
    result      text NOT NULL
                CHECK (result IN ('BOARDED','ALREADY_BOARDED','NOT_FOUND',
                                  'WRONG_TRIP','CANCELLED','BAD_TOKEN','NO_SHOW')),
    scanned_by  uuid REFERENCES staff.staff_users(staff_id),
    device_ref  text,
    scanned_at  timestamptz NOT NULL DEFAULT now(),
    synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.boarding_scans (trip_id, scanned_at DESC);

CREATE TABLE ops.incidents (
    incident_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid NOT NULL,
    kind        text NOT NULL
                CHECK (kind IN ('BREAKDOWN','ACCIDENT','ROUTE_INTERRUPTION',
                                'DELAY','PASSENGER_ISSUE','OTHER')),
    severity    text NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
    note        text NOT NULL,
    reported_by uuid REFERENCES staff.staff_users(staff_id),
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.incidents (trip_id, created_at DESC);

-- Real positions reported by the driver app. When a trip has rows here the
-- passenger tracking page reports GPS; when it has none it says plainly that
-- the position is estimated from the timetable. The page never claims GPS it
-- does not have.
CREATE TABLE ops.bus_positions (
    position_id bigserial PRIMARY KEY,
    trip_id     uuid NOT NULL,
    lat         numeric(9,6) NOT NULL,
    lng         numeric(9,6) NOT NULL,
    speed_kph   numeric(5,1),
    heading     integer,
    source      text NOT NULL DEFAULT 'DRIVER_APP'
                CHECK (source IN ('DRIVER_APP','GPS_DEVICE','THIRD_PARTY')),
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.bus_positions (trip_id, recorded_at DESC);

-- ================================================= settlement & maker-checker =

CREATE TABLE finance.settlements (
    settlement_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id        uuid NOT NULL REFERENCES catalog.operators(operator_id),
    period_start       date NOT NULL,
    period_end         date NOT NULL,
    status             text NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN','CALCULATED','REVIEWED','APPROVED',
                                         'PAYMENT_INITIATED','PAID','RECONCILED')),
    gross_poisha       bigint NOT NULL DEFAULT 0,
    commission_poisha  bigint NOT NULL DEFAULT 0,
    refund_poisha      bigint NOT NULL DEFAULT 0,
    net_payable_poisha bigint NOT NULL DEFAULT 0,
    booking_count      integer NOT NULL DEFAULT 0,
    calculated_at      timestamptz,
    reviewed_by        uuid REFERENCES staff.staff_users(staff_id),
    approved_by        uuid REFERENCES staff.staff_users(staff_id),
    approved_at        timestamptz,
    paid_at            timestamptz,
    payment_ref        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (operator_id, period_start, period_end)
);

CREATE TABLE finance.settlement_items (
    settlement_id     uuid NOT NULL REFERENCES finance.settlements(settlement_id) ON DELETE CASCADE,
    booking_id        uuid NOT NULL REFERENCES commerce.bookings(booking_id),
    gross_poisha      bigint NOT NULL,
    commission_poisha bigint NOT NULL,
    refund_poisha     bigint NOT NULL DEFAULT 0,
    net_poisha        bigint NOT NULL,
    PRIMARY KEY (settlement_id, booking_id)
);

-- Every sensitive money operation walks REQUEST -> APPROVE -> EXECUTE through
-- this table. The CHECK below is the whole point: a requester can never be
-- their own approver, and that is true even if a future service forgets to
-- check it.
CREATE TABLE finance.approvals (
    approval_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation    text NOT NULL
                 CHECK (operation IN ('MANUAL_REFUND','SETTLEMENT_APPROVAL',
                                      'COMMISSION_ADJUSTMENT','LEDGER_ADJUSTMENT',
                                      'GATEWAY_CHANGE','BANK_ACCOUNT_CHANGE',
                                      'SHIFT_VARIANCE','WALLET_RECHARGE')),
    resource_ref text NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status       text NOT NULL DEFAULT 'REQUESTED'
                 CHECK (status IN ('REQUESTED','APPROVED','REJECTED','EXECUTED')),
    requested_by uuid NOT NULL REFERENCES staff.staff_users(staff_id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    approved_by  uuid REFERENCES staff.staff_users(staff_id),
    approved_at  timestamptz,
    reason       text,
    CONSTRAINT approval_maker_is_not_checker
        CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX ON finance.approvals (status, requested_at DESC);

-- ============================================================ support console =

CREATE TABLE support.cases (
    case_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference   text NOT NULL UNIQUE,
    pnr         text,
    phone       text,
    subject     text NOT NULL,
    category    text NOT NULL DEFAULT 'OTHER'
                CHECK (category IN ('REFUND','PAYMENT','BOOKING','TRIP','TICKET','OTHER')),
    priority    text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    status      text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED')),
    opened_by   uuid REFERENCES staff.staff_users(staff_id),
    assigned_to uuid REFERENCES staff.staff_users(staff_id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);
CREATE INDEX ON support.cases (status, created_at DESC);
CREATE INDEX ON support.cases (pnr);

CREATE TABLE support.case_notes (
    note_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id    uuid NOT NULL REFERENCES support.cases(case_id) ON DELETE CASCADE,
    author_id  uuid REFERENCES staff.staff_users(staff_id),
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON support.case_notes (case_id, created_at);

-- =================================================== channel attribution ====

-- Which channel, which counter, which agency, which member of staff. Without
-- these a settlement cannot split operator revenue from agent commission, and
-- support cannot answer "who sold this ticket?".
ALTER TABLE commerce.bookings
    ADD COLUMN IF NOT EXISTS counter_id uuid REFERENCES counter.counters(counter_id),
    ADD COLUMN IF NOT EXISTS agency_id  uuid REFERENCES agent.agencies(agency_id),
    ADD COLUMN IF NOT EXISTS sold_by    uuid REFERENCES staff.staff_users(staff_id),
    ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES finance.settlements(settlement_id);

CREATE INDEX IF NOT EXISTS bookings_counter_idx ON commerce.bookings (counter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_agency_idx  ON commerce.bookings (agency_id, created_at DESC);

ALTER TABLE commerce.tickets
    ADD COLUMN IF NOT EXISTS boarded_at timestamptz;

-- A counter sale made while the terminal was offline is its own channel. It
-- reaches inventory through a different door (quota, not a live hold), and a
-- settlement dispute six months from now will want to know which it was.
ALTER TABLE inventory.seat_holds
    DROP CONSTRAINT IF EXISTS seat_holds_channel_check;
ALTER TABLE inventory.seat_holds
    ADD CONSTRAINT seat_holds_channel_check
    CHECK (channel IN ('WEB','APP','COUNTER','COUNTER_OFFLINE','AGENT','PARTNER','AI','OPERATOR'));

-- Counter quota is a new kind of thing that can happen to a seat, so the
-- append-only event log has to be able to describe it. The CHECK is widened
-- rather than dropped: an event type that nothing writes is still a typo
-- waiting to be silently accepted.
ALTER TABLE inventory.inventory_events
    DROP CONSTRAINT IF EXISTS inventory_events_event_type_check;
ALTER TABLE inventory.inventory_events
    ADD CONSTRAINT inventory_events_event_type_check
    CHECK (event_type IN ('SEAT_HELD','SEAT_RELEASED','SEAT_BOOKED','SEAT_BLOCKED',
                          'SEAT_BOARDED','HOLD_EXPIRED','QUOTA_ALLOCATED','QUOTA_RELEASED'));

-- Accounts the new channels post to.
INSERT INTO finance.ledger_accounts (account_code, name, normal_side) VALUES
    ('5301', 'Cash Variance', 'DR')
ON CONFLICT (account_code) DO NOTHING;

COMMIT;

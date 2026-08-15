-- 002_inventory.sql — the inventory core (Phase 1 workstream P1-F)
--
-- THE MODEL
-- A trip over N stops has N-1 segments. Segment ordinal k spans stop k -> stop k+1.
-- A journey from boarding stop b to dropping stop d occupies segment bits b..d-1:
--
--     want_mask(b,d) = (1 << d) - (1 << b)
--
-- Dhaka(0) -> Cumilla(1)     = 0b001
-- Cumilla(1) -> Chattogram(3)= 0b110     -> 0b001 & 0b110 = 0  => both sellable
-- Dhaka(0) -> Feni(2)        = 0b011     -> 0b011 & 0b110 = 2  => conflict
--
-- Segment resale therefore falls out of bitwise arithmetic rather than
-- application logic, and the whole availability question for one seat is a
-- single integer test that PostgreSQL can evaluate inside a WHERE clause.
--
-- WHY THERE IS NO current_hold_id COLUMN ON trip_seats
-- Two different holds may legitimately own non-overlapping segments of the SAME
-- physical seat at the same time. A single-valued current_hold_id cannot express
-- that and would silently corrupt segment inventory the moment it is used.
-- Hold ownership therefore lives in seat_hold_items, keyed (hold_id, seat_id),
-- carrying the exact mask that hold owns.

SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS inventory;

-- Per-trip summary. Cheap counters for search; never the source of truth.
CREATE TABLE inventory.trip_inventory (
    trip_id       uuid PRIMARY KEY,
    segment_count int    NOT NULL CHECK (segment_count BETWEEN 1 AND 62),
    seat_count    int    NOT NULL,
    opened_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per physical seat per trip. Partitioned by hash(trip_id) from
-- migration #1 so the Phase 3 shard cutover is a routing change, not a rewrite.
-- Every query in this domain carries trip_id; nothing here spans trips.
CREATE TABLE inventory.trip_seats (
    trip_id           uuid   NOT NULL,
    seat_no           text   NOT NULL,
    seat_type         text   NOT NULL DEFAULT 'NORMAL',
    fare_class        text   NOT NULL DEFAULT 'BASE',
    deck              int    NOT NULL DEFAULT 1,
    row_idx           int    NOT NULL DEFAULT 0,
    col_idx           int    NOT NULL DEFAULT 0,
    segment_sold_mask bigint NOT NULL DEFAULT 0,
    segment_hold_mask bigint NOT NULL DEFAULT 0,
    blocked_mask      bigint NOT NULL DEFAULT 0,
    boarded_mask      bigint NOT NULL DEFAULT 0,
    version           bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (trip_id, seat_no)
) PARTITION BY HASH (trip_id);

-- 8 partitions locally; production sizes this to the shard plan.
DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format(
      'CREATE TABLE inventory.trip_seats_p%s PARTITION OF inventory.trip_seats
         FOR VALUES WITH (MODULUS 8, REMAINDER %s)', i, i);
  END LOOP;
END $$;

CREATE TABLE inventory.seat_holds (
    hold_id       uuid PRIMARY KEY,
    trip_id       uuid NOT NULL,
    status        text NOT NULL DEFAULT 'HELD'
                  CHECK (status IN ('HELD','CONFIRMED','RELEASED','EXPIRED')),
    channel       text NOT NULL DEFAULT 'WEB'
                  CHECK (channel IN ('WEB','APP','COUNTER','AGENT','PARTNER','AI','OPERATOR')),
    session_ref   text,
    -- Price is frozen HERE, at hold time, and copied forward to the booking.
    -- Historical bookings are never repriced from current fare rules.
    price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- PostgreSQL is the authority on expiry. Redis only mirrors this as a timer
    -- for latency; if Redis is flushed, the sweeper below still releases on time.
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    settled_at    timestamptz
);

-- The sweeper's working index: only live holds, ordered by deadline.
CREATE INDEX seat_holds_due_idx ON inventory.seat_holds (expires_at)
    WHERE status = 'HELD';
CREATE INDEX seat_holds_trip_idx ON inventory.seat_holds (trip_id);

-- Exact segment ownership per (hold, seat). This is what makes concurrent
-- segment holds on one physical seat representable and releasable.
CREATE TABLE inventory.seat_hold_items (
    hold_id      uuid   NOT NULL REFERENCES inventory.seat_holds(hold_id) ON DELETE CASCADE,
    trip_id      uuid   NOT NULL,
    seat_no      text   NOT NULL,
    segment_mask bigint NOT NULL CHECK (segment_mask <> 0),
    PRIMARY KEY (hold_id, seat_no)
);

CREATE INDEX seat_hold_items_seat_idx ON inventory.seat_hold_items (trip_id, seat_no);

-- Append-only. The oracle that every proof test replays state against.
CREATE TABLE inventory.inventory_events (
    event_id     bigserial PRIMARY KEY,
    trip_id      uuid NOT NULL,
    seat_no      text,
    hold_id      uuid,
    event_type   text NOT NULL
                 CHECK (event_type IN ('SEAT_HELD','SEAT_RELEASED','SEAT_BOOKED','SEAT_BLOCKED','SEAT_BOARDED','HOLD_EXPIRED')),
    segment_mask bigint,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_events_trip_idx ON inventory.inventory_events (trip_id, event_id);

-- Transactional outbox. Written in the SAME transaction as the state change;
-- a relay ships it to Kafka. No service ever dual-writes DB and broker.
CREATE TABLE inventory.outbox (
    outbox_id      bigserial PRIMARY KEY,
    aggregate_id   uuid NOT NULL,
    event_type     text NOT NULL,
    correlation_id uuid,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz
);

CREATE INDEX outbox_unpublished_idx ON inventory.outbox (outbox_id)
    WHERE published_at IS NULL;

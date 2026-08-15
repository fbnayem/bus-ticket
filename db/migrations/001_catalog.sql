-- 001_catalog.sql — identity, operators, geography, fleet, routes, schedule
-- Phase 1 workstreams P1-B / P1-C / P1-D / P1-E.
-- Conventions: UUID PKs, operator_id tenancy column, money in integer poisha (1/100 BDT),
-- no cross-service FKs beyond a domain, every mutation auditable.

SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS catalog;

-- ---------------------------------------------------------------- identity --
CREATE TABLE catalog.users (
    user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone         text UNIQUE,
    email         text UNIQUE,
    display_name  text,
    is_guest      boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.permissions (
    permission text PRIMARY KEY            -- resource.action, e.g. 'booking.cancel'
);

CREATE TABLE catalog.roles (
    role_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_key  text UNIQUE NOT NULL,
    family    text NOT NULL CHECK (family IN ('PLATFORM','OPERATOR','PARTNER','CUSTOMER'))
);

CREATE TABLE catalog.role_permissions (
    role_id    uuid REFERENCES catalog.roles(role_id) ON DELETE CASCADE,
    permission text REFERENCES catalog.permissions(permission) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission)
);

-- --------------------------------------------------------------- operators --
CREATE TABLE catalog.operators (
    operator_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name  text NOT NULL,
    brand       text NOT NULL,
    status      text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','BLOCKED','TERMINATED')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------- geography --
CREATE TABLE catalog.locations (
    location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('COUNTRY','DIVISION','DISTRICT','CITY','AREA','TERMINAL','STOP')),
    name        text NOT NULL,
    parent_id   uuid REFERENCES catalog.locations(location_id),
    lat         numeric(9,6),
    lng         numeric(9,6),
    timezone    text NOT NULL DEFAULT 'Asia/Dhaka'
);

-- Chattogram / Chittagong / CTG must all resolve to ONE canonical location id.
CREATE TABLE catalog.location_aliases (
    alias       text PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES catalog.locations(location_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------- fleet --
CREATE TABLE catalog.bus_types (
    bus_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    is_ac       boolean NOT NULL DEFAULT false,
    class       text    NOT NULL DEFAULT 'ECONOMY'
);

-- Layout versions are IMMUTABLE once a trip references them: a historical ticket
-- must always be interpretable against the layout that was live when it was sold.
CREATE TABLE catalog.seat_layouts (
    layout_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid NOT NULL REFERENCES catalog.operators(operator_id),
    name        text NOT NULL,
    version     int  NOT NULL DEFAULT 1,
    decks       int  NOT NULL DEFAULT 1,
    frozen      boolean NOT NULL DEFAULT false,
    UNIQUE (operator_id, name, version)
);

CREATE TABLE catalog.seat_layout_items (
    layout_id  uuid NOT NULL REFERENCES catalog.seat_layouts(layout_id) ON DELETE CASCADE,
    seat_no    text NOT NULL,
    deck       int  NOT NULL DEFAULT 1,
    row_idx    int  NOT NULL,
    col_idx    int  NOT NULL,
    seat_type  text NOT NULL DEFAULT 'NORMAL'
               CHECK (seat_type IN ('NORMAL','BUSINESS','SLEEPER','PREMIUM','FEMALE_RESERVED','ACCESSIBLE','BLOCKED','CREW')),
    fare_class text NOT NULL DEFAULT 'BASE',
    PRIMARY KEY (layout_id, seat_no)
);

CREATE TABLE catalog.buses (
    bus_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id  uuid NOT NULL REFERENCES catalog.operators(operator_id),
    registration text NOT NULL,
    bus_type_id  uuid NOT NULL REFERENCES catalog.bus_types(bus_type_id),
    layout_id    uuid NOT NULL REFERENCES catalog.seat_layouts(layout_id),
    status       text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','MAINTENANCE','OUT_OF_SERVICE','RESERVED','DECOMMISSIONED')),
    UNIQUE (operator_id, registration)
);

-- ------------------------------------------------------------------ routes --
CREATE TABLE catalog.routes (
    route_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid NOT NULL REFERENCES catalog.operators(operator_id),
    name        text NOT NULL
);

-- stop_seq is 0-based and dense. A route with N stops has N-1 segments,
-- and segment ordinal k spans stop k -> stop k+1. This is the whole basis
-- of the bitmask inventory model: mask(board,drop) = (1<<drop) - (1<<board).
CREATE TABLE catalog.route_stops (
    route_id    uuid NOT NULL REFERENCES catalog.routes(route_id) ON DELETE CASCADE,
    stop_seq    int  NOT NULL,
    location_id uuid NOT NULL REFERENCES catalog.locations(location_id),
    is_boarding boolean NOT NULL DEFAULT true,
    is_dropping boolean NOT NULL DEFAULT true,
    PRIMARY KEY (route_id, stop_seq)
);

-- Fares are versioned-immutable. Frozen price snapshots reference them, so a
-- mutation in place would corrupt the provenance of every historical booking.
CREATE TABLE catalog.route_fares (
    fare_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id      uuid NOT NULL REFERENCES catalog.routes(route_id) ON DELETE CASCADE,
    from_stop_seq int  NOT NULL,
    to_stop_seq   int  NOT NULL,
    fare_class    text NOT NULL DEFAULT 'BASE',
    amount_poisha bigint NOT NULL CHECK (amount_poisha >= 0),
    version       int  NOT NULL DEFAULT 1,
    CHECK (to_stop_seq > from_stop_seq)
);

-- ---------------------------------------------------------------- schedule --
CREATE TABLE catalog.schedules (
    schedule_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id  uuid NOT NULL REFERENCES catalog.operators(operator_id),
    route_id     uuid NOT NULL REFERENCES catalog.routes(route_id),
    bus_id       uuid NOT NULL REFERENCES catalog.buses(bus_id),
    depart_local time NOT NULL,
    days_mask    int  NOT NULL DEFAULT 127,   -- bit 0 = Monday
    valid_from   date NOT NULL,
    valid_to     date
);

CREATE TABLE catalog.schedule_exceptions (
    schedule_id uuid NOT NULL REFERENCES catalog.schedules(schedule_id) ON DELETE CASCADE,
    service_date date NOT NULL,
    action      text NOT NULL DEFAULT 'SKIP' CHECK (action IN ('SKIP','OVERRIDE')),
    PRIMARY KEY (schedule_id, service_date)
);

-- A trip SNAPSHOTS its segment count and layout version at generation time and
-- is immutable thereafter. trip_id is minted only here — a single mint point is
-- what makes trip_id a viable shard key later.
CREATE TABLE catalog.trips (
    trip_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id   uuid NOT NULL REFERENCES catalog.operators(operator_id),
    route_id      uuid NOT NULL REFERENCES catalog.routes(route_id),
    bus_id        uuid NOT NULL REFERENCES catalog.buses(bus_id),
    schedule_id   uuid REFERENCES catalog.schedules(schedule_id),
    service_date  date NOT NULL,
    depart_at     timestamptz NOT NULL,
    segment_count int  NOT NULL CHECK (segment_count BETWEEN 1 AND 62),
    layout_id     uuid NOT NULL REFERENCES catalog.seat_layouts(layout_id),
    status        text NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (status IN ('DRAFT','SCHEDULED','OPEN','BOARDING','DEPARTED','IN_PROGRESS','ARRIVED','COMPLETED','CANCELLED')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- idempotent trip generation: re-running the generator creates zero duplicates
    UNIQUE (schedule_id, service_date)
);

CREATE INDEX ON catalog.trips (route_id, service_date);
CREATE INDEX ON catalog.trips (operator_id, service_date);

-- 010_identity_search.sql — passenger authentication (P1-C) and the search
-- read model (P1-G).
--
-- These two arrive together because they are the last places where the public
-- website was still doing something dishonest: pretending to know who you are,
-- and answering searches straight out of the transactional database.

SET client_min_messages = warning;

-- Trigram matching for the locations index below: "chittagong" has to find
-- "Chattogram" without a table scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Notifications need somewhere to send an operator's or an agency's mail.
ALTER TABLE catalog.operators ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE catalog.operators ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE agent.agencies   ADD COLUMN IF NOT EXISTS contact_email text;

UPDATE catalog.operators SET
    contact_phone = COALESCE(contact_phone, '+8801700' || lpad((abs(hashtext(brand)) % 1000000)::text, 6, '0')),
    contact_email = COALESCE(contact_email, lower(regexp_replace(brand, '[^a-zA-Z]', '', 'g')) || '@operator.test');

UPDATE agent.agencies SET
    contact_email = COALESCE(contact_email, lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) || '@agency.test');

-- =========================================================================== --
--                       PASSENGER IDENTITY (P1-C)                             --
-- =========================================================================== --
CREATE SCHEMA IF NOT EXISTS identity;

-- Passwords are optional. Most passengers on this market sign in with a phone
-- number and a one-time code and never set one.
CREATE TABLE identity.credentials (
    user_id       uuid PRIMARY KEY REFERENCES catalog.users(user_id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    password_salt text NOT NULL,
    iterations    int  NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The code itself is never stored, only its hash — an OTP table is a phishing
-- target and a support-desk temptation in equal measure.
CREATE TABLE identity.otp_challenges (
    challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone        text NOT NULL,
    code_hash    text NOT NULL,
    purpose      text NOT NULL DEFAULT 'LOGIN' CHECK (purpose IN ('LOGIN','VERIFY','RESET')),
    attempts     int  NOT NULL DEFAULT 0,
    max_attempts int  NOT NULL DEFAULT 5,
    ip           inet,
    consumed_at  timestamptz,
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The rate limiter's index. Redis holds the fast counter; this is the authority,
-- exactly as PostgreSQL is the authority on hold expiry.
CREATE INDEX otp_challenges_phone_idx ON identity.otp_challenges (phone, created_at DESC);
CREATE INDEX otp_challenges_ip_idx    ON identity.otp_challenges (ip, created_at DESC);

CREATE TABLE identity.sessions (
    session_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES catalog.users(user_id) ON DELETE CASCADE,
    -- Only the SHA-256 of the bearer token is kept. A dump of this table does
    -- not let anyone sign in as anybody.
    token_hash   text NOT NULL UNIQUE,
    device       text,
    ip           inet,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);

CREATE INDEX sessions_user_idx ON identity.sessions (user_id, created_at DESC);

-- Rotating refresh tokens with reuse detection. A refresh token is single-use:
-- presenting one that has already been used means the token was stolen (or
-- cloned), so the entire family is revoked rather than just that token.
CREATE TABLE identity.refresh_tokens (
    token_hash text PRIMARY KEY,
    family_id  uuid NOT NULL,
    user_id    uuid NOT NULL REFERENCES catalog.users(user_id) ON DELETE CASCADE,
    session_id uuid REFERENCES identity.sessions(session_id) ON DELETE CASCADE,
    issued_at  timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    revoked_at timestamptz,
    revoke_reason text
);

CREATE INDEX refresh_family_idx ON identity.refresh_tokens (family_id);

-- A guest checkout that later becomes an account. The link is recorded rather
-- than the guest row being edited away, so support can still explain what
-- happened to a booking made before anyone signed in.
CREATE TABLE identity.guest_promotions (
    guest_user_id uuid PRIMARY KEY REFERENCES catalog.users(user_id),
    user_id       uuid NOT NULL REFERENCES catalog.users(user_id),
    bookings_moved int NOT NULL DEFAULT 0,
    promoted_at   timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================== --
--                        SEARCH READ MODEL (P1-G)                             --
-- =========================================================================== --
-- The plan's target is trips -> Kafka -> OpenSearch -> Redis. OpenSearch is not
-- running here, so the same denormalised document lives in a projection table
-- fed by the same event stream. The property that matters is enforced either
-- way: search reads THIS and nothing else. No search query touches
-- catalog.trips, inventory.trip_seats or commerce.bookings.
--
-- One row per sellable leg — a 4-stop trip produces 6 — so a search is an index
-- lookup on (origin, destination, date) rather than a join across five tables.
CREATE SCHEMA IF NOT EXISTS search;

CREATE TABLE search.trip_legs (
    trip_id        uuid NOT NULL,
    board_seq      int  NOT NULL,
    drop_seq       int  NOT NULL,
    origin_id      uuid NOT NULL,
    dest_id        uuid NOT NULL,
    origin_name    text NOT NULL,
    dest_name      text NOT NULL,
    service_date   date NOT NULL,
    depart_at      timestamptz NOT NULL,
    arrive_at      timestamptz NOT NULL,
    duration_min   int  NOT NULL,
    operator_id    uuid NOT NULL,
    operator_brand text NOT NULL,
    route_id       uuid NOT NULL,
    route_name     text NOT NULL,
    bus_type       text NOT NULL,
    class          text NOT NULL DEFAULT 'ECONOMY',
    registration   text NOT NULL DEFAULT '',
    is_ac          boolean NOT NULL DEFAULT false,
    amenities      text[] NOT NULL DEFAULT '{}',
    fare_poisha    bigint NOT NULL,
    seats_total    int NOT NULL,
    -- Approximate on purpose. Search may be stale; the seat map and the hold
    -- always go to inventory-service, which may not be.
    seats_free     int NOT NULL,
    status         text NOT NULL,
    indexed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, board_seq, drop_seq)
);

CREATE INDEX trip_legs_query_idx
    ON search.trip_legs (origin_id, dest_id, service_date, depart_at)
    WHERE status IN ('SCHEDULED','OPEN','BOARDING');

CREATE INDEX trip_legs_trip_idx ON search.trip_legs (trip_id);

-- The locations index: canonical name plus every alias anyone types, so
-- "CTG", "Chittagong" and "চট্টগ্রাম" all resolve here rather than in a LIKE
-- scan of the transactional table.
CREATE TABLE search.location_index (
    location_id uuid PRIMARY KEY,
    name        text NOT NULL,
    kind        text NOT NULL,
    aliases     text[] NOT NULL DEFAULT '{}',
    search_blob text NOT NULL,
    trips_from  int  NOT NULL DEFAULT 0,
    indexed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX location_index_blob_idx ON search.location_index USING gin (search_blob gin_trgm_ops);

-- Bookkeeping for the indexer, so the health page can show index lag honestly.
CREATE TABLE search.index_state (
    id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_full_at  timestamptz,
    last_event_at timestamptz,
    legs_indexed  bigint NOT NULL DEFAULT 0
);
INSERT INTO search.index_state (id) VALUES (1);

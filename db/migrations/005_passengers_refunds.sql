-- 005_passengers_refunds.sql — passenger detail, contact, cancellation and refund.
-- Completes the data the passenger web app needs end to end.

SET client_min_messages = warning;

-- One row per travelling passenger, tied to the seat they occupy.
CREATE TABLE commerce.booking_passengers (
    booking_id  uuid NOT NULL REFERENCES commerce.bookings(booking_id) ON DELETE CASCADE,
    seat_no     text NOT NULL,
    full_name   text NOT NULL,
    gender      text CHECK (gender IN ('M','F','X')),
    age         int  CHECK (age BETWEEN 0 AND 120),
    id_type     text,
    id_number   text,           -- PII: encrypted at rest in production
    PRIMARY KEY (booking_id, seat_no)
);

-- Contact for the booking. Kept separate from passengers because the person who
-- books is frequently not a person who travels.
CREATE TABLE commerce.booking_contacts (
    booking_id uuid PRIMARY KEY REFERENCES commerce.bookings(booking_id) ON DELETE CASCADE,
    phone      text NOT NULL,
    email      text,
    notify_sms   boolean NOT NULL DEFAULT true,
    notify_email boolean NOT NULL DEFAULT true
);

-- Cancellation policy tiers, resolved most-specific-first:
-- operator > route > schedule > bus class > channel. NULL means "any".
CREATE TABLE commerce.cancellation_policies (
    policy_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id   uuid,
    route_id      uuid,
    channel       text,
    min_hours     int NOT NULL,          -- inclusive lower bound before departure
    refund_pct    int NOT NULL CHECK (refund_pct BETWEEN 0 AND 100),
    priority      int NOT NULL DEFAULT 0
);

-- The platform default tiers from the plan's entry criteria.
INSERT INTO commerce.cancellation_policies (min_hours, refund_pct, priority) VALUES
    (24, 90, 0),
    (12, 70, 0),
    (6,  50, 0),
    (0,  0,  0);

CREATE TABLE commerce.cancellations (
    cancellation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      uuid NOT NULL REFERENCES commerce.bookings(booking_id),
    requested_by    text NOT NULL DEFAULT 'PASSENGER',
    hours_before    numeric(8,2) NOT NULL,
    refund_pct      int    NOT NULL,
    refund_poisha   bigint NOT NULL,
    reason          text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commerce.refunds (
    refund_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cancellation_id uuid NOT NULL REFERENCES commerce.cancellations(cancellation_id),
    booking_id      uuid NOT NULL REFERENCES commerce.bookings(booking_id),
    payment_id      uuid REFERENCES commerce.payments(payment_id),
    amount_poisha   bigint NOT NULL CHECK (amount_poisha >= 0),
    status          text NOT NULL DEFAULT 'REQUESTED'
                    CHECK (status IN ('REQUESTED','APPROVED','PROCESSING','SUCCESS','FAILED','REJECTED')),
    journal_id      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refunds_booking_idx ON commerce.refunds (booking_id);

-- Saved passengers for the account area.
CREATE TABLE catalog.saved_passengers (
    saved_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   uuid NOT NULL REFERENCES catalog.users(user_id) ON DELETE CASCADE,
    full_name text NOT NULL,
    gender    text,
    age       int,
    id_type   text,
    id_number text
);

-- Promotional offers surfaced on the Offers page and validated at checkout.
CREATE TABLE commerce.coupons (
    code            text PRIMARY KEY,
    title           text NOT NULL,
    description     text,
    discount_pct    int    CHECK (discount_pct BETWEEN 0 AND 100),
    discount_poisha bigint CHECK (discount_poisha >= 0),
    max_discount_poisha bigint,
    min_amount_poisha   bigint NOT NULL DEFAULT 0,
    route_id        uuid,
    operator_id     uuid,
    starts_at       timestamptz NOT NULL DEFAULT now(),
    ends_at         timestamptz,
    usage_limit     int,
    used_count      int NOT NULL DEFAULT 0,
    per_user_limit  int NOT NULL DEFAULT 1,
    active          boolean NOT NULL DEFAULT true,
    CHECK (discount_pct IS NOT NULL OR discount_poisha IS NOT NULL)
);

INSERT INTO commerce.coupons
    (code, title, description, discount_pct, discount_poisha, max_discount_poisha, min_amount_poisha, ends_at) VALUES
    ('EIDSAFAR', 'Eid Safar — 15% off', 'Save on every AC Business seat this Eid season.',
      15, NULL, 20000, 50000, now() + interval '60 days'),
    ('FIRSTRIDE', 'First ride — ৳100 off', 'For passengers booking with us for the first time.',
      NULL, 10000, NULL, 40000, now() + interval '180 days'),
    ('CTGWEEKEND', 'Chattogram weekends — 10% off', 'Weekend travel on the Chattogram corridor.',
      10, NULL, 15000, 0, now() + interval '90 days');

-- A demo account so the Account page has real history to render.
INSERT INTO catalog.users (user_id, phone, email, display_name) VALUES
    ('99999999-9999-9999-9999-999999999999', '+8801700000000', 'demo@busticket.test', 'Demo Passenger')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.saved_passengers (user_id, full_name, gender, age, id_type, id_number) VALUES
    ('99999999-9999-9999-9999-999999999999', 'Rahim Uddin',   'M', 34, 'NID', '1990123456789'),
    ('99999999-9999-9999-9999-999999999999', 'Fatema Begum',  'F', 29, 'NID', '1995987654321');

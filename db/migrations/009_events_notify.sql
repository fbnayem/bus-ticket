-- 009_events_notify.sql — the event backbone (P1-A) and the notification
-- platform (P2-K).
--
-- WHY THIS SHAPE
-- The plan specifies Kafka with a schema registry, DLQs per consumer group and
-- idempotent consumers. Kafka is not running here, so the backbone is built on
-- PostgreSQL with the SAME contract: an append-only log of enveloped events,
-- consumer groups that advance an offset, a schema registry that rejects
-- malformed events at publish time, and a dead-letter table per consumer.
--
-- That is a deliberate substitution, not a shortcut. Every producer still writes
-- to its own transactional outbox in the same transaction as the state change,
-- and the relay is the only thing that turns an outbox row into a published
-- event. Swapping the relay's sink from events.event_log to a Kafka producer is
-- a change in one file; nothing that produces or consumes events has to move.

SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS events;

-- ------------------------------------------------------------ the event log --
-- The standard envelope from the plan, made into columns so it can be indexed
-- and queried rather than living in prose:
--   event_id, event_type, version, timestamp, producer, correlation_id, payload
CREATE TABLE events.event_log (
    offset_id      bigserial PRIMARY KEY,
    -- UNIQUE is what makes relaying idempotent: replaying an outbox row that was
    -- already shipped inserts nothing. The relay never has to remember anything.
    event_id       uuid NOT NULL UNIQUE,
    topic          text NOT NULL,
    event_type     text NOT NULL,
    version        int  NOT NULL DEFAULT 1,
    producer       text NOT NULL,
    correlation_id uuid,
    aggregate_id   uuid,
    payload        jsonb NOT NULL,
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_log_topic_idx ON events.event_log (topic, offset_id);
CREATE INDEX event_log_type_idx  ON events.event_log (event_type, offset_id);

-- ---------------------------------------------------------- schema registry --
-- A topic declares which event types it carries and which payload fields are
-- mandatory. Publishing something that does not validate is an error at publish
-- time, which is the point: a consumer should never be the first to discover
-- that a producer changed shape.
CREATE TABLE events.topic_schemas (
    topic           text NOT NULL,
    event_type      text NOT NULL,
    version         int  NOT NULL DEFAULT 1,
    required_fields text[] NOT NULL DEFAULT '{}',
    description     text,
    PRIMARY KEY (topic, event_type, version)
);

-- ---------------------------------------------------------- consumer groups --
CREATE TABLE events.consumers (
    consumer     text PRIMARY KEY,
    topics       text[] NOT NULL,
    position     bigint NOT NULL DEFAULT 0,
    lag_alert_at int    NOT NULL DEFAULT 1000,
    delivered    bigint NOT NULL DEFAULT 0,
    failed       bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per event a consumer could not process after its retries. The offset
-- still advances — a poisoned event must never wedge a consumer group — but the
-- event is kept here, replayable, and counted on the health page.
CREATE TABLE events.dead_letters (
    dl_id       bigserial PRIMARY KEY,
    consumer    text NOT NULL REFERENCES events.consumers(consumer),
    offset_id   bigint NOT NULL,
    event_id    uuid   NOT NULL,
    event_type  text   NOT NULL,
    attempts    int    NOT NULL,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (consumer, event_id)
);

-- ------------------------------------------------------------ more outboxes --
-- inventory.outbox already exists. Every other producing schema gets one of its
-- own, in its own schema, so a producer writes its event in the same local
-- transaction as its state change and never dual-writes to a broker.
ALTER TABLE inventory.outbox
    ADD COLUMN IF NOT EXISTS event_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE commerce.outbox (
    outbox_id      bigserial PRIMARY KEY,
    event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    aggregate_id   uuid NOT NULL,
    event_type     text NOT NULL,
    correlation_id uuid,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz
);
CREATE INDEX commerce_outbox_unpublished_idx ON commerce.outbox (outbox_id)
    WHERE published_at IS NULL;

CREATE TABLE ops.outbox (
    outbox_id      bigserial PRIMARY KEY,
    event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    aggregate_id   uuid NOT NULL,
    event_type     text NOT NULL,
    correlation_id uuid,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz
);
CREATE INDEX ops_outbox_unpublished_idx ON ops.outbox (outbox_id)
    WHERE published_at IS NULL;

CREATE TABLE agent.outbox (
    outbox_id      bigserial PRIMARY KEY,
    event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    aggregate_id   uuid NOT NULL,
    event_type     text NOT NULL,
    correlation_id uuid,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz
);
CREATE INDEX agent_outbox_unpublished_idx ON agent.outbox (outbox_id)
    WHERE published_at IS NULL;

-- The relay drains each of these in turn. Adding a producer means adding a row.
CREATE TABLE events.outbox_sources (
    source_table text PRIMARY KEY,
    producer     text NOT NULL,
    enabled      boolean NOT NULL DEFAULT true
);

-- An event whose type is not registered, or whose payload is missing a field
-- the registry says is mandatory, is never published. It is parked here — where
-- the health page counts it — instead of reaching consumers. A producer that
-- silently changed shape must not be able to poison everything downstream.
CREATE TABLE events.rejected_events (
    reject_id    bigserial PRIMARY KEY,
    source_table text NOT NULL,
    event_id     uuid NOT NULL UNIQUE,
    event_type   text NOT NULL,
    reason       text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The registry check, in SQL, so the relay can validate and publish in one
-- statement rather than reading events out and putting them back.
CREATE OR REPLACE FUNCTION events.schema_reject_reason(p_type text, p_payload jsonb)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM events.topic_schemas s WHERE s.event_type = p_type)
        THEN 'unregistered event type'
      WHEN EXISTS (SELECT 1 FROM events.topic_schemas s, unnest(s.required_fields) f
                    WHERE s.event_type = p_type AND NOT (p_payload ? f))
        THEN 'missing required field: ' || (
             SELECT string_agg(f, ', ') FROM events.topic_schemas s, unnest(s.required_fields) f
              WHERE s.event_type = p_type AND NOT (p_payload ? f))
      ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION events.topic_for(p_type text)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT topic FROM events.topic_schemas WHERE event_type = p_type LIMIT 1;
$$;

INSERT INTO events.outbox_sources (source_table, producer) VALUES
    ('inventory.outbox', 'inventory-service'),
    ('commerce.outbox',  'booking-service'),
    ('ops.outbox',       'tracking-service'),
    ('agent.outbox',     'agent-service');

-- ------------------------------------------------------------------- topics --
INSERT INTO events.topic_schemas (topic, event_type, required_fields, description) VALUES
    ('seat',         'seat.held',            '{trip_id,seats}',            'segments moved to HELD'),
    ('seat',         'seat.released',        '{trip_id}',                  'hold released or expired'),
    ('seat',         'seat.booked',          '{trip_id}',                  'hold confirmed to SOLD'),
    ('seat',         'seat.blocked',         '{trip_id,seats}',            'counter quota reserved'),
    ('seat',         'seat.quota_sold',      '{trip_id,seats}',            'offline quota sale replayed'),
    ('booking',      'booking.created',      '{pnr}',                      'booking awaiting payment'),
    ('booking',      'booking.confirmed',    '{pnr,total_poisha}',         'paid, ticketed'),
    ('booking',      'booking.cancelled',    '{pnr}',                      'cancelled by passenger or operator'),
    ('booking',      'booking.rescheduled',  '{pnr}',                      'moved to another trip'),
    ('payment',      'payment.success',      '{pnr,amount_poisha}',        'verified provider payment'),
    ('payment',      'payment.failed',       '{pnr}',                      'provider declined'),
    ('refund',       'refund.completed',     '{pnr,amount_poisha}',        'refund settled'),
    ('ticket',       'ticket.issued',        '{pnr,seats}',                'tickets and QR issued'),
    ('ticket',       'ticket.boarded',       '{pnr,seat_no}',              'passenger scanned aboard'),
    ('trip',         'trip.created',         '{trip_id}',                  'trip materialised by the generator'),
    ('trip',         'trip.departed',        '{trip_id}',                  'crew marked departed'),
    ('trip',         'trip.arrived',         '{trip_id}',                  'crew marked arrived'),
    ('trip',         'trip.cancelled',       '{trip_id}',                  'trip cancelled'),
    ('trip',         'trip.delayed',         '{trip_id,minutes}',          'departure running late'),
    ('bus',          'bus.location.updated', '{trip_id}',                  'GPS fix from any source'),
    ('bus',          'bus.approaching',      '{trip_id,stop_name}',        'bus near a boarding point'),
    ('incident',     'incident.reported',    '{trip_id,kind}',             'crew reported an incident'),
    ('wallet',       'wallet.low',           '{agency_id}',                'agent spending power below threshold'),
    ('wallet',       'wallet.recharged',     '{agency_id,amount_poisha}',  'recharge approved'),
    ('settlement',   'settlement.approved',  '{settlement_id}',            'operator settlement approved'),
    ('settlement',   'settlement.paid',      '{settlement_id}',            'operator settlement paid'),
    ('counter',      'counter.shift.closed', '{shift_id}',                 'drawer counted and closed'),
    ('promotion',    'promotion.redeemed',   '{code}',                     'coupon or campaign redeemed');

INSERT INTO events.consumers (consumer, topics) VALUES
    ('notification-dispatcher', '{booking,payment,refund,ticket,trip,bus,incident,wallet,settlement}'),
    ('search-indexer',          '{seat,trip}'),
    ('analytics-ingest',        '{seat,booking,payment,refund,ticket,trip,bus,incident,wallet,settlement,counter,promotion}'),
    ('ops-alerting',            '{bus,trip,incident}'),
    ('partner-webhooks',        '{booking,payment,refund,trip}');

-- =========================================================================== --
--                       NOTIFICATION PLATFORM (P2-K)                          --
-- =========================================================================== --

CREATE SCHEMA IF NOT EXISTS notify;

-- Two Bangladeshi SMS aggregators, because one is a single point of failure for
-- every OTP and every booking confirmation on the platform. priority 1 is tried
-- first; the dispatcher falls through to 2 when 1 is unhealthy or refuses.
CREATE TABLE notify.providers (
    provider       text PRIMARY KEY,
    channel        text NOT NULL CHECK (channel IN ('SMS','EMAIL','PUSH')),
    priority       int  NOT NULL,
    cost_poisha    bigint NOT NULL DEFAULT 0,
    enabled        boolean NOT NULL DEFAULT true,
    -- Set from the admin console to take an aggregator down without removing it
    -- from the routing table. Failover is only believable if you can watch the
    -- primary fail and the secondary carry the message.
    simulate_failure boolean NOT NULL DEFAULT false,
    failure_streak int  NOT NULL DEFAULT 0,
    -- After a run of failures the dispatcher stops choosing this provider for a
    -- few minutes instead of burning every message on it.
    cooldown_until timestamptz,
    last_error     text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO notify.providers (provider, channel, priority, cost_poisha) VALUES
    ('SSLWIRELESS',   'SMS',   1, 45),   -- ~৳0.45 per SMS
    ('BULKSMSBD',     'SMS',   2, 52),
    ('SES_RELAY',     'EMAIL', 1, 2),
    ('FCM',           'PUSH',  1, 0);

-- Every template exists in Bangla and English. The passenger's preference
-- decides which is rendered; there is no "default to English and hope".
CREATE TABLE notify.templates (
    template_key text NOT NULL,
    lang         text NOT NULL CHECK (lang IN ('bn','en')),
    channel      text NOT NULL CHECK (channel IN ('SMS','EMAIL','PUSH')),
    subject      text,
    body         text NOT NULL,
    PRIMARY KEY (template_key, lang, channel)
);

-- Per-event routing: which template, which channels in which order, and which
-- class the message belongs to. The class is what the budget breaker acts on —
-- a runaway marketing loop must never be able to stop a booking confirmation.
CREATE TABLE notify.routes (
    event_type   text PRIMARY KEY,
    template_key text NOT NULL,
    channels     text[] NOT NULL,
    event_class  text NOT NULL CHECK (event_class IN ('TRANSACTIONAL','OPERATIONAL','MARKETING')),
    active       boolean NOT NULL DEFAULT true
);

CREATE TABLE notify.notifications (
    notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The consumer is idempotent because of this pair, not because it checks
    -- first: redelivering an event cannot produce a second SMS.
    event_id        uuid,
    template_key    text NOT NULL,
    event_type      text NOT NULL,
    event_class     text NOT NULL,
    lang            text NOT NULL,
    to_phone        text,
    to_email        text,
    to_push         text,
    booking_id      uuid,
    user_id         uuid,
    operator_id     uuid,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED','SENT','FAILED','SUPPRESSED')),
    suppress_reason text,
    -- template + recipient. One trip cancellation reaches forty passengers, so
    -- the recipient has to be part of what makes a delivery unique.
    dedupe_key      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    UNIQUE (event_id, dedupe_key)
);

CREATE INDEX notifications_recent_idx ON notify.notifications (created_at DESC);
CREATE INDEX notifications_booking_idx ON notify.notifications (booking_id);

-- One row per delivery attempt, per channel, per provider — including the
-- failures. Cost lives here because a per-message cost is the only honest way
-- to answer "what did notifications cost last month?".
CREATE TABLE notify.attempts (
    attempt_id      bigserial PRIMARY KEY,
    notification_id uuid NOT NULL REFERENCES notify.notifications(notification_id) ON DELETE CASCADE,
    channel         text NOT NULL,
    provider        text NOT NULL,
    status          text NOT NULL CHECK (status IN ('SENT','FAILED')),
    error           text,
    cost_poisha     bigint NOT NULL DEFAULT 0,
    rendered        text,
    attempted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempts_notification_idx ON notify.attempts (notification_id);
CREATE INDEX attempts_recent_idx ON notify.attempts (attempted_at DESC);

-- The circuit breaker. spent_poisha is maintained by the dispatcher inside the
-- same transaction that records the attempt, so it cannot drift from attempts.
CREATE TABLE notify.budgets (
    period       text PRIMARY KEY,          -- 'YYYY-MM'
    cap_poisha   bigint NOT NULL,
    spent_poisha bigint NOT NULL DEFAULT 0,
    tripped_at   timestamptz
);

-- Per-class caps applied per rolling hour. A stuck retry loop hits this long
-- before it hits the monthly budget.
CREATE TABLE notify.rate_caps (
    event_class  text PRIMARY KEY,
    per_hour     int NOT NULL
);

INSERT INTO notify.rate_caps (event_class, per_hour) VALUES
    ('TRANSACTIONAL', 100000),   -- effectively uncapped: never block a ticket
    ('OPERATIONAL',   20000),
    ('MARKETING',     2000);

CREATE TABLE notify.preferences (
    user_key text PRIMARY KEY,               -- phone number, or user id
    lang     text NOT NULL DEFAULT 'bn' CHECK (lang IN ('bn','en')),
    sms      boolean NOT NULL DEFAULT true,
    email    boolean NOT NULL DEFAULT true,
    push     boolean NOT NULL DEFAULT true,
    marketing boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Where a "sent" message actually lands in this build. A real deployment swaps
-- the adapter; the delivery log, the cost accounting and the failover logic do
-- not change, which is the part worth getting right now.
CREATE TABLE notify.outbound_sink (
    sink_id    bigserial PRIMARY KEY,
    channel    text NOT NULL,
    provider   text NOT NULL,
    recipient  text NOT NULL,
    subject    text,
    body       text NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbound_sink_recent_idx ON notify.outbound_sink (sent_at DESC);

-- ---------------------------------------------------------------- routing ----
INSERT INTO notify.routes (event_type, template_key, channels, event_class) VALUES
    ('booking.confirmed',   'booking_confirmed', '{SMS,EMAIL,PUSH}', 'TRANSACTIONAL'),
    ('ticket.issued',       'ticket_issued',     '{EMAIL}',          'TRANSACTIONAL'),
    ('booking.cancelled',   'booking_cancelled', '{SMS,EMAIL}',      'TRANSACTIONAL'),
    ('refund.completed',    'refund_completed',  '{SMS,EMAIL}',      'TRANSACTIONAL'),
    ('booking.rescheduled', 'booking_rescheduled','{SMS,EMAIL}',     'TRANSACTIONAL'),
    ('payment.failed',      'payment_failed',    '{SMS}',            'TRANSACTIONAL'),
    ('trip.cancelled',      'trip_cancelled',    '{SMS,PUSH}',       'OPERATIONAL'),
    ('bus.approaching',     'bus_approaching',   '{PUSH,SMS}',       'OPERATIONAL'),
    ('trip.delayed',        'trip_delayed',      '{SMS,PUSH}',       'OPERATIONAL'),
    ('incident.reported',   'incident_reported', '{SMS}',            'OPERATIONAL'),
    ('wallet.low',          'wallet_low',        '{SMS,EMAIL}',      'OPERATIONAL'),
    ('settlement.paid',     'settlement_paid',   '{EMAIL,SMS}',      'OPERATIONAL'),
    ('auth.otp',            'auth_otp',          '{SMS}',            'TRANSACTIONAL'),
    ('promo.campaign',      'promo_campaign',    '{SMS}',            'MARKETING');

-- ------------------------------------------------------------- templates ----
-- {{placeholders}} are filled from the notification payload. Bangla first,
-- because most passengers on this corridor read Bangla first.
INSERT INTO notify.templates (template_key, lang, channel, subject, body) VALUES
 ('booking_confirmed','bn','SMS',NULL,'যাত্রা: আপনার টিকিট নিশ্চিত হয়েছে। PNR {{pnr}}, {{route}}, {{departs}}, আসন {{seats}}। ভাড়া ৳{{total}}।'),
 ('booking_confirmed','en','SMS',NULL,'Jatra: booking confirmed. PNR {{pnr}}, {{route}}, {{departs}}, seat(s) {{seats}}. Total BDT {{total}}.'),
 ('booking_confirmed','bn','EMAIL','টিকিট নিশ্চিত — PNR {{pnr}}','প্রিয় যাত্রী,\n\nআপনার টিকিট নিশ্চিত হয়েছে।\nPNR: {{pnr}}\nযাত্রাপথ: {{route}}\nছাড়বে: {{departs}}\nআসন: {{seats}}\nমোট: ৳{{total}}\n\nবাসে ওঠার সময় QR কোডটি দেখান।'),
 ('booking_confirmed','en','EMAIL','Ticket confirmed — PNR {{pnr}}','Dear passenger,\n\nYour booking is confirmed.\nPNR: {{pnr}}\nRoute: {{route}}\nDeparts: {{departs}}\nSeats: {{seats}}\nTotal: BDT {{total}}\n\nShow the QR code when boarding.'),
 ('booking_confirmed','bn','PUSH','টিকিট নিশ্চিত','PNR {{pnr}} — {{route}}, {{departs}}'),
 ('booking_confirmed','en','PUSH','Ticket confirmed','PNR {{pnr}} — {{route}}, {{departs}}'),

 ('ticket_issued','bn','EMAIL','আপনার ই-টিকিট — {{pnr}}','টিকিট সংযুক্ত। আসন {{seats}}। QR কোড বাসে দেখাতে হবে।'),
 ('ticket_issued','en','EMAIL','Your e-ticket — {{pnr}}','Your ticket is attached. Seat(s) {{seats}}. Show the QR when boarding.'),

 ('booking_cancelled','bn','SMS',NULL,'যাত্রা: PNR {{pnr}} বাতিল হয়েছে। ফেরতযোগ্য ৳{{refund}} ৩–৫ কর্মদিবসে জমা হবে।'),
 ('booking_cancelled','en','SMS',NULL,'Jatra: PNR {{pnr}} cancelled. BDT {{refund}} will be refunded in 3-5 working days.'),
 ('booking_cancelled','bn','EMAIL','বাতিল নিশ্চিত — {{pnr}}','PNR {{pnr}} বাতিল হয়েছে। ফেরত: ৳{{refund}}।'),
 ('booking_cancelled','en','EMAIL','Cancellation confirmed — {{pnr}}','PNR {{pnr}} is cancelled. Refund: BDT {{refund}}.'),

 ('refund_completed','bn','SMS',NULL,'যাত্রা: ৳{{refund}} ফেরত পাঠানো হয়েছে ({{pnr}})।'),
 ('refund_completed','en','SMS',NULL,'Jatra: BDT {{refund}} refunded for {{pnr}}.'),
 ('refund_completed','bn','EMAIL','ফেরত সম্পন্ন — {{pnr}}','৳{{refund}} ফেরত দেওয়া হয়েছে।'),
 ('refund_completed','en','EMAIL','Refund completed — {{pnr}}','BDT {{refund}} has been refunded.'),

 ('booking_rescheduled','bn','SMS',NULL,'যাত্রা: {{pnr}} পরিবর্তিত হয়েছে — নতুন যাত্রা {{departs}}, আসন {{seats}}।'),
 ('booking_rescheduled','en','SMS',NULL,'Jatra: {{pnr}} moved — new departure {{departs}}, seat(s) {{seats}}.'),
 ('booking_rescheduled','bn','EMAIL','যাত্রা পরিবর্তন — {{pnr}}','নতুন যাত্রা: {{departs}}। আসন {{seats}}।'),
 ('booking_rescheduled','en','EMAIL','Trip changed — {{pnr}}','New departure: {{departs}}. Seat(s) {{seats}}.'),

 ('payment_failed','bn','SMS',NULL,'যাত্রা: {{pnr}} এর পেমেন্ট ব্যর্থ হয়েছে। আসন ছেড়ে দেওয়া হবে।'),
 ('payment_failed','en','SMS',NULL,'Jatra: payment failed for {{pnr}}. The seats will be released.'),

 ('trip_cancelled','bn','SMS',NULL,'যাত্রা: দুঃখিত, {{route}} ({{departs}}) বাতিল হয়েছে। সম্পূর্ণ ভাড়া ফেরত দেওয়া হবে।'),
 ('trip_cancelled','en','SMS',NULL,'Jatra: {{route}} ({{departs}}) is cancelled. You will be refunded in full.'),
 ('trip_cancelled','bn','PUSH','যাত্রা বাতিল','{{route}} {{departs}} বাতিল হয়েছে'),
 ('trip_cancelled','en','PUSH','Trip cancelled','{{route}} {{departs}} has been cancelled'),

 ('trip_delayed','bn','SMS',NULL,'যাত্রা: {{route}} প্রায় {{minutes}} মিনিট দেরিতে ছাড়বে।'),
 ('trip_delayed','en','SMS',NULL,'Jatra: {{route}} is running about {{minutes}} minutes late.'),
 ('trip_delayed','bn','PUSH','দেরি','{{route}} — {{minutes}} মিনিট দেরি'),
 ('trip_delayed','en','PUSH','Delay','{{route}} — {{minutes}} minutes late'),

 ('bus_approaching','bn','PUSH','বাস কাছেই','আপনার বাস {{stop_name}} থেকে প্রায় {{minutes}} মিনিট দূরে।'),
 ('bus_approaching','en','PUSH','Bus approaching','Your bus is about {{minutes}} minutes from {{stop_name}}.'),
 ('bus_approaching','bn','SMS',NULL,'যাত্রা: আপনার বাস {{stop_name}} থেকে প্রায় {{minutes}} মিনিট দূরে ({{pnr}})।'),
 ('bus_approaching','en','SMS',NULL,'Jatra: your bus is about {{minutes}} minutes from {{stop_name}} ({{pnr}}).'),

 ('incident_reported','bn','SMS',NULL,'যাত্রা কন্ট্রোল: {{kind}} — {{route}}, বাস {{bus}}। বিস্তারিত: {{note}}'),
 ('incident_reported','en','SMS',NULL,'Jatra control: {{kind}} on {{route}}, bus {{bus}}. Detail: {{note}}'),

 ('wallet_low','bn','SMS',NULL,'যাত্রা: {{agency}} এর ব্যালেন্স কম — ৳{{available}} বাকি। রিচার্জ করুন।'),
 ('wallet_low','en','SMS',NULL,'Jatra: {{agency}} wallet is low — BDT {{available}} remaining. Please recharge.'),
 ('wallet_low','bn','EMAIL','ওয়ালেট ব্যালেন্স কম','{{agency}}: ৳{{available}} বাকি।'),
 ('wallet_low','en','EMAIL','Wallet balance low','{{agency}}: BDT {{available}} remaining.'),

 ('settlement_paid','bn','EMAIL','সেটেলমেন্ট পরিশোধ — {{period}}','{{operator}} — ৳{{amount}} পরিশোধ করা হয়েছে।'),
 ('settlement_paid','en','EMAIL','Settlement paid — {{period}}','{{operator}} — BDT {{amount}} has been paid.'),
 ('settlement_paid','bn','SMS',NULL,'যাত্রা: {{period}} এর সেটেলমেন্ট ৳{{amount}} পরিশোধ হয়েছে।'),
 ('settlement_paid','en','SMS',NULL,'Jatra: settlement for {{period}} paid, BDT {{amount}}.'),

 ('auth_otp','bn','SMS',NULL,'যাত্রা: আপনার কোড {{code}}। ৫ মিনিটে মেয়াদ শেষ। কাউকে জানাবেন না।'),
 ('auth_otp','en','SMS',NULL,'Jatra: your code is {{code}}. Expires in 5 minutes. Do not share it.'),

 ('promo_campaign','bn','SMS',NULL,'যাত্রা: {{title}} — কোড {{code}} ব্যবহার করে {{discount}} ছাড় পান।'),
 ('promo_campaign','en','SMS',NULL,'Jatra: {{title}} — use code {{code}} for {{discount}} off.');

-- A generous cap for the local harness. Production sets this per month from the
-- finance plan; what matters is that the breaker exists and is tested.
INSERT INTO notify.budgets (period, cap_poisha)
VALUES (to_char(now(), 'YYYY-MM'), 5000000);

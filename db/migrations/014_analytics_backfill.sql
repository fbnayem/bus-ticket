-- 014_analytics_backfill.sql — seed the reporting store from the bookings that
-- existed before it did.
--
-- The analytics fact table is fed by a consumer on the event stream, and that
-- stream only starts when the backbone does. Every booking taken before then is
-- real, settled and in the ledger, but invisible to reporting — so the
-- integrity check comparing the two stores would show a permanent variance and
-- nobody would ever trust it again.
--
-- This is the one legitimate backfill in the platform, and it is worth being
-- precise about why it differs from the one the plan forbids. The ledger must
-- never be backfilled, because a journal invented after the fact cannot be
-- audited against anything. A reporting projection is the opposite: it is
-- derived, disposable, and rebuildable from the transactional truth by
-- definition. Reconstructing it is not fabricating history, it is recomputing a
-- view of history that already exists.
--
-- Idempotent on event_id, so re-running changes nothing.

SET client_min_messages = warning;

-- Confirmed bookings become booking.confirmed facts.
INSERT INTO analytics.facts
    (event_id, event_type, occurred_at, day, hour, operator_id, trip_id,
     route_name, channel, pnr, seats, amount_poisha, payload)
SELECT
    -- A deterministic id derived from the booking, so a second run collides
    -- with itself rather than doubling the day's revenue.
    md5('booking.confirmed:' || b.booking_id::text)::uuid,
    'booking.confirmed',
    b.created_at,
    (b.created_at AT TIME ZONE 'Asia/Dhaka')::date,
    EXTRACT(HOUR FROM (b.created_at AT TIME ZONE 'Asia/Dhaka'))::int,
    b.operator_id, b.trip_id, rt.name, b.channel, b.pnr,
    (SELECT count(*) FROM commerce.booking_seats s WHERE s.booking_id = b.booking_id),
    b.total_poisha,
    jsonb_build_object('backfilled', true)
  FROM commerce.bookings b
  -- LEFT, deliberately. Trips are pruned once they are long past; a fact about
  -- a booking must not vanish because the trip row it referenced was tidied up.
  LEFT JOIN catalog.trips t  ON t.trip_id = b.trip_id
  LEFT JOIN catalog.routes rt ON rt.route_id = t.route_id
 WHERE b.status IN ('TICKETED','COMPLETED','CANCELLED','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED')
   -- Skip anything the live consumer already recorded. The backfill fills the
   -- gap before the event stream existed; it must not shadow it afterwards, or
   -- every booking taken since would be counted twice.
   AND NOT EXISTS (SELECT 1 FROM analytics.facts f
                    WHERE f.event_type = 'booking.confirmed' AND f.pnr = b.pnr)
ON CONFLICT (event_id) DO NOTHING;

-- Cancellations too, so the cancellation rate is not zero for all of history.
INSERT INTO analytics.facts
    (event_id, event_type, occurred_at, day, hour, operator_id, trip_id,
     route_name, channel, pnr, seats, amount_poisha, payload)
SELECT
    md5('booking.cancelled:' || c.cancellation_id::text)::uuid,
    'booking.cancelled',
    c.created_at,
    (c.created_at AT TIME ZONE 'Asia/Dhaka')::date,
    EXTRACT(HOUR FROM (c.created_at AT TIME ZONE 'Asia/Dhaka'))::int,
    b.operator_id, b.trip_id, rt.name, b.channel, b.pnr,
    (SELECT count(*) FROM commerce.booking_seats s WHERE s.booking_id = b.booking_id),
    c.refund_poisha,
    jsonb_build_object('backfilled', true)
  FROM commerce.cancellations c
  JOIN commerce.bookings b ON b.booking_id = c.booking_id
  LEFT JOIN catalog.trips t  ON t.trip_id = b.trip_id
  LEFT JOIN catalog.routes rt ON rt.route_id = t.route_id
 WHERE NOT EXISTS (SELECT 1 FROM analytics.facts f
                    WHERE f.event_type = 'booking.cancelled' AND f.pnr = b.pnr)
ON CONFLICT (event_id) DO NOTHING;

-- And settled refunds.
INSERT INTO analytics.facts
    (event_id, event_type, occurred_at, day, hour, operator_id, trip_id,
     route_name, channel, pnr, seats, amount_poisha, payload)
SELECT
    md5('refund.completed:' || r.refund_id::text)::uuid,
    'refund.completed',
    r.updated_at,
    (r.updated_at AT TIME ZONE 'Asia/Dhaka')::date,
    EXTRACT(HOUR FROM (r.updated_at AT TIME ZONE 'Asia/Dhaka'))::int,
    b.operator_id, b.trip_id, rt.name, b.channel, b.pnr, 0,
    r.amount_poisha,
    jsonb_build_object('backfilled', true)
  FROM commerce.refunds r
  JOIN commerce.bookings b ON b.booking_id = r.booking_id
  LEFT JOIN catalog.trips t  ON t.trip_id = b.trip_id
  LEFT JOIN catalog.routes rt ON rt.route_id = t.route_id
 WHERE r.status = 'SUCCESS'
   AND NOT EXISTS (SELECT 1 FROM analytics.facts f
                    WHERE f.event_type = 'refund.completed' AND f.pnr = b.pnr)
ON CONFLICT (event_id) DO NOTHING;

-- Verified payments, so payment success rate has a denominator.
INSERT INTO analytics.facts
    (event_id, event_type, occurred_at, day, hour, operator_id, trip_id,
     route_name, channel, pnr, seats, amount_poisha, payload)
SELECT
    md5('payment.success:' || p.payment_id::text)::uuid,
    'payment.success',
    p.created_at,
    (p.created_at AT TIME ZONE 'Asia/Dhaka')::date,
    EXTRACT(HOUR FROM (p.created_at AT TIME ZONE 'Asia/Dhaka'))::int,
    b.operator_id, b.trip_id, rt.name, b.channel, b.pnr, 0,
    p.amount_poisha,
    jsonb_build_object('backfilled', true, 'provider', p.provider)
  FROM commerce.payments p
  JOIN commerce.bookings b ON b.booking_id = p.booking_id
  LEFT JOIN catalog.trips t  ON t.trip_id = b.trip_id
  LEFT JOIN catalog.routes rt ON rt.route_id = t.route_id
 WHERE p.status = 'PAID'
   AND NOT EXISTS (SELECT 1 FROM analytics.facts f
                    WHERE f.event_type = 'payment.success' AND f.pnr = b.pnr)
ON CONFLICT (event_id) DO NOTHING;

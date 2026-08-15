-- 013_reschedule_money.sql — make a reschedule move money.
--
-- Rescheduling priced the fare difference and showed it to the passenger, and
-- then did nothing about it: no charge for an upgrade, no refund for a cheaper
-- departure, and no ledger entry either way. Two columns close that.
--
-- amount_due_poisha is what this booking still needs before it can be ticketed.
-- For an ordinary booking that is the whole fare, so the column stays 0 and the
-- webhook keeps checking total_poisha. For a reschedule it is only the
-- difference, because the rest was already collected on the original booking.
--
-- reschedule_of points at the booking this one replaces. It is what tells the
-- webhook path to post a reschedule journal — reversing the old split and
-- applying the new one — instead of pricing the fare from scratch and
-- double-counting money the passenger already paid.

SET client_min_messages = warning;

ALTER TABLE commerce.bookings
    ADD COLUMN IF NOT EXISTS amount_due_poisha bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reschedule_of uuid REFERENCES commerce.bookings(booking_id);

CREATE INDEX IF NOT EXISTS bookings_reschedule_idx ON commerce.bookings (reschedule_of)
    WHERE reschedule_of IS NOT NULL;

-- Schedule sanity, enforced at the last line of defence.
--
-- The API already rejects a days_mask outside 1..127 and an end date before the
-- start, but the schedule table trusted whatever reached it — a direct INSERT, a
-- future code path, or a seed typo could store a schedule that generates trips on
-- impossible days or over a backwards window. These CHECKs make the database
-- refuse what the handler already refuses, so the invariant holds regardless of
-- who writes the row.
--
-- days_mask has one bit per weekday (bit 0 = Monday): 0 means "runs on no day" —
-- a schedule that can never produce a trip — and anything above 127 sets bits
-- that no weekday maps to. valid_to, when present, must not precede valid_from.

ALTER TABLE catalog.schedules
    ADD CONSTRAINT schedules_days_mask_valid
        CHECK (days_mask BETWEEN 1 AND 127),
    ADD CONSTRAINT schedules_dates_ordered
        CHECK (valid_to IS NULL OR valid_to >= valid_from);

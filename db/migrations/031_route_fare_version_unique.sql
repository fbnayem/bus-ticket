-- One published fare per (journey, class, version), enforced by the database.
--
-- Publishing a new fare reads the current max version, inserts max+1, then
-- deletes the previous current row. Run twice at once, both reads see the same
-- max, both insert the same next version, and each delete removes the OTHER's
-- fresh row — leaving the journey with no published fare at all, the exact
-- opposite of the "no window without a fare" intent. This unique index makes the
-- second concurrent insert fail instead, so its transaction rolls back and the
-- existing fare stays in place. Partial-uniqueness is not needed; every row is a
-- real version.

CREATE UNIQUE INDEX IF NOT EXISTS route_fares_version_unique
    ON catalog.route_fares (route_id, from_stop_seq, to_stop_seq, fare_class, version);

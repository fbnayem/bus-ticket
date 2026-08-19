-- Staff account lockout gets a cooldown, so the brute-force protection stops
-- being a free denial-of-service lever.
--
-- Before this, eight wrong passwords locked an account until an administrator
-- unlocked it by hand — which means anyone who knows a clerk's or driver's email
-- can lock them out of a shift at will. Recording WHEN the lock happened lets the
-- login path lift it automatically after a cooldown window, keeping the guess
-- limit while removing the standing DoS. A NULL locked_at is an account that was
-- never locked (or was cleared), so existing rows need no backfill.

ALTER TABLE staff.staff_users
    ADD COLUMN IF NOT EXISTS locked_at timestamptz;

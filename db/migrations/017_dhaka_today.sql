-- 017_dhaka_today.sql — one definition of "today".
--
-- Every "today" in this platform had been PostgreSQL's current_date, which is
-- the date in the database's own timezone — UTC here, and UTC in most managed
-- deployments. The platform sells bus tickets in Bangladesh, six hours ahead.
--
-- Between midnight and 06:00 Dhaka time the two disagree, and the consequences
-- are not cosmetic. A driver at half past midnight is shown a trip window that
-- has silently slipped a day back, so tomorrow's departure — the one they are
-- about to drive — is missing from their app. An operator dashboard reports
-- yesterday's takings as today's. A partner's daily quota resets six hours late.
--
-- This is the single definition everything now uses. It is a function rather
-- than a repeated expression so there is exactly one place to change if the
-- platform ever sells outside this timezone.

SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION catalog.bd_today()
RETURNS date LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date;
$$;

COMMENT ON FUNCTION catalog.bd_today() IS
    'Today in Asia/Dhaka. Use instead of current_date for any service date, '
    'business day or "today" a passenger, crew member or operator would recognise.';

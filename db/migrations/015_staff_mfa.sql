-- 015_staff_mfa.sql — the replay table for staff one-time codes.
--
-- staff.staff_users has carried mfa_enabled and mfa_secret since 007; nothing
-- enforced them. This is the piece that was missing, and it is the piece that
-- makes a second factor worth having: a code is good exactly once inside its
-- own thirty-second step.
--
-- Without it, anyone who reads six digits over a clerk's shoulder has half a
-- minute to use them again, which is most of the point of TOTP gone.

SET client_min_messages = warning;

CREATE TABLE staff.mfa_used (
    staff_id uuid   NOT NULL REFERENCES staff.staff_users(staff_id) ON DELETE CASCADE,
    code     text   NOT NULL,
    step     bigint NOT NULL,
    used_at  timestamptz NOT NULL DEFAULT now(),
    -- The primary key IS the check. An application "have I seen this code?"
    -- lookup would race two logins presenting the same digits.
    PRIMARY KEY (staff_id, code, step)
);

-- Codes are only interesting for as long as they could still be replayed.
CREATE INDEX mfa_used_age_idx ON staff.mfa_used (used_at);

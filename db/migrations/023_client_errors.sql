-- 023_client_errors.sql — somewhere for a crash on a bus to land.
--
-- Until now a Flutter exception on a conductor's phone produced a red screen on
-- that phone and nothing anywhere else. Nobody at the office learned it had
-- happened; the conductor force-quit the app and carried on selling on paper.
-- The bug that did it was found, if it was found at all, by someone happening
-- to reproduce it.
--
-- This table is deliberately modest. It is not a crash-reporting product: no
-- symbolication, no grouping by similarity, no alerting. It is the smallest
-- thing that turns "the app crashed sometimes last week" into a row with a
-- stack trace, a screen name, an app version and a time — which is the
-- difference between a report somebody can act on and a rumour.
--
-- What it deliberately does NOT store:
--
--   No passenger names, phones or PNRs. A stack trace is written by us and a
--   screen name is chosen by us; a crash report must not become a side channel
--   for the personal data the rest of the system is careful with. The staff id
--   is kept when the reporter was signed in, because "which conductor, on which
--   phone" is how a field bug gets reproduced, and they are our own people.
--
-- The fingerprint is the one concession to volume: the same bug hit two hundred
-- times in a morning is one problem, and a table that shows it two hundred
-- times hides the other two.

BEGIN;

CREATE TABLE IF NOT EXISTS ops.client_errors (
    error_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Which app, so a crash in the crew app is not read as a passenger one.
    app          text NOT NULL CHECK (app IN ('passenger','crew','web')),
    app_version  text NOT NULL DEFAULT '',
    platform     text NOT NULL DEFAULT '',   -- android 14, ios 17, chrome 140
    -- Where the person was. A stack trace names our functions; this names the
    -- screen a human would say they were on.
    screen       text NOT NULL DEFAULT '',
    kind         text NOT NULL DEFAULT '',   -- the exception type
    message      text NOT NULL,
    stack        text NOT NULL DEFAULT '',
    -- Set when the reporter was signed in. Null for a passenger who is not.
    staff_id     uuid REFERENCES staff.staff_users(staff_id),
    -- Grouping, computed by the client from kind + the top frames, so the same
    -- fault reported two hundred times is one row with a count of two hundred.
    fingerprint  text NOT NULL,
    occurrences  integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
    first_seen   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz,
    UNIQUE (app, fingerprint)
);

CREATE INDEX IF NOT EXISTS client_errors_open_idx
    ON ops.client_errors (last_seen DESC) WHERE resolved_at IS NULL;

-- Reading crash reports is an operations job, not a finance or a selling one.
INSERT INTO catalog.permissions (permission) VALUES ('ops.errors.read')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, 'ops.errors.read'
  FROM catalog.roles r
 WHERE r.role_key IN ('SUPER_ADMIN','OPS_ADMIN','AUDITOR')
ON CONFLICT DO NOTHING;

COMMIT;

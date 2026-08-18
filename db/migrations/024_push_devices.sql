-- 024_push_devices.sql — somewhere for a push notification to be addressed to.
--
-- The notify service has had a PUSH channel since 007: providers, preferences,
-- templates, a delivery log. What it has never had is an address. Audience
-- carried a PushToken field that nothing ever set, so every push was skipped
-- for want of a recipient — visibly, in the delivery log, which is the right
-- way to do nothing, but still nothing.
--
-- The missing half is a device registry, and it is missing because there was no
-- app when that code was written. There are two now.
--
-- What a row here is: one installation of one app on one phone, and the token
-- that reaches it. Not one person — a conductor with a work phone and a home
-- phone is two rows, and a ticket bought for a family is one row per phone that
-- signed in. Notifying all of them is the point.
--
-- Tokens are rotated by the platform vendors without warning and are dead the
-- moment an app is uninstalled. So:
--
--   * the token is the unique key, not the user. The same token arriving for a
--     different user means the phone changed hands, and the row moves with it
--     rather than delivering somebody else's ticket to them.
--   * last_seen_at is stamped on every registration. A token nobody has
--     re-registered in months is almost certainly dead, and sending to it costs
--     money and reports a false delivery.
--   * revoked_at, set on sign-out. A signed-out phone must stop receiving.

BEGIN;

CREATE TABLE IF NOT EXISTS notify.devices (
    device_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The push token itself, as issued by the platform vendor.
    token        text NOT NULL UNIQUE,
    -- Which app, so a crew notification is never delivered to a passenger's
    -- phone that happens to share an account.
    app          text NOT NULL CHECK (app IN ('passenger','crew')),
    platform     text NOT NULL DEFAULT '' CHECK (platform IN ('','android','ios','web')),
    -- Exactly one of these is set. A passenger is an identity; a staff member is
    -- a staff user; the two live in different tables and always have.
    user_id      uuid REFERENCES catalog.users(user_id) ON DELETE CASCADE,
    staff_id     uuid REFERENCES staff.staff_users(staff_id) ON DELETE CASCADE,
    -- The same key the notify preferences are stored against, so a device
    -- inherits the choices its owner already made about being contacted.
    user_key     text NOT NULL DEFAULT '',
    device_ref   text NOT NULL DEFAULT '',
    registered_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    CONSTRAINT device_has_an_owner
        CHECK ((user_id IS NOT NULL) <> (staff_id IS NOT NULL))
);

-- The two lookups this table exists to answer: everything live for a passenger,
-- and everything live for a staff member.
CREATE INDEX IF NOT EXISTS devices_user_idx
    ON notify.devices (user_id, last_seen_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS devices_staff_idx
    ON notify.devices (staff_id, last_seen_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS devices_userkey_idx
    ON notify.devices (user_key) WHERE revoked_at IS NULL;

COMMIT;

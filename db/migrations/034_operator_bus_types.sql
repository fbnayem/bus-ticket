-- Let an operator define their own bus types.
--
-- catalog.bus_types began as a single shared catalog seeded by the platform. But
-- "AC Business 2x2", "Non-AC Sleeper", "Hyundai Universe" are an operator's own
-- product names — one operator's "Business Class" is not another's — and an
-- operator onboarding themselves needs to add the coaches they actually run
-- without a platform round-trip.
--
-- So a bus type is now either GLOBAL (operator_id IS NULL — the platform's shared
-- seed types, visible to everyone) or OWNED (operator_id set — visible and usable
-- only by that operator). A NULL keeps every existing seed type global and every
-- existing bus valid; nothing has to be backfilled.

ALTER TABLE catalog.bus_types
    ADD COLUMN IF NOT EXISTS operator_id uuid REFERENCES catalog.operators(operator_id);

COMMENT ON COLUMN catalog.bus_types.operator_id IS
    'NULL = platform-global type, visible to all operators; set = private to that operator.';

-- A name is unique within its owner (and within the global set), so an operator
-- cannot create two "AC Business" types and the picker is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS bus_types_owner_name_unique
    ON catalog.bus_types (COALESCE(operator_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

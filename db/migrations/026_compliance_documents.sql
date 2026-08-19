-- Compliance documents: the papers a Bangladeshi bus and its driver must carry,
-- and the dates they lapse.
--
-- A bus on an intercity route is only legal with a current registration,
-- fitness certificate, tax token, route permit and third-party insurance; its
-- driver with a valid licence. Every one of these expires, and an expired one is
-- a bus pulled off the road at a highway check-post. The platform cannot file
-- the renewals, but it can make sure nobody is surprised by them — so it holds
-- the expiry dates and surfaces what is lapsing before it lapses.

CREATE SCHEMA IF NOT EXISTS compliance;

CREATE TABLE IF NOT EXISTS compliance.documents (
    document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id uuid NOT NULL REFERENCES catalog.operators(operator_id),
    -- Exactly one subject: a document belongs to a vehicle or to a person,
    -- never both and never neither. The CHECK is the whole integrity of the
    -- table — a document about nothing, or about two things, is meaningless.
    bus_id      uuid REFERENCES catalog.buses(bus_id) ON DELETE CASCADE,
    staff_id    uuid REFERENCES staff.staff_users(staff_id) ON DELETE CASCADE,
    doc_type    text NOT NULL CHECK (doc_type IN (
                    -- vehicle
                    'REGISTRATION','FITNESS','TAX_TOKEN','ROUTE_PERMIT','INSURANCE',
                    -- driver
                    'DRIVING_LICENSE')),
    doc_number  text,
    issued_on   date,
    expires_on  date NOT NULL,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((bus_id IS NOT NULL) <> (staff_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS documents_operator_expiry ON compliance.documents (operator_id, expires_on);
CREATE INDEX IF NOT EXISTS documents_bus ON compliance.documents (bus_id);
CREATE INDEX IF NOT EXISTS documents_staff ON compliance.documents (staff_id);

-- ============================================================= permissions ==
-- compliance.read  — see the documents and the expiry alerts.
-- compliance.write — add, renew and remove them.
INSERT INTO catalog.permissions (permission) VALUES
    ('compliance.read'),
    ('compliance.write')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    ('c0000000-0000-0000-0000-000000000011','compliance.read'),
    ('c0000000-0000-0000-0000-000000000011','compliance.write'),
    ('c0000000-0000-0000-0000-000000000012','compliance.read'),
    ('c0000000-0000-0000-0000-000000000012','compliance.write')
ON CONFLICT DO NOTHING;

-- ================================================================== seed ==
-- Green Line's first bus and its driver, with a spread of dates anchored to
-- Dhaka today: two current, one expiring within the month, one already lapsed —
-- so the alerts panel shows a real state the first time it is opened. A seeded
-- fixture is not a policy; an operator with no rows simply has nothing flagged.
INSERT INTO compliance.documents (operator_id, bus_id, staff_id, doc_type, doc_number, issued_on, expires_on) VALUES
    ('11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000001',NULL,
     'REGISTRATION','DHAKA-METRO-B-11-2233', catalog.bd_today() - 700, catalog.bd_today() + 240),
    ('11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000001',NULL,
     'INSURANCE','INS-GL-2233-7781', catalog.bd_today() - 160, catalog.bd_today() + 205),
    ('11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000001',NULL,
     'FITNESS','FIT-2233-2026', catalog.bd_today() - 350, catalog.bd_today() + 18),
    ('11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000001',NULL,
     'ROUTE_PERMIT','RP-DHK-CTG-119', catalog.bd_today() - 400, catalog.bd_today() - 4),
    ('11111111-1111-1111-1111-111111111111',NULL,'f0000000-0000-0000-0000-000000000016',
     'DRIVING_LICENSE','DL-BD-771122', catalog.bd_today() - 900, catalog.bd_today() + 26)
ON CONFLICT DO NOTHING;

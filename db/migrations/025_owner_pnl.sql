-- 025_owner_pnl.sql — the cost side of the ledger, so an owner can be told
-- profit rather than only revenue.
--
-- The platform's double-entry ledger (finance.ledger_accounts, .ledger_entries)
-- records money the PLATFORM holds, owes, or earns: passenger cash in transit,
-- operator payable, platform revenue, commission expense. Its trial balance is
-- asserted to be zero and the proof suite depends on that.
--
-- An operator's fuel bill is none of that money. It never passes through the
-- platform's hands. Forcing it into the platform ledger would either unbalance
-- the trial balance or invent a fake counter-party account for every litre of
-- diesel — both of which corrupt the meaning of every existing account. So
-- operating expenses live here, in their own table, DELIBERATELY OUTSIDE the
-- platform trial balance. This is operator bookkeeping for the owner's P&L, not
-- platform accounting.
--
-- P&L, per bus, for a period:
--
--   ticket sales (gross)      Σ bookings.total_poisha on that bus's trips
--   − platform commission     the platform's 10% + service fee
--   − staff commission        crew + agent commission on those bookings
--   = net fare to operator
--   − fuel − maintenance − wages − other   from operating_expenses
--   = profit / (loss)
--
-- Revenue is already recorded end to end. This migration adds the only missing
-- half — the costs — and the two permissions that gate seeing and recording it.

BEGIN;

CREATE TABLE IF NOT EXISTS finance.operating_expenses (
    expense_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Tenancy, exactly like every other operator-scoped table. Every query
    -- filters on it; an owner never sees another operator's costs.
    operator_id  uuid NOT NULL REFERENCES catalog.operators(operator_id),
    -- The bus this cost belongs to. NULL means an operator-wide overhead — an
    -- office rent, a network permit — that belongs in the operator's P&L but
    -- cannot honestly be pinned to one bus. Per-bus P&L shows only its own
    -- bus's costs; the operator total shows all of them.
    bus_id       uuid REFERENCES catalog.buses(bus_id),
    category     text NOT NULL
                 CHECK (category IN ('FUEL','MAINTENANCE','WAGES','INSURANCE','TOLL','PERMIT','OTHER')),
    -- Positive poisha. A cost is a cost; a correction is a delete-and-re-enter,
    -- not a negative row, so the sign can never be argued about.
    amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
    -- The day the money was spent, which is what decides the period it falls in.
    -- Distinct from created_at (when it was typed in), because a fuel bill is
    -- often entered days after the tank was filled.
    incurred_on  date NOT NULL,
    note         text NOT NULL DEFAULT '',
    recorded_by  uuid REFERENCES staff.staff_users(staff_id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The two lookups this table answers: an operator's costs over a period, and one
-- bus's costs over a period.
CREATE INDEX IF NOT EXISTS opex_operator_idx ON finance.operating_expenses (operator_id, incurred_on);
CREATE INDEX IF NOT EXISTS opex_bus_idx      ON finance.operating_expenses (bus_id, incurred_on) WHERE bus_id IS NOT NULL;

-- ============================================================= permissions ==
-- owner.pnl  — see the profit-and-loss and the cross-staff sales report.
-- owner.costs — record and remove operating expenses.
--
-- Two permissions, not one, for the same reason crew.sell and crew.discount are
-- split: an accountant may need to SEE the P&L without being able to change the
-- costs that drive it.
INSERT INTO catalog.permissions (permission) VALUES
    ('owner.pnl'),
    ('owner.costs')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    -- OPERATOR_OWNER: the whole picture, and the pen.
    ('c0000000-0000-0000-0000-000000000011','owner.pnl'),
    ('c0000000-0000-0000-0000-000000000011','owner.costs'),
    -- OPERATOR_MANAGER: runs the fleet day to day, records the costs.
    ('c0000000-0000-0000-0000-000000000012','owner.pnl'),
    ('c0000000-0000-0000-0000-000000000012','owner.costs'),
    -- ACCOUNTANT: reads the P&L, does not touch the fleet's spending.
    ('c0000000-0000-0000-0000-000000000014','owner.pnl')
ON CONFLICT DO NOTHING;

-- ================================================================== seed ==
-- Demo operating costs for Green Line's two buses, so the P&L shows a real
-- profit and loss the first time it is opened rather than an empty frame. A
-- seeded fixture is not a policy: an operator with no cost rows simply sees its
-- full fare revenue as its profit, which is the honest default until costs are
-- entered. Dates are anchored to CURRENT_DATE so they fall inside the report's
-- default window on whatever day the database is built.
INSERT INTO finance.operating_expenses (operator_id, bus_id, category, amount_poisha, incurred_on, note, recorded_by)
SELECT b.operator_id, b.bus_id, x.category, x.amount, CURRENT_DATE - x.days_ago, x.note,
       'f0000000-0000-0000-0000-000000000011'::uuid
  FROM catalog.buses b
  JOIN catalog.operators o ON o.operator_id = b.operator_id AND o.brand ILIKE '%green%'
  JOIN (VALUES
        ('FUEL'::text,        1850000::bigint,  2, 'Diesel, Dhaka depot'),
        ('FUEL',              1720000,          9, 'Diesel, Chattogram return'),
        ('MAINTENANCE',        640000,          5, 'Brake pads and service'),
        ('WAGES',             1200000,          3, 'Driver and helper, weekly'),
        ('TOLL',                88000,          2, 'Meghna and Gumti bridge'),
        ('INSURANCE',          450000,          7, 'Monthly premium, apportioned')
       ) AS x(category, amount, days_ago, note) ON true
ON CONFLICT DO NOTHING;

COMMIT;

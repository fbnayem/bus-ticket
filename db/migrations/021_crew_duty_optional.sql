-- 021_crew_duty_optional.sql — the person is the account, the bag is optional.
--
-- 020 made a cash bag (crew.duties) mandatory before a conductor could take
-- money. That was the wrong invariant, and it showed up the moment somebody
-- signed in and tried to sell: a ticket cannot be sold until a ceremony has
-- been performed, and the ceremony exists for the benefit of a reconciliation
-- that may never be wanted.
--
-- The invariant that is actually true: every taka taken on a bus was taken by
-- a specific person, and that person is known at the moment of sale because
-- they are signed in. A duty is a *reconciliation session* over that person's
-- cash — useful when somebody wants to physically count a bag against what the
-- platform expected, and absent otherwise. Optional, not foundational.
--
-- So this migration moves the accounting subject from the bag to the person:
--
--   crew.cash_transactions gains staff_id NOT NULL, and duty_id becomes
--   nullable. A movement always has an owner; it only sometimes has a bag.
--
--   finance.ledger_entries party_ref on 1002 Cash in Transit — Crew is
--   backfilled from duty to staff, so that account is keyed one way rather
--   than two. "How much cash is in whose pocket right now" stays a single
--   GROUP BY, which is the control the account exists to provide — and it is
--   the query the owner app will ask.
--
-- Nothing about the money model changes. The same three legs, the same
-- commission journal, the same discount ceiling. Only the party on the cash
-- leg, and the nullability of a column.

BEGIN;

-- Every cash movement belongs to a person. Added nullable, backfilled through
-- the duty it currently hangs off, then made NOT NULL — the ordinary three
-- steps, because the column has to be true of existing rows before it can be
-- required of new ones.
ALTER TABLE crew.cash_transactions
    ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES staff.staff_users(staff_id);

UPDATE crew.cash_transactions ct
   SET staff_id = d.staff_id
  FROM crew.duties d
 WHERE d.duty_id = ct.duty_id AND ct.staff_id IS NULL;

ALTER TABLE crew.cash_transactions ALTER COLUMN staff_id SET NOT NULL;
ALTER TABLE crew.cash_transactions ALTER COLUMN duty_id  DROP NOT NULL;

CREATE INDEX IF NOT EXISTS crew_cash_staff_idx
    ON crew.cash_transactions (staff_id, created_at);

-- A duty-less movement is still a movement; a duty-bound one still sums into
-- its bag. DutySummary filters on duty_id and is unaffected.

-- The cash account is now keyed by person everywhere, including for the sales
-- 020 already posted. Scoped to 1002 and to party_refs that are duties: no
-- other account uses a duty as a party, so this cannot touch anything else.
UPDATE finance.ledger_entries e
   SET party_ref = d.staff_id::text
  FROM crew.duties d
 WHERE e.account_code = '1002'
   AND e.party_ref = d.duty_id::text;

COMMIT;

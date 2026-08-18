-- 022_settlement_cash_in_hand.sql — stop paying out money the operator already has.
--
-- A settlement pays an operator what the platform owes them for a period. It
-- computed that as gross minus commission minus refunds, for every booking
-- alike — and about forty percent of the demo operator's sales are cash their
-- own staff took at a counter or on a bus. That cash never reached the
-- platform. Paying the operator its share of it a second time is not a rounding
-- problem; it is the whole amount, twice.
--
--   Green Line, demo data: Tk 761,840 sold, of which Tk 303,590 was collected
--   in cash by their own counter clerks and conductors.
--
-- The owner's decision, taken before this was written: the cash is the
-- operator's from the moment their staff take it. So the settlement deducts it
-- and pays only the remainder — and where a period's commission exceeds what
-- the platform actually collected, net_payable goes negative and the operator
-- owes the platform. That is a real outcome for an operator selling mostly at
-- the roadside, and the column is deliberately signed so it can be read rather
-- than clamped to zero and quietly lost.
--
-- Which channels count as cash in the operator's own hands:
--
--   COUNTER, COUNTER_OFFLINE   their counter, their drawer
--   ONBOARD                    their conductor, their pocket
--
-- and which do not:
--
--   WEB, APP        the passenger paid the platform's provider
--   AGENT           an agency draws on a prepaid wallet the platform holds
--   PARTNER, AI     the platform collected it
--
-- The list lives in one place in commerce.CalculateSettlement, not here, because
-- adding a channel should be one edit and not two.

BEGIN;

ALTER TABLE finance.settlement_items
    ADD COLUMN IF NOT EXISTS cash_collected_poisha bigint NOT NULL DEFAULT 0
        CHECK (cash_collected_poisha >= 0);

ALTER TABLE finance.settlements
    ADD COLUMN IF NOT EXISTS cash_collected_poisha bigint NOT NULL DEFAULT 0
        CHECK (cash_collected_poisha >= 0);

-- Deliberately no backfill. Existing rows keep 0 and therefore keep the number
-- somebody may already have signed off; recalculating a settlement is how a new
-- figure is arrived at, and an APPROVED one refuses to be recalculated at all.
-- Rewriting history under a signature is the one thing this table exists to
-- prevent.

COMMIT;

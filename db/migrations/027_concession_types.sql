-- Concession fares: the reduced fares a bus operator gives to children,
-- students and senior citizens.
--
-- A concession reduces the FARE, never the platform's booking fee, and the
-- OPERATOR absorbs it — the platform's commission is still computed on the full
-- published fare, exactly as an on-board crew discount is handled. That keeps
-- one rule for "who pays for a lower fare" across every channel: the party who
-- chose to lower it.
--
-- The discount is basis points, never a float: 50% is 5000, 25% is 2500.

CREATE TABLE IF NOT EXISTS catalog.concession_types (
    concession_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL operator_id is the platform default; an operator row overrides it for
    -- that operator only, so a company can be more generous than the baseline
    -- without every company being forced to.
    operator_id   uuid REFERENCES catalog.operators(operator_id) ON DELETE CASCADE,
    code          text NOT NULL CHECK (code IN ('CHILD','STUDENT','SENIOR')),
    label         text NOT NULL,
    label_bn      text NOT NULL,
    discount_bp   int  NOT NULL CHECK (discount_bp BETWEEN 0 AND 10000),
    active        boolean NOT NULL DEFAULT true
);

-- One platform default per code, and one override per operator per code.
CREATE UNIQUE INDEX IF NOT EXISTS concession_platform_default ON catalog.concession_types (code) WHERE operator_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS concession_operator_override ON catalog.concession_types (operator_id, code) WHERE operator_id IS NOT NULL;

-- Platform defaults, in both languages the frontline reads.
INSERT INTO catalog.concession_types (operator_id, code, label, label_bn, discount_bp) VALUES
    (NULL,'CHILD',  'Child',   'শিশু',            5000),
    (NULL,'STUDENT','Student', 'শিক্ষার্থী',       2500),
    (NULL,'SENIOR', 'Senior',  'প্রবীণ নাগরিক',    2500)
ON CONFLICT DO NOTHING;

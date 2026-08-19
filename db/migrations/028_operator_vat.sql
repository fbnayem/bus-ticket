-- Operator VAT registration, so a booking can be issued a Mushak 6.3 challanpatra
-- (the VAT invoice mandated by the VAT and SD Act 2012).
--
-- The platform does NOT hardcode tax law. Two facts are captured per operator and
-- nothing more: their Business Identification Number (BIN) and the VAT rate they
-- are registered to charge, in basis points. What the platform DOES know as law is
-- that non-AC intercity bus transport is VAT-exempt — so the invoice charges VAT
-- only on AC trips, and a non-AC fare is shown as an exempt supply regardless of
-- the operator's rate. The fare is treated as VAT-inclusive (the retail convention
-- here), decomposed at read time; no money moves that did not already move, and the
-- ledger is untouched — the operator remits their own VAT from their payable.

ALTER TABLE catalog.operators
  ADD COLUMN IF NOT EXISTS vat_bin     text,
  ADD COLUMN IF NOT EXISTS vat_rate_bp int NOT NULL DEFAULT 0
      CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000);

COMMENT ON COLUMN catalog.operators.vat_bin IS
  'Business Identification Number (BIN). NULL = not VAT-registered; no Mushak 6.3 is issued.';
COMMENT ON COLUMN catalog.operators.vat_rate_bp IS
  'VAT rate the operator is registered to charge, in basis points (1500 = 15%). Applied to AC fares only.';

-- Demo: two operators VAT-registered at 15%, the rest left unregistered so the
-- "no tax invoice" path is demonstrable. BINs are illustrative, not real.
UPDATE catalog.operators SET vat_bin = '000123456-0201', vat_rate_bp = 1500
 WHERE operator_id = '11111111-1111-1111-1111-111111111111'; -- Green Line
UPDATE catalog.operators SET vat_bin = '000234567-0302', vat_rate_bp = 1500
 WHERE operator_id = '11111111-1111-1111-1111-111111111112'; -- Shohagh

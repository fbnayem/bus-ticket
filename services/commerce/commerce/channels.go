package commerce

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// The counter and agent channels.
//
// Neither of them contains any seat logic. Both reach seats through the same
// InventoryClient the website uses, and both land in the same Finalise() that
// issues tickets and posts the journal. What differs is only which accounts
// the money moves between — cash in a drawer, or an agent's prepaid balance,
// instead of a payment gateway.

var (
	ErrShiftNotOpen  = errors.New("commerce: no open shift on this counter")
	ErrAlreadyPaid   = errors.New("commerce: this booking is already paid")
	ErrNotCalculated = errors.New("commerce: settlement has not been calculated")
	ErrNotReviewed  = errors.New("commerce: settlement must be reviewed before it can be approved")
	ErrSelfApproval = errors.New("commerce: the person who reviewed a settlement cannot approve it")
	// ErrOpenException is the reconciliation gate. The plan states it without
	// qualification: an unresolved exception on any transaction inside a
	// settlement window blocks that settlement from reaching APPROVED, and there
	// is no override. A discrepancy that can be approved away is one that will be.
	ErrOpenException = errors.New("commerce: unresolved reconciliation exceptions block approval")
)

const platformServiceFee = 5000 // ৳50, same as the website

// ---------------------------------------------------------------- counter --

// CounterPostings splits a counter sale.
//
// full is the undiscounted price (fare×seats + service fee); discount is any
// concession the operator granted a child, student or senior. The operator
// alone absorbs it — platform revenue is computed on the FULL fare, never the
// discounted one, exactly as CrewPostings handles an on-board discount. So the
// only thing a concession changes on this journal is how much the operator is
// paid; the platform's cut is identical with or without it. When discount is
// zero (the ordinary sale) full == gross and this is the split it always was.
//
// Cash never touches a gateway, so there is no gateway fee and the debit lands
// in Cash rather than Gateway Clearing. A counter MFS sale still pays the
// gateway, so it looks like a web sale on the debit side.
func CounterPostings(full, discount int64, method, operatorID, counterID string) []Posting {
	base := full - platformServiceFee
	gross := full - discount // what the passenger actually pays
	platform := base/10 + platformServiceFee
	if method == "CASH" {
		return []Posting{
			{"1001", "DR", gross, counterID},             // Cash (this drawer)
			{"2101", "CR", gross - platform, operatorID}, // Operator Payable — absorbs the concession
			{"4101", "CR", platform, ""},                 // Platform Revenue, untouched by the discount
		}
	}
	gatewayFee := gross * 15 / 1000
	return []Posting{
		{"1101", "DR", gross - gatewayFee, method},
		{"5102", "DR", gatewayFee, method},
		{"2101", "CR", gross - platform, operatorID},
		{"4101", "CR", platform, ""},
	}
}

// SettleCounterSale takes payment at the counter and issues the ticket.
//
// A counter sale is confirmed synchronously because the money is physically in
// the drawer — there is no provider to wait for. That is the one legitimate
// difference from the web flow, where only a verified webhook may confirm.
func (s *Service) SettleCounterSale(ctx context.Context, bookingID, shiftID, method string) error {
	var gross, discount int64
	var operatorID, holdID, status, counterID string
	var counter *string
	err := s.pool.QueryRow(ctx, `
		SELECT total_poisha, discount_poisha, operator_id::text, hold_id::text, status, counter_id::text
		  FROM commerce.bookings WHERE booking_id = $1::uuid`, bookingID).
		Scan(&gross, &discount, &operatorID, &holdID, &status, &counter)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBookingNotFound
	}
	if err != nil {
		return err
	}
	if counter != nil {
		counterID = *counter
	}
	if status != "PAYMENT_PENDING" {
		return ErrAlreadyPaid
	}

	// One payment per booking at a counter: the booking id IS the transaction
	// id, so a double-tap on the Take payment button collapses to one payment.
	// The provider is the instrument the passenger actually used; that the sale
	// happened at a counter is recorded on the booking, not smuggled in here.
	var paymentID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO commerce.payments
			(booking_id, provider, provider_txn_id, amount_poisha, currency, status)
		VALUES ($1::uuid, $2, $3, $4, 'BDT', 'PAID')
		ON CONFLICT (provider, provider_txn_id) DO NOTHING
		RETURNING payment_id::text`,
		bookingID, method, bookingID, gross).Scan(&paymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAlreadyPaid
	}
	if err != nil {
		return err
	}

	// Same inventory service, same idempotent confirm as every other channel.
	if err := s.inv.ConfirmHold(ctx, holdID); err != nil {
		return fmt.Errorf("confirm seats: %w", err)
	}
	// full is the undiscounted price; gross (total_poisha) is what the passenger
	// pays after any concession. The payment recorded above is gross — the money
	// that actually changed hands — while the ledger split is computed from full
	// so the platform's commission sits on the published fare.
	full := gross + discount
	if err := s.Finalise(ctx, bookingID, "counter sale — "+method,
		CounterPostings(full, discount, method, operatorID, counterID)); err != nil {
		return err
	}

	// Cash physically entering the drawer is recorded against the shift; this
	// is what the close-of-shift count is compared against.
	if method == "CASH" && shiftID != "" {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO counter.cash_transactions (shift_id, kind, method, booking_id, amount_poisha, note)
			VALUES ($1::uuid, 'SALE', 'CASH', $2::uuid, $3, 'ticket sale')`,
			shiftID, bookingID, gross); err != nil {
			return err
		}
	}
	return nil
}

// CloseShift counts the drawer against the ledger.
//
// The clerk's count is compared to opening float plus every cash movement
// recorded during the shift. A difference does not quietly disappear: it posts
// an explicit Cash Variance entry, so the trial balance stays at zero and the
// discrepancy is visible in the accounts rather than absorbed.
func (s *Service) CloseShift(ctx context.Context, shiftID string, countedPoisha int64, note string) (expected, variance int64, status string, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var float int64
	var counterID string
	err = tx.QueryRow(ctx, `
		SELECT opening_float_poisha, counter_id::text FROM counter.shifts
		 WHERE shift_id = $1::uuid AND status = 'OPEN' FOR UPDATE`, shiftID).Scan(&float, &counterID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, "", ErrShiftNotOpen
	}
	if err != nil {
		return 0, 0, "", err
	}

	var movements int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha),0) FROM counter.cash_transactions
		 WHERE shift_id = $1::uuid AND method = 'CASH'`, shiftID).Scan(&movements); err != nil {
		return 0, 0, "", err
	}
	expected = float + movements
	variance = countedPoisha - expected
	status = "BALANCED"
	if variance != 0 {
		status = "VARIANCE"
	}

	if _, err := tx.Exec(ctx, `
		UPDATE counter.shifts
		   SET status = $2, counted_cash_poisha = $3, expected_cash_poisha = $4,
		       variance_poisha = $5, note = NULLIF($6,''), closed_at = now()
		 WHERE shift_id = $1::uuid`,
		shiftID, status, countedPoisha, expected, variance, note); err != nil {
		return 0, 0, "", err
	}

	if variance != 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO counter.cash_transactions (shift_id, kind, method, amount_poisha, note)
			VALUES ($1::uuid, 'WRITEDOWN', 'CASH', $2, 'shift close variance')`,
			shiftID, variance); err != nil {
			return 0, 0, "", err
		}

		var journalID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO finance.journal_entries (description)
			VALUES ('counter shift variance ' || $1) RETURNING journal_id::text`, shiftID).
			Scan(&journalID); err != nil {
			return 0, 0, "", err
		}
		// A short drawer is an expense; an over drawer is a gain. Either way the
		// two legs are equal and the books stay balanced.
		drSide, crSide := "DR", "CR"
		amount := variance
		if variance < 0 {
			amount = -variance
		} else {
			drSide, crSide = "CR", "DR"
		}
		for _, e := range []struct {
			acct, side string
		}{{"5301", drSide}, {"1001", crSide}} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
				VALUES ($1::uuid,$2,$3,$4,$5)`, journalID, e.acct, e.side, amount, counterID); err != nil {
				return 0, 0, "", err
			}
		}
		if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
			return 0, 0, "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, "", err
	}
	return expected, variance, status, nil
}

// ------------------------------------------------------------------ agent --

// AgentPostings splits an agent sale. The agent has already paid us — their
// wallet is a liability we owe them — so a sale reduces that liability rather
// than bringing new cash in.
func AgentPostings(gross int64, operatorID, walletRef string) []Posting {
	base := gross - platformServiceFee
	commission := base / 10
	return []Posting{
		{"2102", "DR", gross, walletRef},              // Agent Payable falls
		{"2101", "CR", base - commission, operatorID}, // Operator Payable
		{"4101", "CR", commission + platformServiceFee, ""},
	}
}

// CommissionRule is the resolved rule for one sale.
type CommissionRule struct {
	RuleID string
	Kind   string
	ValueBP int
	Amount  int64
}

// ResolveCommission picks the most specific active rule. Specificity beats
// priority: a rule naming this agency AND this operator wins over a rule
// naming only the operator, whatever their priorities.
func (s *Service) ResolveCommission(ctx context.Context, operatorID, agencyID, routeID string) (*CommissionRule, error) {
	var r CommissionRule
	var bp *int
	var amt *int64
	err := s.pool.QueryRow(ctx, `
		SELECT rule_id::text, kind, value_bp, amount_poisha
		  FROM agent.commission_rules
		 WHERE active
		   AND (operator_id IS NULL OR operator_id = $1::uuid)
		   AND (agency_id   IS NULL OR agency_id   = $2::uuid)
		   AND (route_id    IS NULL OR route_id    = NULLIF($3,'')::uuid)
		 ORDER BY (operator_id IS NOT NULL)::int
		        + (agency_id   IS NOT NULL)::int
		        + (route_id    IS NOT NULL)::int DESC,
		          priority DESC
		 LIMIT 1`, operatorID, agencyID, routeID).Scan(&r.RuleID, &r.Kind, &bp, &amt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil // no commission configured is a valid answer
	}
	if err != nil {
		return nil, err
	}
	if bp != nil {
		r.ValueBP = *bp
	}
	if amt != nil {
		r.Amount = *amt
	}
	return &r, nil
}

// CommissionFor computes the taka an agency earns on a sale.
func (r *CommissionRule) CommissionFor(base int64) int64 {
	if r == nil {
		return 0
	}
	if r.Kind == "FLAT" {
		return r.Amount
	}
	return base * int64(r.ValueBP) / 10000
}

// SettleAgentSale captures the agent's wallet hold, issues the ticket and
// accrues commission — three effects, each idempotent, in that order.
//
// Order matters. Capture first: if the process dies after capture but before
// the ticket, the agent has been charged and the operator sees a
// PAYMENT_PENDING booking that the hold sweeper will surface. If it died the
// other way round, a ticket would exist that nobody paid for.
func (s *Service) SettleAgentSale(ctx context.Context, bookingID, agencyID, walletRef string) (commission int64, err error) {
	var gross int64
	var operatorID, holdID, status, routeID string
	err = s.pool.QueryRow(ctx, `
		SELECT b.total_poisha, b.operator_id::text, b.hold_id::text, b.status, t.route_id::text
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		 WHERE b.booking_id = $1::uuid`, bookingID).
		Scan(&gross, &operatorID, &holdID, &status, &routeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrBookingNotFound
	}
	if err != nil {
		return 0, err
	}
	if status != "PAYMENT_PENDING" {
		return 0, ErrAlreadyPaid
	}

	var paymentID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO commerce.payments
			(booking_id, provider, provider_txn_id, amount_poisha, currency, status)
		VALUES ($1::uuid, 'AGENT_WALLET', $1::text, $2, 'BDT', 'PAID')
		ON CONFLICT (provider, provider_txn_id) DO NOTHING
		RETURNING payment_id::text`, bookingID, gross).Scan(&paymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrAlreadyPaid
	}
	if err != nil {
		return 0, err
	}

	if err := s.inv.ConfirmHold(ctx, holdID); err != nil {
		return 0, fmt.Errorf("confirm seats: %w", err)
	}
	if err := s.Finalise(ctx, bookingID, "agent wallet sale",
		AgentPostings(gross, operatorID, walletRef)); err != nil {
		return 0, err
	}

	rule, err := s.ResolveCommission(ctx, operatorID, agencyID, routeID)
	if err != nil {
		return 0, err
	}
	base := gross - platformServiceFee
	commission = rule.CommissionFor(base)
	if commission <= 0 {
		return 0, nil
	}

	// Commission is an expense to us and a credit to the agent, posted as a
	// separate balanced journal so it can be reported and disputed on its own.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('agent commission ' || $1) RETURNING journal_id::text`, bookingID).Scan(&journalID); err != nil {
		return 0, err
	}
	for _, e := range []struct {
		acct, side string
	}{{"5101", "DR"}, {"2102", "CR"}} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid,$2,$3,$4,$5)`, journalID, e.acct, e.side, commission, agencyID); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return 0, err
	}
	var ruleID *string
	if rule != nil {
		ruleID = &rule.RuleID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent.commissions (booking_id, agency_id, rule_id, amount_poisha, journal_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)
		ON CONFLICT (booking_id) DO NOTHING`,
		bookingID, agencyID, ruleID, commission, journalID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return commission, nil
}

// ------------------------------------------------------------- settlement --

// Settlement is what an operator is owed for a period.
type Settlement struct {
	SettlementID string    `json:"settlement_id"`
	OperatorID   string    `json:"operator_id"`
	Brand        string    `json:"operator"`
	PeriodStart  time.Time `json:"period_start"`
	PeriodEnd    time.Time `json:"period_end"`
	Status       string    `json:"status"`
	Gross        int64     `json:"gross_poisha"`
	Commission   int64     `json:"commission_poisha"`
	Refunds      int64     `json:"refund_poisha"`
	Net          int64     `json:"net_payable_poisha"`
	Bookings     int       `json:"booking_count"`
	Exceptions   int       `json:"open_exceptions"`
}

// OperatorHeldCashChannels are the channels where the operator's own staff take
// the money, so the platform never receives it and must not pay it out again.
//
// A counter is the operator's counter and the drawer is in their office; a
// conductor is their employee and the cash is in his pocket on their bus. The
// passenger has already handed the operator the fare, and a settlement that
// ignores that pays it a second time — not a rounding error, the whole amount.
//
// Everything absent from this list reached the platform: a card payment on the
// website, an agency drawing on a prepaid wallet the platform holds, a partner
// selling through the API. Those the platform owes in full.
//
// One list, one place. A new cash channel is one edit here and not two.
var OperatorHeldCashChannels = []string{"COUNTER", "COUNTER_OFFLINE", "ONBOARD"}

// CalculateSettlement recomputes an operator's payable for a period from the
// bookings themselves. It is safe to re-run: items are replaced wholesale, so
// a late-arriving refund is picked up on the next calculation rather than
// silently missed.
func (s *Service) CalculateSettlement(ctx context.Context, operatorID, from, to string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var id, status string
	err = tx.QueryRow(ctx, `
		INSERT INTO finance.settlements (operator_id, period_start, period_end, status)
		VALUES ($1::uuid, $2::date, $3::date, 'OPEN')
		ON CONFLICT (operator_id, period_start, period_end)
		DO UPDATE SET operator_id = EXCLUDED.operator_id
		RETURNING settlement_id::text, status`, operatorID, from, to).Scan(&id, &status)
	if err != nil {
		return "", err
	}
	// An approved or paid settlement is history. Recalculating it would rewrite
	// a number someone has already signed off.
	if status == "APPROVED" || status == "PAYMENT_INITIATED" || status == "PAID" || status == "RECONCILED" {
		return id, nil
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM finance.settlement_items WHERE settlement_id = $1::uuid`, id); err != nil {
		return "", err
	}

	// Platform commission is 10% of base plus the service fee — the same split
	// the journal posted at sale time, recomputed here from the same inputs.
	//
	// "The same inputs" means the UNDISCOUNTED base, which is what the sale
	// journal used. total_poisha is what the passenger paid; on a discounted
	// on-board sale that is less than the published price, and recomputing the
	// platform's cut from it produced a smaller number than the ledger had
	// already posted — the settlement quietly handing the operator a tenth of
	// every discount a conductor granted. Measured across the demo data before
	// this was fixed: ৳14,781.00 posted, ৳14,350.16 recomputed, ৳430.84 adrift.
	// discount_poisha is 0 for every channel that cannot discount, so this is
	// the same arithmetic as before everywhere else.
	// Three quantities per booking, each anchored to what the ledger already
	// posted at sale and cancellation time:
	//
	//   commission  — the platform's cut on the UNDISCOUNTED base (see above).
	//   refund      — the OPERATOR's share of any refund, not the whole amount.
	//                 applyCancellation claws back only opRefund = refunded ×
	//                 operatorShare / gross from the operator (2101); the rest
	//                 came off platform revenue (4101). Subtracting the whole
	//                 refund here billed the operator for the platform's own
	//                 reversal — a full web refund fabricated an operator debt
	//                 equal to the platform's commission on a booking that
	//                 returned every poisha.
	//   cash        — the cash the operator physically holds, decided by how the
	//                 booking was actually PAID (a CASH payment), NOT by channel.
	//                 A card or MFS sale at a counter reaches the platform's
	//                 gateway exactly like a web sale (CounterPostings debits 1101,
	//                 not the drawer), so the operator holds nothing and must be
	//                 paid in full. Classifying by channel deducted the entire
	//                 fare of every counter card sale, telling the operator it owed
	//                 the platform for money the platform had itself collected.
	//                 Net of any cash refund already paid back out of the drawer.
	if _, err := tx.Exec(ctx, `
		INSERT INTO finance.settlement_items
			(settlement_id, booking_id, gross_poisha, commission_poisha, refund_poisha,
			 cash_collected_poisha, net_poisha)
		SELECT $1::uuid, b.booking_id, b.total_poisha,
		       comm.commission,
		       CASE WHEN b.total_poisha > 0
		            THEN r.refunded * (b.total_poisha - comm.commission) / b.total_poisha
		            ELSE 0 END,
		       CASE WHEN paid.cash THEN b.total_poisha - r.refunded ELSE 0 END,
		       (b.total_poisha - comm.commission)
		         - CASE WHEN b.total_poisha > 0
		                THEN r.refunded * (b.total_poisha - comm.commission) / b.total_poisha
		                ELSE 0 END
		         - CASE WHEN paid.cash THEN b.total_poisha - r.refunded ELSE 0 END
		  FROM commerce.bookings b
		  CROSS JOIN LATERAL (
		        SELECT (((b.total_poisha + b.discount_poisha) - $4::bigint) / 10) + $4::bigint AS commission
		  ) comm
		  LEFT JOIN LATERAL (
		        SELECT COALESCE(sum(rf.amount_poisha),0) AS refunded
		          FROM commerce.refunds rf
		         WHERE rf.booking_id = b.booking_id AND rf.status = 'SUCCESS'
		  ) r ON true
		  CROSS JOIN LATERAL (
		        SELECT EXISTS (SELECT 1 FROM commerce.payments p
		                        WHERE p.booking_id = b.booking_id AND p.status = 'PAID'
		                          AND p.provider = 'CASH') AS cash
		  ) paid
		 WHERE b.operator_id = $2::uuid
		   AND (b.created_at AT TIME ZONE 'Asia/Dhaka')::date >= $3::date
		   AND (b.created_at AT TIME ZONE 'Asia/Dhaka')::date <= $5::date
		   AND b.status IN ('TICKETED','CONFIRMED','COMPLETED','CANCELLED','REFUNDED')
		   AND EXISTS (SELECT 1 FROM commerce.payments p
		                WHERE p.booking_id = b.booking_id AND p.status = 'PAID')`,
		id, operatorID, from, int64(platformServiceFee), to); err != nil {
		return "", err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE finance.settlements s
		   SET gross_poisha          = t.gross,
		       commission_poisha     = t.commission,
		       refund_poisha         = t.refunds,
		       cash_collected_poisha = t.cash,
		       net_payable_poisha    = t.net,
		       booking_count         = t.n,
		       status                = 'CALCULATED',
		       calculated_at         = now()
		  FROM (SELECT COALESCE(sum(gross_poisha),0) gross,
		               COALESCE(sum(commission_poisha),0) commission,
		               COALESCE(sum(refund_poisha),0) refunds,
		               COALESCE(sum(cash_collected_poisha),0) cash,
		               COALESCE(sum(net_poisha),0) net,
		               count(*) n
		          FROM finance.settlement_items WHERE settlement_id = $1::uuid) t
		 WHERE s.settlement_id = $1::uuid`, id); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE commerce.bookings b SET settlement_id = $1::uuid
		   FROM finance.settlement_items i
		  WHERE i.settlement_id = $1::uuid AND i.booking_id = b.booking_id`, id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// SettlementExceptions counts the transactions in a settlement window that do
// not reconcile. There are no exceptions to the exception rule: while this is
// non-zero, the settlement cannot be approved.
func (s *Service) SettlementExceptions(ctx context.Context, settlementID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM finance.settlement_items i
		  JOIN commerce.bookings b ON b.booking_id = i.booking_id
		 WHERE i.settlement_id = $1::uuid
		   AND (
		     -- paid but never ticketed: money in, no seat delivered
		     (b.status = 'PAYMENT_PENDING')
		     -- cancelled with a refund that has not actually settled
		     OR EXISTS (SELECT 1 FROM commerce.refunds r
		                 WHERE r.booking_id = b.booking_id AND r.status IN ('REQUESTED','PROCESSING','FAILED'))
		   )`, settlementID).Scan(&n)
	return n, err
}

// ReviewSettlement is the maker half of maker-checker.
func (s *Service) ReviewSettlement(ctx context.Context, settlementID, staffID string) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE finance.settlements SET status = 'REVIEWED', reviewed_by = $2::uuid
		 WHERE settlement_id = $1::uuid AND status = 'CALCULATED'`, settlementID, staffID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrNotCalculated
	}
	return nil
}

// ApproveSettlement is the checker half. It refuses if the same person
// reviewed it, and refuses while any reconciliation exception is open.
func (s *Service) ApproveSettlement(ctx context.Context, settlementID, staffID string) error {
	// Two sources of exception, both blocking, and both checked here rather than
	// in a handler so that no future caller can reach APPROVED around them.
	//
	// The first is the platform disagreeing with itself — a booking paid but
	// never ticketed, a refund that never settled. The second is the platform
	// disagreeing with the gateway or the bank, which is what the three-way
	// match produces.
	n, err := s.SettlementExceptions(ctx, settlementID)
	if err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("%w: %d internal", ErrOpenException, n)
	}

	var open int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM finance.recon_exceptions e
		  JOIN finance.settlements s ON s.settlement_id = $1::uuid
		 WHERE e.status IN ('OPEN','INVESTIGATING')
		   AND e.business_date BETWEEN s.period_start AND s.period_end`, settlementID).Scan(&open); err != nil {
		return err
	}
	if open > 0 {
		return fmt.Errorf("%w: %d from the three-way match", ErrOpenException, open)
	}

	ct, err := s.pool.Exec(ctx, `
		UPDATE finance.settlements
		   SET status = 'APPROVED', approved_by = $2::uuid, approved_at = now()
		 WHERE settlement_id = $1::uuid AND status = 'REVIEWED'
		   AND (reviewed_by IS NULL OR reviewed_by <> $2::uuid)`, settlementID, staffID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		// Two different refusals wear two different messages. Telling a finance
		// admin "you cannot approve your own work" when the real problem is that
		// nobody has reviewed it yet sends them looking for the wrong colleague.
		var status string
		if e := s.pool.QueryRow(ctx,
			`SELECT status FROM finance.settlements WHERE settlement_id = $1::uuid`,
			settlementID).Scan(&status); e != nil {
			return ErrNotCalculated
		}
		if status != "REVIEWED" {
			return ErrNotReviewed
		}
		return ErrSelfApproval
	}
	return nil
}

// MarkSettlementPaid records the outbound transfer and moves the liability off
// Operator Payable.
func (s *Service) MarkSettlementPaid(ctx context.Context, settlementID, reference string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var net int64
	var operatorID string
	err = tx.QueryRow(ctx, `
		UPDATE finance.settlements
		   SET status = 'PAID', paid_at = now(), payment_ref = $2
		 WHERE settlement_id = $1::uuid AND status = 'APPROVED'
		RETURNING net_payable_poisha, operator_id::text`, settlementID, reference).Scan(&net, &operatorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("settlement is not approved")
	}
	if err != nil {
		return err
	}
	if net > 0 {
		var journalID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO finance.journal_entries (description)
			VALUES ('operator settlement paid ' || $1) RETURNING journal_id::text`, settlementID).
			Scan(&journalID); err != nil {
			return err
		}
		for _, e := range []struct {
			acct, side string
		}{{"2101", "DR"}, {"1001", "CR"}} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
				VALUES ($1::uuid,$2,$3,$4,$5)`, journalID, e.acct, e.side, net, operatorID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

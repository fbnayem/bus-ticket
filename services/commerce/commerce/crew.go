package commerce

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// The on-board channel: a conductor selling a seat on a moving bus.
//
// It contains no seat logic, exactly like the counter and agent channels above
// it. Seats are acquired through the same InventoryClient the website uses and
// confirmed through the same ConfirmHold. What is different here is only two
// things: the cash lands in a pocket rather than a drawer, and the fare may be
// less than the one published.

var (
	ErrDutyNotOpen   = errors.New("commerce: no open duty for this crew member")
	ErrDutyNotYours  = errors.New("commerce: that duty belongs to someone else")
	ErrDutyOpen      = errors.New("commerce: a duty is already open for this crew member")
	ErrDiscountLimit = errors.New("commerce: that discount is larger than the policy allows")
)

// MaxCrewDiscount is the largest discount an on-board sale can carry.
//
// It is the operator's own share of the fare, and it exists because of
// arithmetic rather than policy: the platform's cut is taken off the
// undiscounted base, so once the discount exceeds what is left after that cut,
// the operator's leg of the sale journal turns negative — the operator would be
// paying the platform for the privilege of giving a free ride. That may be a
// real product one day (a staff pass funded by the operator), but it has to be
// a deliberate feature with its own posting, not a side effect of dragging a
// percentage slider to 100.
//
// Every configured cap is bounded by this one. A policy that says 100% is
// honoured up to here and refused above it, with an error that says so.
func MaxCrewDiscount(full int64) int64 {
	base := full - platformServiceFee
	if base <= 0 {
		return 0
	}
	return base - base/10
}

// CrewPostings splits an on-board cash sale.
//
// The discount does not touch platform revenue. That is a decision, not an
// accident: the platform's cut is computed on the base BEFORE the discount, so
// a conductor negotiating at a roadside stop cannot move a number the platform
// reports to anybody. The operator's payable absorbs the discount here, and the
// crew member's own commission hands part of it back — see CrewCommissionPostings.
//
// Expressing the operator leg as (gross - platform) rather than recomputing it
// makes the journal balance by construction: whatever cash came in is exactly
// what is credited out.
func CrewPostings(full, discount int64, operatorID, dutyID string) []Posting {
	base := full - platformServiceFee
	gross := full - discount
	platform := base/10 + platformServiceFee
	return []Posting{
		{"1002", "DR", gross, dutyID},              // Cash in Transit — Crew
		{"4101", "CR", platform, ""},               // Platform Revenue, untouched
		{"2101", "CR", gross - platform, operatorID}, // Operator Payable
	}
}

// CrewCommissionPostings accrues what the crew member earned, and hands the
// operator back whatever the discount cost them.
//
// This is where the owner's decision lives: a discount eats the crew member's
// own commission first, and only the excess falls on the operator. The third
// leg is what makes that true — without it the operator would absorb the whole
// discount in CrewPostings AND the crew would lose commission, charging the
// same reduction twice.
//
// Net effect of a discount D against a rule commission C0:
//
//	platform  unchanged, always
//	crew      loses min(D, C0)
//	operator  loses max(0, D - C0)
//
// The journal balances for every D, including D > C0, where the crew leg is
// zero and Finalise's zero-amount skip drops it.
func CrewCommissionPostings(gross, forfeit int64, staffID, operatorID string) []Posting {
	return []Posting{
		{"5101", "DR", gross, staffID},            // Commission Expense
		{"2103", "CR", gross - forfeit, staffID}, // Crew Payable — what they keep
		{"2101", "CR", forfeit, operatorID},      // handed back to the operator
	}
}

// CrewCommission works out what a sale earns and what a discount costs.
//
// The floor at zero is the whole reason this is a function rather than two
// lines at the call site: however large a discount, a crew member is never
// asked to pay for a sale out of their own pocket. The same floor is a CHECK
// constraint on crew.commissions, because a service can forget it.
func CrewCommission(rule *CommissionRule, base, discount int64) (gross, forfeit, net int64) {
	gross = rule.CommissionFor(base)
	if gross < 0 {
		gross = 0
	}
	forfeit = discount
	if forfeit > gross {
		forfeit = gross
	}
	return gross, forfeit, gross - forfeit
}

// ResolveCrewCommission picks the most specific active rule, by the same
// specificity-beats-priority ordering ResolveCommission uses for agencies.
func (s *Service) ResolveCrewCommission(ctx context.Context, operatorID, routeID, crewRole string) (*CommissionRule, error) {
	var r CommissionRule
	var bp *int
	var amt *int64
	err := s.pool.QueryRow(ctx, `
		SELECT rule_id::text, kind, value_bp, amount_poisha
		  FROM crew.commission_rules
		 WHERE active
		   AND (operator_id IS NULL OR operator_id = $1::uuid)
		   AND (route_id    IS NULL OR route_id    = NULLIF($2,'')::uuid)
		   AND (crew_role   IS NULL OR crew_role   = NULLIF($3,''))
		 ORDER BY (operator_id IS NOT NULL)::int
		        + (route_id    IS NOT NULL)::int
		        + (crew_role   IS NOT NULL)::int DESC,
		          priority DESC
		 LIMIT 1`, operatorID, routeID, crewRole).Scan(&r.RuleID, &r.Kind, &bp, &amt)
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

// CrewSale is what a completed on-board sale is worth to everyone involved.
type CrewSale struct {
	FullPoisha       int64 `json:"full_poisha"`
	DiscountPoisha   int64 `json:"discount_poisha"`
	GrossPoisha      int64 `json:"gross_poisha"`
	CommissionPoisha int64 `json:"commission_poisha"`
	ForfeitPoisha    int64 `json:"forfeit_poisha"`
}

// SettleCrewSale takes the cash, issues the ticket and accrues commission.
//
// Confirmed synchronously for the same reason a counter sale is: the money is
// physically in the conductor's hand and there is no provider to wait for.
//
// Order matches SettleAgentSale — payment, seats, ticket, then commission. If
// the process dies before the commission journal, the passenger still holds a
// valid ticket and the crew member is owed money the report will show as
// missing, which is the recoverable direction to fail in.
func (s *Service) SettleCrewSale(ctx context.Context, bookingID, dutyID, staffID, crewRole string) (CrewSale, error) {
	var out CrewSale
	var operatorID, holdID, status, routeID, tripID string
	var full, discount int64
	err := s.pool.QueryRow(ctx, `
		SELECT b.total_poisha, b.discount_poisha, b.operator_id::text, b.hold_id::text,
		       b.status, t.route_id::text, b.trip_id::text
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		 WHERE b.booking_id = $1::uuid`, bookingID).
		Scan(&out.GrossPoisha, &discount, &operatorID, &holdID, &status, &routeID, &tripID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrBookingNotFound
	}
	if err != nil {
		return out, err
	}
	if status != "PAYMENT_PENDING" {
		return out, ErrAlreadyPaid
	}
	// total_poisha is what the passenger pays; the published price is that plus
	// whatever was taken off it.
	full = out.GrossPoisha + discount
	out.FullPoisha, out.DiscountPoisha = full, discount

	// The structural ceiling, checked again here. The API refuses this before a
	// seat is ever held; this is the second lock, on the door money walks
	// through. Past it the sale journal cannot balance with positive legs.
	if discount > MaxCrewDiscount(full) {
		return out, ErrDiscountLimit
	}

	// One payment per booking: the booking id IS the transaction id, so a
	// double-tap on Take payment collapses to one payment.
	var paymentID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO commerce.payments
			(booking_id, provider, provider_txn_id, amount_poisha, currency, status)
		VALUES ($1::uuid, 'CASH', $1::text, $2, 'BDT', 'PAID')
		ON CONFLICT (provider, provider_txn_id) DO NOTHING
		RETURNING payment_id::text`, bookingID, out.GrossPoisha).Scan(&paymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrAlreadyPaid
	}
	if err != nil {
		return out, err
	}

	if err := s.inv.ConfirmHold(ctx, holdID); err != nil {
		return out, err
	}
	if err := s.Finalise(ctx, bookingID, "on-board cash sale",
		CrewPostings(full, discount, operatorID, dutyID)); err != nil {
		return out, err
	}

	// Cash physically entering the bag, against the duty it belongs to. This is
	// what the end-of-duty count is compared with.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO crew.cash_transactions (duty_id, trip_id, kind, booking_id, amount_poisha, note)
		VALUES ($1::uuid, $2::uuid, 'SALE', $3::uuid, $4, 'on-board sale')`,
		dutyID, tripID, bookingID, out.GrossPoisha); err != nil {
		return out, err
	}

	rule, err := s.ResolveCrewCommission(ctx, operatorID, routeID, crewRole)
	if err != nil {
		return out, err
	}
	base := full - platformServiceFee
	gross, forfeit, net := CrewCommission(rule, base, discount)
	out.CommissionPoisha, out.ForfeitPoisha = net, forfeit
	if gross <= 0 {
		return out, nil
	}

	// Commission is its own balanced journal, as it is for agencies, so it can
	// be reported and disputed without unpicking the sale.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('crew commission ' || $1) RETURNING journal_id::text`, bookingID).Scan(&journalID); err != nil {
		return out, err
	}
	for _, p := range CrewCommissionPostings(gross, forfeit, staffID, operatorID) {
		if p.Amount == 0 {
			continue // a fully forfeited commission has no crew leg
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid,$2,$3,$4,$5)`,
			journalID, p.Account, p.Side, p.Amount, p.Party); err != nil {
			return out, err
		}
	}
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return out, err
	}
	var ruleID *string
	if rule != nil {
		ruleID = &rule.RuleID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO crew.commissions
			(booking_id, staff_id, duty_id, rule_id, gross_amount_poisha, forfeit_poisha, amount_poisha, journal_id)
		VALUES ($1::uuid,$2::uuid,NULLIF($3,'')::uuid,$4::uuid,$5,$6,$7,$8::uuid)
		ON CONFLICT (booking_id) DO NOTHING`,
		bookingID, staffID, dutyID, ruleID, gross, forfeit, net, journalID); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// ------------------------------------------------------------------ duty --

// OpenDuty starts a cash bag.
//
// The unique partial index does the real work: a second open duty for the same
// person is refused by the database, not by this function.
func (s *Service) OpenDuty(ctx context.Context, staffID, operatorID string, float int64) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crew.duties (staff_id, operator_id, opening_float_poisha)
		VALUES ($1::uuid, $2::uuid, $3) RETURNING duty_id::text`,
		staffID, operatorID, float).Scan(&id)
	if err != nil {
		// The partial unique index is the only thing this can realistically
		// collide on, and "you already have one open" is the useful answer.
		var open string
		if s.pool.QueryRow(ctx,
			`SELECT duty_id::text FROM crew.duties WHERE staff_id=$1::uuid AND status='OPEN'`,
			staffID).Scan(&open) == nil && open != "" {
			return open, ErrDutyOpen
		}
		return "", err
	}
	return id, nil
}

// DutyTotals is what a crew member is holding and what of it is theirs.
type DutyTotals struct {
	DutyID           string `json:"duty_id"`
	FloatPoisha      int64  `json:"opening_float_poisha"`
	CollectedPoisha  int64  `json:"collected_poisha"`
	ExpectedPoisha   int64  `json:"expected_cash_poisha"`
	CommissionPoisha int64  `json:"commission_poisha"`
	RemitPoisha      int64  `json:"remit_poisha"`
	Sales            int    `json:"sales_count"`
	DiscountPoisha   int64  `json:"discount_poisha"`
}

// DutySummary computes the three numbers a conductor needs at handover.
//
// Three lines and never one: "hand over ৳4,200" on its own is a number somebody
// has to take on trust. Shown as cash held, minus commission earned, equals
// what the owner gets, it is a sum they can check against the notes in their
// hand.
func (s *Service) DutySummary(ctx context.Context, dutyID string) (DutyTotals, error) {
	t := DutyTotals{DutyID: dutyID}
	err := s.pool.QueryRow(ctx, `
		SELECT d.opening_float_poisha,
		       COALESCE((SELECT sum(amount_poisha) FROM crew.cash_transactions
		                  WHERE duty_id = d.duty_id), 0),
		       COALESCE((SELECT sum(amount_poisha) FROM crew.commissions
		                  WHERE duty_id = d.duty_id), 0),
		       COALESCE((SELECT count(*) FROM commerce.bookings
		                  WHERE duty_id = d.duty_id), 0),
		       COALESCE((SELECT sum(discount_poisha) FROM commerce.bookings
		                  WHERE duty_id = d.duty_id), 0)
		  FROM crew.duties d WHERE d.duty_id = $1::uuid`, dutyID).
		Scan(&t.FloatPoisha, &t.CollectedPoisha, &t.CommissionPoisha, &t.Sales, &t.DiscountPoisha)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrDutyNotOpen
	}
	if err != nil {
		return t, err
	}
	t.ExpectedPoisha = t.FloatPoisha + t.CollectedPoisha
	t.RemitPoisha = t.ExpectedPoisha - t.CommissionPoisha
	return t, nil
}

// CloseDuty counts the bag.
//
// Identical treatment to CloseShift on a counter drawer, down to the variance
// posting: a short bag is an expense, an over bag is a gain, and either way the
// two legs are equal so the books stay balanced.
func (s *Service) CloseDuty(ctx context.Context, dutyID, staffID string, counted int64, note string) (expected, variance int64, status string, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var float int64
	var owner string
	err = tx.QueryRow(ctx, `
		SELECT opening_float_poisha, staff_id::text FROM crew.duties
		 WHERE duty_id = $1::uuid AND status = 'OPEN' FOR UPDATE`, dutyID).Scan(&float, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, "", ErrDutyNotOpen
	}
	if err != nil {
		return 0, 0, "", err
	}
	// Ownership is checked here as well as in the WHERE clause upstairs. A duty
	// is money; two checks is the right number.
	if owner != staffID {
		return 0, 0, "", ErrDutyNotYours
	}

	var movements int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha),0) FROM crew.cash_transactions
		 WHERE duty_id = $1::uuid`, dutyID).Scan(&movements); err != nil {
		return 0, 0, "", err
	}
	expected = float + movements
	variance = counted - expected
	status = "BALANCED"
	if variance != 0 {
		status = "VARIANCE"
	}

	if _, err := tx.Exec(ctx, `
		UPDATE crew.duties
		   SET status = $2, counted_cash_poisha = $3, expected_cash_poisha = $4,
		       variance_poisha = $5, note = NULLIF($6,''), closed_at = now()
		 WHERE duty_id = $1::uuid`,
		dutyID, status, counted, expected, variance, note); err != nil {
		return 0, 0, "", err
	}
	// Any trip still open inside this duty is sealed with it. A duty cannot end
	// with a trip that never got its own numbers.
	if _, err := tx.Exec(ctx, `
		UPDATE crew.duty_trips SET closed_at = now()
		 WHERE duty_id = $1::uuid AND closed_at IS NULL`, dutyID); err != nil {
		return 0, 0, "", err
	}

	if variance != 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO crew.cash_transactions (duty_id, kind, amount_poisha, note)
			VALUES ($1::uuid, 'WRITEDOWN', $2, 'duty close variance')`,
			dutyID, variance); err != nil {
			return 0, 0, "", err
		}
		var journalID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO finance.journal_entries (description)
			VALUES ('crew duty variance ' || $1) RETURNING journal_id::text`, dutyID).
			Scan(&journalID); err != nil {
			return 0, 0, "", err
		}
		drSide, crSide := "DR", "CR"
		amount := variance
		if variance < 0 {
			amount = -variance
		} else {
			drSide, crSide = "CR", "DR"
		}
		for _, e := range []struct{ acct, side string }{{"5301", drSide}, {"1002", crSide}} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
				VALUES ($1::uuid,$2,$3,$4,$5)`, journalID, e.acct, e.side, amount, dutyID); err != nil {
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

// CloseDutyTrip seals one bus run inside a duty.
//
// A snapshot, not a count. The conductor counts money once at the end of the
// day; this is what lets a dispute about the 22:00 run be answered with that
// run's own numbers rather than the day's.
func (s *Service) CloseDutyTrip(ctx context.Context, dutyID, tripID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crew.duty_trips
			(duty_id, trip_id, sales_count, gross_poisha, discount_poisha, commission_poisha, closed_at)
		SELECT $1::uuid, $2::uuid,
		       COALESCE(count(b.booking_id), 0),
		       COALESCE(sum(b.total_poisha), 0),
		       COALESCE(sum(b.discount_poisha), 0),
		       COALESCE((SELECT sum(c.amount_poisha) FROM crew.commissions c
		                   JOIN commerce.bookings cb ON cb.booking_id = c.booking_id
		                  WHERE c.duty_id = $1::uuid AND cb.trip_id = $2::uuid), 0),
		       now()
		  FROM commerce.bookings b
		 WHERE b.duty_id = $1::uuid AND b.trip_id = $2::uuid
		ON CONFLICT (duty_id, trip_id) DO UPDATE SET
			sales_count       = EXCLUDED.sales_count,
			gross_poisha      = EXCLUDED.gross_poisha,
			discount_poisha   = EXCLUDED.discount_poisha,
			commission_poisha = EXCLUDED.commission_poisha,
			closed_at         = now()`, dutyID, tripID)
	return err
}

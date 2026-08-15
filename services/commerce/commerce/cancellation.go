package commerce

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrNotCancellable = errors.New("commerce: booking is not in a cancellable state")
	ErrDeparted       = errors.New("commerce: trip has already departed")
)

// CancellationQuote is what the passenger sees before confirming. It is derived
// from the policy tiers, never hardcoded in the UI.
type CancellationQuote struct {
	PNR          string    `json:"pnr"`
	TotalPoisha  int64     `json:"total_poisha"`
	DepartAt     time.Time `json:"depart_at"`
	HoursBefore  float64   `json:"hours_before"`
	RefundPct    int       `json:"refund_pct"`
	RefundPoisha int64     `json:"refund_poisha"`
	FeePoisha    int64     `json:"fee_poisha"`
	Cancellable  bool      `json:"cancellable"`
	Reason       string    `json:"reason,omitempty"`
}

// QuoteCancellation resolves the applicable policy tier for a booking.
//
// Tiers are stored in commerce.cancellation_policies and resolved
// most-specific-first (operator > route > channel > platform default), then by
// the largest min_hours the booking still satisfies. Changing refund terms is a
// data change, not a deploy.
func (s *Service) QuoteCancellation(ctx context.Context, pnr string) (*CancellationQuote, error) {
	var (
		q          CancellationQuote
		status     string
		operatorID string
		routeID    string
		channel    string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT b.pnr, b.total_poisha, b.status, b.operator_id::text,
		       t.route_id::text, b.channel, t.depart_at
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		 WHERE b.pnr = $1`, pnr).
		Scan(&q.PNR, &q.TotalPoisha, &status, &operatorID, &routeID, &channel, &q.DepartAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrBookingNotFound
	}
	if err != nil {
		return nil, err
	}

	q.HoursBefore = time.Until(q.DepartAt).Hours()

	switch {
	case status != "TICKETED" && status != "CONFIRMED":
		q.Reason = fmt.Sprintf("booking is %s", status)
		return &q, nil
	case q.HoursBefore <= 0:
		q.Reason = "the bus has already departed"
		return &q, nil
	}

	// Most specific matching tier wins.
	err = s.pool.QueryRow(ctx, `
		SELECT refund_pct FROM commerce.cancellation_policies
		 WHERE (operator_id IS NULL OR operator_id = $1::uuid)
		   AND (route_id    IS NULL OR route_id    = $2::uuid)
		   AND (channel     IS NULL OR channel     = $3)
		   AND min_hours <= $4
		 ORDER BY priority DESC,
		          (operator_id IS NOT NULL)::int + (route_id IS NOT NULL)::int + (channel IS NOT NULL)::int DESC,
		          min_hours DESC
		 LIMIT 1`, operatorID, routeID, channel, q.HoursBefore).Scan(&q.RefundPct)
	if errors.Is(err, pgx.ErrNoRows) {
		q.RefundPct = 0
	} else if err != nil {
		return nil, err
	}

	q.RefundPoisha = q.TotalPoisha * int64(q.RefundPct) / 100
	q.FeePoisha = q.TotalPoisha - q.RefundPoisha
	q.Cancellable = true
	return &q, nil
}

// CancelBooking performs the cancellation: it frees the seats, records the
// cancellation and refund, and moves the money through the ledger.
//
// Refunds go THROUGH the ledger (Refund Payable), never around it. There is no
// path in this codebase that calls a gateway refund without a posted journal.
func (s *Service) CancelBooking(ctx context.Context, pnr, reason string) (*CancellationQuote, error) {
	q, err := s.QuoteCancellation(ctx, pnr)
	if err != nil {
		return nil, err
	}
	if !q.Cancellable {
		if q.HoursBefore <= 0 {
			return nil, ErrDeparted
		}
		return nil, ErrNotCancellable
	}

	var bookingID, holdID, operatorID string
	var gross int64
	if err := s.pool.QueryRow(ctx, `
		SELECT booking_id::text, hold_id::text, operator_id::text, total_poisha
		  FROM commerce.bookings WHERE pnr = $1`, pnr).
		Scan(&bookingID, &holdID, &operatorID, &gross); err != nil {
		return nil, err
	}

	// Seats first: the passenger has decided, so the seat should become
	// available to someone else immediately rather than at departure.
	if err := s.inv.ReleaseConfirmed(ctx, holdID, "CANCELLED"); err != nil {
		return nil, fmt.Errorf("release seats: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var cancellationID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO commerce.cancellations
			(booking_id, hours_before, refund_pct, refund_poisha, reason)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING cancellation_id::text`,
		bookingID, q.HoursBefore, q.RefundPct, q.RefundPoisha, reason).Scan(&cancellationID); err != nil {
		return nil, err
	}

	var paymentID *string
	var pid string
	if err := tx.QueryRow(ctx,
		`SELECT payment_id::text FROM commerce.payments
		  WHERE booking_id = $1::uuid AND status = 'PAID' LIMIT 1`, bookingID).Scan(&pid); err == nil {
		paymentID = &pid
	}

	// ---- ledger: recognise the refund liability --------------------------
	// The refund is split back across the parties in the same proportion the
	// original sale credited them, so neither the operator nor the platform
	// absorbs the whole cancellation.
	serviceFee := int64(5000)
	base := gross - serviceFee
	commission := base / 10
	operatorShare := base - commission
	platformShare := commission + serviceFee

	var journalID string
	if q.RefundPoisha > 0 {
		if err := tx.QueryRow(ctx, `
			INSERT INTO finance.journal_entries (description)
			VALUES ('cancellation refund ' || $1) RETURNING journal_id::text`, pnr).Scan(&journalID); err != nil {
			return nil, err
		}
		opRefund := q.RefundPoisha * operatorShare / gross
		platRefund := q.RefundPoisha - opRefund // remainder absorbs rounding
		_ = platformShare

		post := func(account, side string, amount int64, party string) error {
			if amount == 0 {
				return nil
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
				VALUES ($1::uuid, $2, $3, $4, $5)`, journalID, account, side, amount, party)
			return err
		}
		if err := post("2101", "DR", opRefund, operatorID); err != nil { // claw back operator payable
			return nil, err
		}
		if err := post("4101", "DR", platRefund, ""); err != nil { // reverse platform revenue
			return nil, err
		}
		if err := post("2201", "CR", q.RefundPoisha, pnr); err != nil { // we now owe the passenger
			return nil, err
		}
		if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
			return nil, err
		}
	}

	var refundStatus = "REQUESTED"
	if q.RefundPoisha == 0 {
		refundStatus = "REJECTED"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.refunds
			(cancellation_id, booking_id, payment_id, amount_poisha, status, journal_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULLIF($6,'')::uuid)`,
		cancellationID, bookingID, paymentID, q.RefundPoisha, refundStatus, journalID); err != nil {
		return nil, err
	}

	newStatus := "CANCELLED"
	if q.RefundPoisha > 0 {
		newStatus = "REFUND_PENDING"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.bookings SET status = $2, updated_at = now() WHERE booking_id = $1::uuid`,
		bookingID, newStatus); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.booking_status_history (booking_id, from_status, to_status, reason)
		VALUES ($1::uuid, 'TICKETED', $2, $3)`, bookingID, newStatus, reason); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.tickets SET status = 'CANCELLED' WHERE booking_id = $1::uuid`, bookingID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'booking.cancelled', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'operator_id', $3::text,
			'refund_poisha', $4::bigint, 'amount_poisha', $4::bigint, 'reason', $5::text))`,
		bookingID, pnr, operatorID, q.RefundPoisha, reason); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return q, nil
}

// SettleRefund moves a REQUESTED refund to SUCCESS and discharges the liability.
// In production this is driven by the provider's refund callback; here it lets
// the web app show the full refund lifecycle.
func (s *Service) SettleRefund(ctx context.Context, pnr string) error {
	var refundID, bookingID string
	var amount int64
	err := s.pool.QueryRow(ctx, `
		SELECT r.refund_id::text, r.booking_id::text, r.amount_poisha
		  FROM commerce.refunds r JOIN commerce.bookings b USING (booking_id)
		 WHERE b.pnr = $1 AND r.status = 'REQUESTED' LIMIT 1`, pnr).
		Scan(&refundID, &bookingID, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // nothing outstanding — idempotent
	}
	if err != nil {
		return err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('refund settled ' || $1) RETURNING journal_id::text`, pnr).Scan(&journalID); err != nil {
		return err
	}
	for _, e := range []struct {
		acct, side string
		amt        int64
	}{
		{"2201", "DR", amount}, // discharge Refund Payable
		{"1101", "CR", amount}, // money leaves Gateway Clearing
	} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid, $2, $3, $4, $5)`, journalID, e.acct, e.side, e.amt, pnr); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.refunds SET status='SUCCESS', updated_at=now() WHERE refund_id=$1::uuid`,
		refundID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.bookings SET status='REFUNDED', updated_at=now() WHERE booking_id=$1::uuid`,
		bookingID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'refund.completed', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'amount_poisha', $3::bigint,
			'refund_poisha', $3::bigint,
			'operator_id', (SELECT operator_id::text FROM commerce.bookings WHERE booking_id = $1::uuid)))`,
		bookingID, pnr, amount); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

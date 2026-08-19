package commerce

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrNotCancellable    = errors.New("commerce: booking is not in a cancellable state")
	ErrDeparted          = errors.New("commerce: trip has already departed")
	ErrRefundExceedsPaid = errors.New("commerce: refund exceeds the amount paid")
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

	ref, err := s.loadBookingRef(ctx, pnr)
	if err != nil {
		return nil, err
	}
	if err := s.applyCancellation(ctx, ref, q.RefundPct, q.RefundPoisha, q.HoursBefore, reason, true); err != nil {
		return nil, err
	}
	return q, nil
}

// bookingRef is the minimal identity the cancellation core needs to refund one
// booking. Both the passenger policy path and an operator trip cancellation load
// one and hand it to applyCancellation.
type bookingRef struct {
	bookingID, pnr, holdID, operatorID, status string
	gross                                      int64
}

func (s *Service) loadBookingRef(ctx context.Context, pnr string) (bookingRef, error) {
	b := bookingRef{pnr: pnr}
	err := s.pool.QueryRow(ctx, `
		SELECT booking_id::text, hold_id::text, operator_id::text, status, total_poisha
		  FROM commerce.bookings WHERE pnr = $1`, pnr).
		Scan(&b.bookingID, &b.holdID, &b.operatorID, &b.status, &b.gross)
	return b, err
}

// applyCancellation releases the seats and, inside one transaction, records the
// cancellation and refund, posts the split refund journal, and flips the booking
// and its tickets to a cancelled state. The refund amount is decided by the
// caller — the passenger policy path passes a tiered amount, an operator trip
// cancellation passes the full fare — so one audited code path serves both.
//
// emitBookingEvent controls the per-booking booking.cancelled notice. A trip
// cancellation keeps it true so each passenger still learns their exact refund
// by PNR; the single trip.cancelled event the trip path emits afterwards is left
// to drive the search index and the control-room alert, and finds no passengers
// of its own to re-notify because these bookings are already cancelled by then.
func (s *Service) applyCancellation(ctx context.Context, b bookingRef, refundPct int, refundPoisha int64, hoursBefore float64, reason string, emitBookingEvent bool) error {
	// Seats first: the passenger's fate is decided, so the seat should become
	// available to someone else immediately rather than at departure.
	if err := s.inv.ReleaseConfirmed(ctx, b.holdID, "CANCELLED"); err != nil {
		return fmt.Errorf("release seats: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Serialise concurrent cancellations of the SAME booking. The caller checked
	// the status before this call, but that is a time-of-check-to-time-of-use
	// read: under a race — a double click, a retry storm, two agents — every
	// request passes that check before any of them writes. Locking the row and
	// re-reading its status INSIDE the transaction makes the first cancellation
	// win; the rest block here, then see the already-cancelled status and abort.
	// Without it, N concurrent refunds each post a balanced refund journal and pay
	// out N times, and the trial balance stays zero — so nothing catches it.
	var liveStatus string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM commerce.bookings WHERE booking_id=$1::uuid FOR UPDATE`,
		b.bookingID).Scan(&liveStatus); err != nil {
		return err
	}
	if liveStatus != "TICKETED" && liveStatus != "CONFIRMED" && liveStatus != "PAID" {
		return ErrNotCancellable
	}

	var cancellationID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO commerce.cancellations
			(booking_id, hours_before, refund_pct, refund_poisha, reason)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING cancellation_id::text`,
		b.bookingID, hoursBefore, refundPct, refundPoisha, reason).Scan(&cancellationID); err != nil {
		return err
	}

	var paymentID *string
	var pid string
	if err := tx.QueryRow(ctx,
		`SELECT payment_id::text FROM commerce.payments
		  WHERE booking_id = $1::uuid AND status = 'PAID' LIMIT 1`, b.bookingID).Scan(&pid); err == nil {
		paymentID = &pid
	}

	// ---- ledger: recognise the refund liability --------------------------
	// The refund is split back across the parties in the same proportion the
	// original sale credited them, so neither the operator nor the platform
	// absorbs the whole cancellation.
	serviceFee := int64(5000)
	base := b.gross - serviceFee
	commission := base / 10
	operatorShare := base - commission
	platformShare := commission + serviceFee

	var journalID string
	if refundPoisha > 0 {
		if err := tx.QueryRow(ctx, `
			INSERT INTO finance.journal_entries (description)
			VALUES ('cancellation refund ' || $1) RETURNING journal_id::text`, b.pnr).Scan(&journalID); err != nil {
			return err
		}
		opRefund := refundPoisha * operatorShare / b.gross
		platRefund := refundPoisha - opRefund // remainder absorbs rounding
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
		if err := post("2101", "DR", opRefund, b.operatorID); err != nil { // claw back operator payable
			return err
		}
		if err := post("4101", "DR", platRefund, ""); err != nil { // reverse platform revenue
			return err
		}
		if err := post("2201", "CR", refundPoisha, b.pnr); err != nil { // we now owe the passenger
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
			return err
		}
	}

	var refundStatus = "REQUESTED"
	if refundPoisha == 0 {
		refundStatus = "REJECTED"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.refunds
			(cancellation_id, booking_id, payment_id, amount_poisha, status, journal_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULLIF($6,'')::uuid)`,
		cancellationID, b.bookingID, paymentID, refundPoisha, refundStatus, journalID); err != nil {
		return err
	}

	newStatus := "CANCELLED"
	if refundPoisha > 0 {
		newStatus = "REFUND_PENDING"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.bookings SET status = $2, updated_at = now() WHERE booking_id = $1::uuid`,
		b.bookingID, newStatus); err != nil {
		return err
	}
	fromStatus := b.status
	if fromStatus == "" {
		fromStatus = "TICKETED"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.booking_status_history (booking_id, from_status, to_status, reason)
		VALUES ($1::uuid, $2, $3, $4)`, b.bookingID, fromStatus, newStatus, reason); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.tickets SET status = 'CANCELLED' WHERE booking_id = $1::uuid`, b.bookingID); err != nil {
		return err
	}
	if emitBookingEvent {
		if _, err := tx.Exec(ctx, `
			INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
			VALUES ($1::uuid, 'booking.cancelled', jsonb_build_object(
				'pnr', $2::text, 'booking_id', $1::text, 'operator_id', $3::text,
				'refund_poisha', $4::bigint, 'amount_poisha', $4::bigint, 'reason', $5::text))`,
			b.bookingID, b.pnr, b.operatorID, refundPoisha, reason); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// TripCancellation summarises what cancelling a whole trip did: how many live
// bookings were refunded and the total put back into passengers' hands.
type TripCancellation struct {
	TripID            string `json:"trip_id"`
	Reason            string `json:"reason"`
	BookingsCancelled int    `json:"bookings_cancelled"`
	RefundPoisha      int64  `json:"refund_poisha"`
}

// CancelTrip cancels every live booking on a trip and then the trip itself.
//
// An operator cancels a trip when the bus cannot run, so every passenger is
// refunded in full — the tiered policy that governs a passenger changing their
// own mind does not apply when the failure is the operator's. Each booking is
// refunded in its own transaction and already-cancelled bookings are skipped, so
// a run interrupted halfway can be repeated and only finishes what is left.
func (s *Service) CancelTrip(ctx context.Context, tripID, reason string) (*TripCancellation, error) {
	if reason == "" {
		reason = "trip cancelled by operator"
	}

	rows, err := s.pool.Query(ctx, `
		SELECT pnr FROM commerce.bookings
		 WHERE trip_id = $1::uuid AND status IN ('CONFIRMED','TICKETED')
		 ORDER BY created_at`, tripID)
	if err != nil {
		return nil, err
	}
	var pnrs []string
	for rows.Next() {
		var pnr string
		if err := rows.Scan(&pnr); err != nil {
			rows.Close()
			return nil, err
		}
		pnrs = append(pnrs, pnr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := &TripCancellation{TripID: tripID, Reason: reason}
	for _, pnr := range pnrs {
		ref, err := s.loadBookingRef(ctx, pnr)
		if err != nil {
			return out, err
		}
		refund := ref.gross // full fare back — the operator cancelled, not the passenger
		if err := s.applyCancellation(ctx, ref, 100, refund, 0, reason, true); err != nil {
			return out, fmt.Errorf("refund %s: %w", pnr, err)
		}
		out.BookingsCancelled++
		out.RefundPoisha += refund
	}

	// Flip the trip and announce it once. By now every booking is cancelled, so
	// this event drives the search index and the control-room alert; its own
	// passenger fan-out is empty and no one is texted twice.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx,
		`UPDATE catalog.trips SET status='CANCELLED' WHERE trip_id=$1::uuid`, tripID); err != nil {
		return out, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'trip.cancelled', jsonb_build_object(
			'trip_id', $1::text, 'reason', $2::text,
			'bookings_cancelled', $3::int, 'refund_poisha', $4::bigint))`,
		tripID, reason, out.BookingsCancelled, out.RefundPoisha); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// SettleRefundCash discharges a REQUESTED refund as CASH from a counter drawer
// instead of back through the payment gateway. It is the counter twin of
// SettleRefund, differing in exactly two places, and both matter. The money
// leaves 1001 Cash rather than 1101 Gateway Clearing, because the taka is
// physically coming out of a drawer. And a matching NEGATIVE movement is written
// into that shift's cash log, so the close-of-shift count — float plus the sum of
// movements — falls by exactly the refund. Without that second part the drawer
// would read over by the refunded amount at close, and a clerk would be flagged
// for a discrepancy they never caused by correctly handing money back.
//
// It returns the amount refunded, and is idempotent: a second call finds no
// REQUESTED refund and does nothing.
func (s *Service) SettleRefundCash(ctx context.Context, pnr, shiftID string) (int64, error) {
	var refundID, bookingID string
	var amount int64
	err := s.pool.QueryRow(ctx, `
		SELECT r.refund_id::text, r.booking_id::text, r.amount_poisha
		  FROM commerce.refunds r JOIN commerce.bookings b USING (booking_id)
		 WHERE b.pnr = $1 AND r.status = 'REQUESTED' LIMIT 1`, pnr).
		Scan(&refundID, &bookingID, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil // nothing outstanding — idempotent
	}
	if err != nil {
		return 0, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock the refund row and re-check it is still REQUESTED inside the tx. The
	// read above is unlocked, so two concurrent callers (an office retry, a
	// double click) can both see the same REQUESTED refund; without this the
	// drawer pays out twice and the shift closes short. The first to arrive wins,
	// the rest find SUCCESS and no-op. Same discipline as applyCancellation.
	var liveStatus string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM commerce.refunds WHERE refund_id=$1::uuid FOR UPDATE`,
		refundID).Scan(&liveStatus); err != nil {
		return 0, err
	}
	if liveStatus != "REQUESTED" {
		return 0, nil // already settled by a concurrent caller — idempotent
	}

	// The drawer the cash comes from must be open; the lock also fixes which
	// counter the movement is attributed to.
	var counterID string
	err = tx.QueryRow(ctx, `
		SELECT counter_id::text FROM counter.shifts
		 WHERE shift_id = $1::uuid AND status = 'OPEN' FOR UPDATE`, shiftID).Scan(&counterID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrShiftNotOpen
	}
	if err != nil {
		return 0, err
	}

	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('counter refund ' || $1) RETURNING journal_id::text`, pnr).Scan(&journalID); err != nil {
		return 0, err
	}
	for _, e := range []struct {
		acct, side, party string
		amt               int64
	}{
		{"2201", "DR", pnr, amount},       // discharge Refund Payable
		{"1001", "CR", counterID, amount}, // cash leaves the drawer
	} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid, $2, $3, $4, $5)`, journalID, e.acct, e.side, e.amt, e.party); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return 0, err
	}

	// The cash-log movement is negative: money is leaving the drawer, so the
	// expected close figure (float + sum of movements) is reduced by the refund.
	if _, err := tx.Exec(ctx, `
		INSERT INTO counter.cash_transactions (shift_id, kind, method, booking_id, amount_poisha, note)
		VALUES ($1::uuid, 'REFUND', 'CASH', $2::uuid, $3, 'ticket refund ' || $4)`,
		shiftID, bookingID, -amount, pnr); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.refunds SET status='SUCCESS', updated_at=now() WHERE refund_id=$1::uuid`,
		refundID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE commerce.bookings SET status='REFUNDED', updated_at=now() WHERE booking_id=$1::uuid`,
		bookingID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'refund.completed', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'amount_poisha', $3::bigint,
			'refund_poisha', $3::bigint,
			'operator_id', (SELECT operator_id::text FROM commerce.bookings WHERE booking_id = $1::uuid)))`,
		bookingID, pnr, amount); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return amount, nil
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

	// Lock the refund and re-check it is still REQUESTED inside the tx. Gateway
	// refund callbacks are retried and delivered concurrently; the unlocked read
	// above lets two of them both reach the posting below. Without this guard the
	// gateway is credited twice (1101 CR twice) and the passenger is paid back
	// twice, while each journal balances so the trial balance never catches it.
	var liveStatus string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM commerce.refunds WHERE refund_id=$1::uuid FOR UPDATE`,
		refundID).Scan(&liveStatus); err != nil {
		return err
	}
	if liveStatus != "REQUESTED" {
		return nil // already settled by a concurrent caller — idempotent
	}

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

// SupportRefund lets the support console act on a passenger's behalf: cancel the
// booking and settle the refund back through the gateway it came from. With
// overridePoisha <= 0 the cancellation policy decides the amount, exactly as the
// passenger's own self-service does; with a positive override it becomes a
// goodwill refund of a chosen amount — which is the one thing support can do that
// the passenger cannot, and the reason this path exists at all.
//
// The override can never exceed what was actually paid: refunding more than the
// fare is not goodwill, it is a cash leak, and it is refused here rather than in
// the caller so the guarantee holds no matter who calls.
func (s *Service) SupportRefund(ctx context.Context, pnr string, overridePoisha int64, reason string) (int64, error) {
	ref, err := s.loadBookingRef(ctx, pnr)
	if err != nil {
		return 0, err
	}
	amount := overridePoisha
	pct := 100
	if overridePoisha <= 0 {
		q, qerr := s.QuoteCancellation(ctx, pnr)
		if qerr != nil {
			return 0, qerr
		}
		amount, pct = q.RefundPoisha, q.RefundPct
	} else {
		if overridePoisha > ref.gross {
			return 0, ErrRefundExceedsPaid
		}
		if ref.gross > 0 {
			pct = int(overridePoisha * 100 / ref.gross)
		}
	}
	if err := s.applyCancellation(ctx, ref, pct, amount, 0, reason, true); err != nil {
		return 0, err
	}
	if amount > 0 {
		if err := s.SettleRefund(ctx, pnr); err != nil {
			return amount, err
		}
	}
	return amount, nil
}

// ResendConfirmation re-emits the booking.confirmed event so the passenger is
// notified again — the "I never got my ticket" resolution. It is a fresh event,
// so it carries a new event id and is NOT de-duplicated against the original
// send; the notify pipeline delivers it exactly as it delivered the first.
func (s *Service) ResendConfirmation(ctx context.Context, pnr string) error {
	var bookingID, tripID, operatorID, channel string
	var total int64
	if err := s.pool.QueryRow(ctx, `
		SELECT booking_id::text, trip_id::text, operator_id::text, channel, total_poisha
		  FROM commerce.bookings WHERE pnr = upper($1)`, pnr).
		Scan(&bookingID, &tripID, &operatorID, &channel, &total); err != nil {
		return err
	}
	var seatCount int
	_ = s.pool.QueryRow(ctx,
		`SELECT count(*) FROM commerce.booking_seats WHERE booking_id=$1::uuid`, bookingID).Scan(&seatCount)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'booking.confirmed', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'trip_id', $3::text,
			'operator_id', $4::text, 'channel', $5::text,
			'total_poisha', $6::bigint, 'seat_count', $7::int,
			'route', (SELECT rt.name FROM catalog.trips t
			            JOIN catalog.routes rt ON rt.route_id = t.route_id
			           WHERE t.trip_id = $3::uuid),
			'resend', true))`,
		bookingID, pnr, tripID, operatorID, channel, total, seatCount)
	return err
}

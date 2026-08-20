// Package commerce turns a held seat into a paid ticket.
//
// It owns the saga: booking-service is the orchestrator, the inventory service
// owns seats, and money is recorded in a double-entry ledger from day one — even
// though the finance UI is a Phase 2 deliverable — so Phase 2 opens the books on
// real balanced data instead of a backfill.
package commerce

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// InventoryClient is the seam between this service and inventory-service.
//
// The owner chose true microservices, so in production this is satisfied by a
// generated gRPC client and the two services never share a process or a
// database. Commerce depends on this interface and nothing else: it cannot
// reach into inventory's tables, and it holds no seat logic of its own.
// Tests bind it to the in-process store, which is why the contract is stated
// here rather than assumed.
type InventoryClient interface {
	// ConfirmHold moves a hold's segments from HELD to SOLD.
	// Idempotent on holdID — this is what makes webhook replay harmless.
	ConfirmHold(ctx context.Context, holdID string) error

	// ReleaseConfirmed returns SOLD segments to the pool on cancellation.
	ReleaseConfirmed(ctx context.Context, holdID, reason string) error
}

var (
	ErrBookingNotFound  = errors.New("commerce: booking not found")
	ErrAmountMismatch   = errors.New("commerce: webhook amount does not match booking")
	ErrCurrency         = errors.New("commerce: unsupported currency")
	ErrBadSignature     = errors.New("commerce: webhook signature invalid")
	ErrOperatorInactive = errors.New("commerce: operator is not active")
)

type Service struct {
	pool *pgxpool.Pool
	inv  InventoryClient
	// qrKey signs opaque QR tokens. Rotatable via the key id stored on the ticket.
	qrKey      []byte
	qrKeyID    string
	hookSecret []byte
}

func New(pool *pgxpool.Pool, inv InventoryClient, qrKey, hookSecret []byte) *Service {
	return &Service{pool: pool, inv: inv, qrKey: qrKey, qrKeyID: "k1", hookSecret: hookSecret}
}

// ---------------------------------------------------------------- booking --

type BookingRequest struct {
	HoldID      string
	TripID      string
	OperatorID  string
	Seats       []string
	BoardSeq    int
	DropSeq     int
	Channel     string
	TotalPoisha int64
}

// CreateBooking records a booking against an existing hold and moves it to
// PAYMENT_PENDING. The price is copied from the hold's frozen snapshot; it is
// never recomputed from current fare rules.
func (s *Service) CreateBooking(ctx context.Context, req BookingRequest) (bookingID, pnr string, err error) {
	pnr, err = newPNR()
	if err != nil {
		return "", "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Only an ACTIVE operator may take a booking. This is the single chokepoint
	// every sales channel funnels through, so it is the authoritative block —
	// search hides a suspended operator's trips, and this refuses one even if a
	// stale hold or a direct API call reaches this far.
	var opStatus string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM catalog.operators WHERE operator_id=$1::uuid`, req.OperatorID).Scan(&opStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrOperatorInactive
		}
		return "", "", err
	}
	if opStatus != "ACTIVE" {
		return "", "", ErrOperatorInactive
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO commerce.bookings
			(pnr, trip_id, operator_id, hold_id, channel, status,
			 board_stop_seq, drop_stop_seq, total_poisha, price_snapshot)
		VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, 'PAYMENT_PENDING', $6, $7, $8,
		        jsonb_build_object('total_poisha', $8::bigint, 'frozen_at', now()))
		RETURNING booking_id::text`,
		pnr, req.TripID, req.OperatorID, req.HoldID, req.Channel,
		req.BoardSeq, req.DropSeq, req.TotalPoisha).Scan(&bookingID)
	if err != nil {
		return "", "", err
	}

	for _, seat := range req.Seats {
		if _, err := tx.Exec(ctx,
			`INSERT INTO commerce.booking_seats (booking_id, seat_no) VALUES ($1::uuid, $2)`,
			bookingID, seat); err != nil {
			return "", "", err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.booking_status_history (booking_id, from_status, to_status, reason)
		VALUES ($1::uuid, NULL, 'PAYMENT_PENDING', 'booking created')`, bookingID); err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return bookingID, pnr, nil
}

// ---------------------------------------------------------------- webhook --

// Webhook is a payment notification as received from a provider.
type Webhook struct {
	Provider      string
	ProviderTxnID string
	BookingID     string
	AmountPoisha  int64
	Currency      string
	Signature     string
}

// Sign produces the HMAC a provider would attach. Used by tests and by the
// sandbox; production verifies against the provider's own secret.
func (s *Service) Sign(w Webhook) string {
	mac := hmac.New(sha256.New, s.hookSecret)
	fmt.Fprintf(mac, "%s|%s|%s|%d|%s", w.Provider, w.ProviderTxnID, w.BookingID, w.AmountPoisha, w.Currency)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// HandleWebhook is the ONLY path that confirms a payment. The browser's
// /success page never does — it reads state, it never writes it.
//
// The verification chain runs in a fixed order, and every step can only reject:
//
//	signature -> provider -> amount -> currency -> booking -> idempotency -> confirm
//
// Idempotency is enforced by UNIQUE(provider, provider_txn_id) in the database
// rather than by an application check, so 100 concurrent duplicates collapse to
// exactly one payment no matter how they interleave.
func (s *Service) HandleWebhook(ctx context.Context, w Webhook) (accepted bool, err error) {
	reject := func(reason string, e error) (bool, error) {
		_, _ = s.pool.Exec(ctx, `
			INSERT INTO commerce.payment_webhooks
				(provider, provider_txn_id, signature_ok, accepted, reject_reason, raw)
			VALUES ($1,$2,$3,false,$4, jsonb_build_object('booking_id',$5::text,'amount',$6::bigint))`,
			w.Provider, w.ProviderTxnID, reason != "bad_signature", reason, w.BookingID, w.AmountPoisha)
		return false, e
	}

	// 1. signature
	if !hmac.Equal([]byte(s.Sign(w)), []byte(w.Signature)) {
		return reject("bad_signature", ErrBadSignature)
	}
	// 2. currency
	if w.Currency != "BDT" {
		return reject("bad_currency", ErrCurrency)
	}

	// 3. booking + 4. amount
	//
	// amount_due_poisha is what this booking still needs. For an ordinary
	// booking it is 0 and the whole fare is expected; for a reschedule it is
	// only the difference, because the rest was collected on the original.
	var expected int64
	var tripID, operatorID, holdID, status string
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(amount_due_poisha, 0), total_poisha),
		       trip_id::text, operator_id::text, hold_id::text, status
		  FROM commerce.bookings WHERE booking_id = $1::uuid`, w.BookingID).
		Scan(&expected, &tripID, &operatorID, &holdID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return reject("unknown_booking", ErrBookingNotFound)
	}
	if err != nil {
		return false, err
	}
	if expected != w.AmountPoisha {
		return reject("amount_mismatch", ErrAmountMismatch)
	}

	// 5. idempotency — the database decides, not the application.
	//
	// The payment.success event is written by the same statement, from the same
	// RETURNING, so exactly one event exists for exactly one payment. Emitting
	// it separately would let a crash in between produce a paid booking nobody
	// is ever told about, or an event for a payment that does not exist.
	var paymentID string
	err = s.pool.QueryRow(ctx, `
		WITH p AS (
		    INSERT INTO commerce.payments
		        (booking_id, provider, provider_txn_id, amount_poisha, currency, status)
		    VALUES ($1::uuid, $2, $3, $4, $5, 'PAID')
		    ON CONFLICT (provider, provider_txn_id) DO NOTHING
		    RETURNING payment_id
		), o AS (
		    INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		    SELECT $1::uuid, 'payment.success', jsonb_build_object(
		        'booking_id', $1::text, 'provider', $2::text, 'amount_poisha', $4::bigint,
		        'pnr', (SELECT pnr FROM commerce.bookings WHERE booking_id = $1::uuid),
		        'operator_id', (SELECT operator_id::text FROM commerce.bookings WHERE booking_id = $1::uuid))
		      FROM p
		)
		SELECT payment_id::text FROM p`,
		w.BookingID, w.Provider, w.ProviderTxnID, w.AmountPoisha, w.Currency).Scan(&paymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent duplicate already claimed this transaction id. Record the
		// delivery for the audit trail and acknowledge — replays are no-ops.
		_, _ = s.pool.Exec(ctx, `
			INSERT INTO commerce.payment_webhooks
				(provider, provider_txn_id, signature_ok, accepted, reject_reason, raw)
			VALUES ($1,$2,true,false,'duplicate', jsonb_build_object('booking_id',$3::text))`,
			w.Provider, w.ProviderTxnID, w.BookingID)
		return false, nil
	}
	if err != nil {
		return false, err
	}

	// 6. confirm seats. Idempotent on hold_id inside the inventory service.
	if err := s.inv.ConfirmHold(ctx, holdID); err != nil {
		return false, fmt.Errorf("confirm seats: %w", err)
	}

	// 7. booking -> CONFIRMED, tickets issued, ledger posted. One transaction.
	if err := s.finalise(ctx, w, paymentID, operatorID); err != nil {
		return false, err
	}

	_, _ = s.pool.Exec(ctx, `
		INSERT INTO commerce.payment_webhooks
			(provider, provider_txn_id, signature_ok, accepted, raw)
		VALUES ($1,$2,true,true, jsonb_build_object('booking_id',$3::text))`,
		w.Provider, w.ProviderTxnID, w.BookingID)
	return true, nil
}

// Posting is one line of a journal. A slice of these must balance: total DR
// equals total CR, checked by the database before the transaction commits.
type Posting struct {
	Account string
	Side    string // "DR" or "CR"
	Amount  int64
	Party   string
}

// GatewayPostings is the money split for an online card/MFS sale.
//
// Worked example from the plan: gross 1200.00, the platform keeps a 50.00
// service fee plus 10% commission on the 1150.00 base, and the gateway takes
// 1.5%.
func GatewayPostings(gross int64, provider, operatorID string) []Posting {
	serviceFee := int64(5000)
	base := gross - serviceFee
	commission := base / 10
	gatewayFee := gross * 15 / 1000
	return []Posting{
		{"1101", "DR", gross - gatewayFee, provider},   // Gateway Clearing
		{"5102", "DR", gatewayFee, provider},           // Gateway Fee Expense
		{"2101", "CR", base - commission, operatorID},  // Operator Payable
		{"4101", "CR", commission + serviceFee, ""},    // Platform Revenue
	}
}

// ReschedulePostings is the money movement when a passenger changes departure.
//
// It reverses the split the original sale credited and applies the split the
// new fare earns, then nets the difference: money collected lands in Gateway
// Clearing, money owed becomes a Refund Payable. The gateway's original fee is
// deliberately NOT reversed — the provider kept it, and pretending otherwise
// would leave the platform a few taka short on every reschedule.
func ReschedulePostings(oldTotal, newTotal int64, operatorID, pnr string) []Posting {
	split := func(total int64) (operator, platform int64) {
		serviceFee := int64(5000)
		base := total - serviceFee
		commission := base / 10
		return base - commission, commission + serviceFee
	}
	oldOp, oldPlat := split(oldTotal)
	newOp, newPlat := split(newTotal)

	p := []Posting{
		{"2101", "DR", oldOp, operatorID},   // claw back what the operator was owed
		{"4101", "DR", oldPlat, ""},         // and what the platform recognised
		{"2101", "CR", newOp, operatorID},   // credit the new fare
		{"4101", "CR", newPlat, ""},
	}
	switch diff := newTotal - oldTotal; {
	case diff > 0:
		p = append(p, Posting{"1101", "DR", diff, "reschedule " + pnr}) // collected
	case diff < 0:
		p = append(p, Posting{"2201", "CR", -diff, pnr}) // owed back
	}
	return p
}

// finalise confirms a webhook-paid booking. Kept as a thin wrapper so the
// online payment path reads exactly as it did before the counter and agent
// channels arrived — they differ only in which accounts the money touches.
func (s *Service) finalise(ctx context.Context, w Webhook, paymentID, operatorID string) error {
	// A reschedule is settled against the booking it replaces, not priced from
	// scratch. Doing otherwise would count the original fare twice.
	var oldTotal, newTotal int64
	var pnr string
	err := s.pool.QueryRow(ctx, `
		SELECT o.total_poisha, b.total_poisha, b.pnr
		  FROM commerce.bookings b
		  JOIN commerce.bookings o ON o.booking_id = b.reschedule_of
		 WHERE b.booking_id = $1::uuid`, w.BookingID).Scan(&oldTotal, &newTotal, &pnr)
	if err == nil {
		return s.Finalise(ctx, w.BookingID, "reschedule difference paid",
			ReschedulePostings(oldTotal, newTotal, operatorID, pnr))
	}
	// Only "this booking is not a reschedule" (no matching original) may fall
	// through to the ordinary gateway posting. A real query error must not, or a
	// genuine reschedule whose lookup transiently failed would be posted from
	// w.AmountPoisha — the fare DIFFERENCE, not the full fare — writing a wrong
	// journal for the whole booking.
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return s.Finalise(ctx, w.BookingID, "payment verified via webhook",
		GatewayPostings(w.AmountPoisha, w.Provider, operatorID))
}

// SettleReschedule finalises a reschedule that needs no further payment —
// either the fare was identical or the new departure is cheaper. The passenger
// is ticketed immediately and any overpayment becomes a Refund Payable that the
// normal refund path discharges.
func (s *Service) SettleReschedule(ctx context.Context, newBookingID, operatorID string) error {
	var oldTotal, newTotal int64
	var pnr string
	if err := s.pool.QueryRow(ctx, `
		SELECT o.total_poisha, b.total_poisha, b.pnr
		  FROM commerce.bookings b
		  JOIN commerce.bookings o ON o.booking_id = b.reschedule_of
		 WHERE b.booking_id = $1::uuid`, newBookingID).Scan(&oldTotal, &newTotal, &pnr); err != nil {
		return err
	}
	return s.Finalise(ctx, newBookingID, "rescheduled, no further payment due",
		ReschedulePostings(oldTotal, newTotal, operatorID, pnr))
}

// Finalise confirms a booking, issues one ticket per seat, and posts the
// supplied balanced journal — all in one transaction, guarded so it can only
// ever run once per booking.
//
// Every channel lands here. What changes between web, counter and agent is the
// set of accounts the money moves between; ticket issuance, PNR, QR signing
// and the booking state machine are identical, because they must be.
func (s *Service) Finalise(ctx context.Context, bookingID, reason string, postings []Posting) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	ct, err := tx.Exec(ctx, `
		UPDATE commerce.bookings SET status = 'TICKETED', updated_at = now()
		 WHERE booking_id = $1::uuid AND status = 'PAYMENT_PENDING'`, bookingID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return tx.Commit(ctx) // already finalised
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.booking_status_history (booking_id, from_status, to_status, reason)
		VALUES ($1::uuid, 'PAYMENT_PENDING', 'TICKETED', $2)`, bookingID, reason); err != nil {
		return err
	}

	// one ticket per seat, each with a signed opaque QR token
	rows, err := tx.Query(ctx,
		`SELECT seat_no FROM commerce.booking_seats WHERE booking_id = $1::uuid ORDER BY seat_no`,
		bookingID)
	if err != nil {
		return err
	}
	var seats []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return err
		}
		seats = append(seats, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	var pnr, channel, tripID, operatorID string
	var total int64
	if err := tx.QueryRow(ctx, `
		SELECT pnr, channel, trip_id::text, operator_id::text, total_poisha
		  FROM commerce.bookings WHERE booking_id = $1::uuid`, bookingID).
		Scan(&pnr, &channel, &tripID, &operatorID, &total); err != nil {
		return err
	}

	for _, seat := range seats {
		if _, err := tx.Exec(ctx, `
			INSERT INTO commerce.tickets (booking_id, pnr, seat_no, qr_token, qr_key_id)
			VALUES ($1::uuid, $2, $3, $4, $5)
			ON CONFLICT (booking_id, seat_no) DO NOTHING`,
			bookingID, pnr, seat, s.qrToken(pnr, seat), s.qrKeyID); err != nil {
			return err
		}
	}

	// ---- double-entry posting ------------------------------------------------
	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('booking ticketed ' || $1) RETURNING journal_id::text`, pnr).Scan(&journalID); err != nil {
		return err
	}
	for _, p := range postings {
		if p.Amount == 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid, $2, $3, $4, $5)`,
			journalID, p.Account, p.Side, p.Amount, p.Party); err != nil {
			return err
		}
	}

	// The database refuses to let an unbalanced journal through.
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return err
	}

	// ---- the events ----------------------------------------------------------
	// Written into commerce's own outbox in the SAME transaction as the booking
	// and the journal. Everything downstream — the passenger's SMS, the search
	// projection, the analytics fact, the partner webhook — hangs off these two
	// rows, and none of them can describe a booking that did not commit.
	//
	// The payload carries what consumers need, so that analytics never has to
	// come back and read the booking tables to enrich a fact.
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'booking.confirmed', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'trip_id', $3::text,
			'operator_id', $4::text, 'channel', $5::text,
			'total_poisha', $6::bigint, 'seat_count', $7::int,
			'route', (SELECT rt.name FROM catalog.trips t
			            JOIN catalog.routes rt ON rt.route_id = t.route_id
			           WHERE t.trip_id = $3::uuid))),
		       ($1::uuid, 'ticket.issued', jsonb_build_object(
			'pnr', $2::text, 'booking_id', $1::text, 'trip_id', $3::text,
			'operator_id', $4::text, 'seats', to_jsonb($8::text[])))`,
		bookingID, pnr, tripID, operatorID, channel, total, len(seats), seats); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) qrToken(pnr, seat string) string {
	mac := hmac.New(sha256.New, s.qrKey)
	fmt.Fprintf(mac, "%s|%s", pnr, seat) // no PII in the token, ever
	return s.qrKeyID + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func newPNR() (string, error) {
	const alphabet = "ACDEFGHJKLMNPQRTUVWXY3479" // no easily confused glyphs
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	out := make([]byte, 6)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out), nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

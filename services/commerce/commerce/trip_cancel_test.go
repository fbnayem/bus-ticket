package commerce

import (
	"context"
	"testing"
	"time"

	"github.com/busticket/platform/services/inventory/inventory"
)

// Cancelling a whole trip is the flow that, until now, hurt passengers: an
// operator flipped catalog.trips to CANCELLED and forty people kept a live
// ticket for a bus that would never come, and their money with it. CancelTrip
// refunds every one of them in full and leaves the books balanced.
//
// The proof asserts three things that must all hold at once:
//   - every live booking is refunded the FULL fare (an operator cancellation is
//     not the tiered passenger-changed-their-mind policy),
//   - each passenger gets their own booking.cancelled notice so they learn the
//     exact amount, and the trip gets exactly one trip.cancelled event,
//   - the platform trial balance is still zero and every journal balances alone.
func TestCancelTripRefundsEveryoneInFullAndBalances(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	tripID, pnrs, totals := ticketedTrip(t, 2)
	wantRefund := totals[0] + totals[1]

	res, err := svc.CancelTrip(ctx, tripID, "engine failure at Cumilla")
	if err != nil {
		t.Fatalf("CancelTrip: %v", err)
	}

	// Full fare back for everyone. If the trip path ever borrowed the tiered
	// passenger policy (a partial refund with a fee), this total goes short and
	// this line goes red — which is the falsification for "refunded in full".
	if res.BookingsCancelled != 2 {
		t.Fatalf("cancelled %d bookings, want 2", res.BookingsCancelled)
	}
	if res.RefundPoisha != wantRefund {
		t.Fatalf("refunded %d poisha, want the full %d — an operator cancellation "+
			"must not keep a cancellation fee", res.RefundPoisha, wantRefund)
	}

	// Each booking is refund-pending with its tickets voided.
	for _, pnr := range pnrs {
		var status string
		var liveTickets int
		if err := pool.QueryRow(ctx, `
			SELECT b.status,
			       (SELECT count(*) FROM commerce.tickets t
			          WHERE t.booking_id = b.booking_id AND t.status <> 'CANCELLED')
			  FROM commerce.bookings b WHERE b.pnr = $1`, pnr).Scan(&status, &liveTickets); err != nil {
			t.Fatal(err)
		}
		if status != "REFUND_PENDING" {
			t.Fatalf("%s is %s after trip cancel, want REFUND_PENDING", pnr, status)
		}
		if liveTickets != 0 {
			t.Fatalf("%s still has %d live ticket(s) for a cancelled bus", pnr, liveTickets)
		}
	}

	// One booking.cancelled per passenger (they each learn their exact refund),
	// and exactly one trip.cancelled for the trip (search index + control room).
	var bookingEvents, tripEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM commerce.outbox
		 WHERE event_type='booking.cancelled'
		   AND aggregate_id IN (SELECT booking_id FROM commerce.bookings WHERE pnr = ANY($1))`,
		pnrs).Scan(&bookingEvents); err != nil {
		t.Fatal(err)
	}
	if bookingEvents != 2 {
		t.Fatalf("booking.cancelled events = %d, want 2 (one per passenger)", bookingEvents)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM commerce.outbox
		 WHERE event_type='trip.cancelled' AND aggregate_id=$1::uuid`, tripID).Scan(&tripEvents); err != nil {
		t.Fatal(err)
	}
	if tripEvents != 1 {
		t.Fatalf("trip.cancelled events = %d, want exactly 1", tripEvents)
	}

	assertLedgerWhole(t)

	// Re-running after everyone is already cancelled must be a no-op, not a
	// second round of refunds: the guard against a partial run being repeated.
	again, err := svc.CancelTrip(ctx, tripID, "engine failure at Cumilla")
	if err != nil {
		t.Fatalf("CancelTrip re-run: %v", err)
	}
	if again.BookingsCancelled != 0 || again.RefundPoisha != 0 {
		t.Fatalf("re-cancel refunded %d bookings / %d poisha, want 0/0 — already-"+
			"cancelled bookings must be skipped", again.BookingsCancelled, again.RefundPoisha)
	}
	assertLedgerWhole(t)
}

// ticketedTrip opens a trip, then books and confirms n single-seat bookings on
// it so each is TICKETED and eligible for a real cancellation. It returns the
// trip, one PNR per booking, and each booking's total.
func ticketedTrip(t *testing.T, n int) (tripID string, pnrs []string, totals []int64) {
	t.Helper()
	ctx := context.Background()

	tripID = mustUUID(t)
	seatNames := []string{"A1", "A2", "A3", "A4", "A5", "A6"}
	if n > len(seatNames) {
		t.Fatalf("ticketedTrip supports up to %d seats", len(seatNames))
	}
	seats := make([]inventory.SeatSpec, len(seatNames))
	for i, s := range seatNames {
		seats[i] = inventory.SeatSpec{SeatNo: s, Row: 0, Col: i + 1}
	}
	if err := inv.OpenTrip(ctx, tripID, 3, seats); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < n; i++ {
		seat := seatNames[i]
		h, err := inv.AcquireHold(ctx, inventory.HoldRequest{
			TripID: tripID, Seats: []string{seat},
			BoardSeq: 0, DropSeq: 3, Channel: "WEB", TTL: 10 * time.Minute,
		})
		if err != nil {
			t.Fatal(err)
		}
		total := int64(80000 + i*5000) // distinct totals so a mixed-up sum shows
		bookingID, _, err := svc.CreateBooking(ctx, BookingRequest{
			HoldID: h.HoldID, TripID: tripID, OperatorID: operatorID,
			Seats: []string{seat}, BoardSeq: 0, DropSeq: 3,
			Channel: "WEB", TotalPoisha: total,
		})
		if err != nil {
			t.Fatal(err)
		}
		w := Webhook{Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
			BookingID: bookingID, AmountPoisha: total, Currency: "BDT"}
		w.Signature = svc.Sign(w)
		if ok, err := svc.HandleWebhook(ctx, w); err != nil || !ok {
			t.Fatalf("confirm booking %d: ok=%v err=%v", i, ok, err)
		}
		var pnr string
		if err := pool.QueryRow(ctx, `SELECT pnr FROM commerce.bookings WHERE booking_id=$1::uuid`,
			bookingID).Scan(&pnr); err != nil {
			t.Fatal(err)
		}
		pnrs = append(pnrs, pnr)
		totals = append(totals, total)
	}
	return tripID, pnrs, totals
}

// assertLedgerWhole asserts the platform-wide trial balance is zero and no
// single journal is lopsided — the same invariant the webhook proof guards,
// re-checked after refunds have moved money back out.
func assertLedgerWhole(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	var variance int64
	if err := pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance); err != nil {
		t.Fatal(err)
	}
	if variance != 0 {
		t.Fatalf("INVARIANT VIOLATED: trial balance is %d poisha, expected 0", variance)
	}
	var unbalanced int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		  SELECT journal_id FROM finance.ledger_entries
		   GROUP BY journal_id
		  HAVING COALESCE(sum(amount_poisha) FILTER (WHERE side='DR'),0)
		      <> COALESCE(sum(amount_poisha) FILTER (WHERE side='CR'),0)
		) x`).Scan(&unbalanced); err != nil {
		t.Fatal(err)
	}
	if unbalanced != 0 {
		t.Fatalf("INVARIANT VIOLATED: %d journals do not balance on their own", unbalanced)
	}
}

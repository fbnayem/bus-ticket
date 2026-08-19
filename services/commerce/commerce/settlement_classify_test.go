package commerce

import (
	"context"
	"testing"
	"time"

	"github.com/busticket/platform/services/inventory/inventory"
)

// A counter sale paid by card or bKash reaches the platform's gateway, exactly
// like a website sale — the operator's drawer never sees the money. Settlement
// must decide "the operator already holds this cash" from the payment provider,
// not from the COUNTER channel. Keying it on the channel deducted the whole fare
// of every counter card sale, billing the operator for money the platform itself
// collected. This proof builds one of each in an isolated window and asserts
// that only the CASH one is deducted; the card assertion goes red under the old
// channel-based classifier.
func TestSettlementClassifiesHeldCashByPaymentNotChannel(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	// A historical window nothing else has settled: the two fixture bookings are
	// the only lines and no prior sign-off blocks recalculation.
	const from, to = "2019-03-01", "2019-03-31"
	const backdate = "2019-03-15 06:00:00+00" // Dhaka noon, inside the window

	cashBID := counterSaleFixture(t, ctx, "CASH", 90000)
	cardBID := counterSaleFixture(t, ctx, "BKASH", 90000)
	for _, bid := range []string{cashBID, cardBID} {
		if _, err := pool.Exec(ctx,
			`UPDATE commerce.bookings SET created_at=$2::timestamptz WHERE booking_id=$1::uuid`,
			bid, backdate); err != nil {
			t.Fatal(err)
		}
	}

	sid := calculateInWindow(t, ctx, from, to)

	if got := cashCollectedFor(t, ctx, sid, cashBID); got != 90000 {
		t.Errorf("counter CASH sale: cash_collected = %d, want 90000 (operator holds it)", got)
	}
	// The assertion that goes red under the channel-based classifier: it would
	// deduct 90000 here for money the operator never touched.
	if got := cashCollectedFor(t, ctx, sid, cardBID); got != 0 {
		t.Errorf("counter bKash sale: cash_collected = %d, want 0 (platform gateway holds it)", got)
	}
}

// A refund is split across the parties in the ledger — applyCancellation only
// claws back the operator's share (opRefund = refunded × operatorShare / gross)
// from 2101, reversing the platform's share off 4101. Settlement must charge the
// operator only that share; subtracting the whole refund fabricated an operator
// debt equal to the platform's own commission on a booking that returned every
// poisha. This proof fully refunds a gateway sale and asserts the operator's net
// for it is zero, not negative.
func TestSettlementRefundChargesOnlyTheOperatorShare(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	const from, to = "2019-04-01", "2019-04-30"
	const backdate = "2019-04-15 06:00:00+00"

	const total = int64(120000)
	tripID := mustUUID(t)
	if err := inv.OpenTrip(ctx, tripID, 3, []inventory.SeatSpec{{SeatNo: "A1", Row: 0, Col: 1}}); err != nil {
		t.Fatal(err)
	}
	h, err := inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3,
		Channel: "WEB", TTL: 10 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	bid, pnr, err := svc.CreateBooking(ctx, BookingRequest{
		HoldID: h.HoldID, TripID: tripID, OperatorID: operatorID,
		Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3,
		Channel: "WEB", TotalPoisha: total,
	})
	if err != nil {
		t.Fatal(err)
	}
	w := Webhook{Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
		BookingID: bid, AmountPoisha: total, Currency: "BDT"}
	w.Signature = svc.Sign(w)
	if ok, err := svc.HandleWebhook(ctx, w); err != nil || !ok {
		t.Fatalf("confirm booking: ok=%v err=%v", ok, err)
	}
	if _, err := svc.SupportRefund(ctx, pnr, total, "audit: settlement refund proof"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE commerce.bookings SET created_at=$2::timestamptz WHERE booking_id=$1::uuid`,
		bid, backdate); err != nil {
		t.Fatal(err)
	}

	sid := calculateInWindow(t, ctx, from, to)

	var gross, commission, refund, cash, net int64
	if err := pool.QueryRow(ctx, `
		SELECT gross_poisha, commission_poisha, refund_poisha, cash_collected_poisha, net_poisha
		  FROM finance.settlement_items WHERE settlement_id=$1::uuid AND booking_id=$2::uuid`,
		sid, bid).Scan(&gross, &commission, &refund, &cash, &net); err != nil {
		t.Fatal(err)
	}
	var refunded int64
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(sum(amount_poisha),0) FROM commerce.refunds
		  WHERE booking_id=$1::uuid AND status='SUCCESS'`, bid).Scan(&refunded)

	operatorEarning := gross - commission
	wantOpRefund := refunded * operatorEarning / gross
	if refund != wantOpRefund {
		t.Errorf("refund charged to operator = %d, want operator share %d (the whole refund was %d) "+
			"— the old code subtracted the entire refund", refund, wantOpRefund, refunded)
	}
	// A fully refunded booking nets to zero in the operator's ledger, so the
	// settlement must not invent a debt: net = operatorEarning - opRefund = 0.
	if net != 0 {
		t.Errorf("fully-refunded booking net = %d, want 0 (operator owes nothing on a sale that returned every poisha)", net)
	}
}

// calculateInWindow recomputes a settlement and fails if the window is not
// freshly calculable (a sign someone picked a window already signed off).
func calculateInWindow(t *testing.T, ctx context.Context, from, to string) string {
	t.Helper()
	sid, err := svc.CalculateSettlement(ctx, operatorID, from, to)
	if err != nil {
		t.Fatalf("calculate settlement %s..%s: %v", from, to, err)
	}
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM finance.settlements WHERE settlement_id=$1::uuid`, sid).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "CALCULATED" {
		t.Fatalf("settlement window %s..%s is %s, cannot recompute — pick a fresh isolated window",
			from, to, status)
	}
	return sid
}

func cashCollectedFor(t *testing.T, ctx context.Context, sid, bid string) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(ctx,
		`SELECT cash_collected_poisha FROM finance.settlement_items
		  WHERE settlement_id=$1::uuid AND booking_id=$2::uuid`, sid, bid).Scan(&v); err != nil {
		t.Fatalf("no settlement line for booking %s: %v", bid, err)
	}
	return v
}

// counterSaleFixture books one seat on a fresh COUNTER trip and settles it with
// the given payment method, returning the booking id.
func counterSaleFixture(t *testing.T, ctx context.Context, method string, total int64) string {
	t.Helper()
	tripID := mustUUID(t)
	if err := inv.OpenTrip(ctx, tripID, 3, []inventory.SeatSpec{{SeatNo: "A1", Row: 0, Col: 1}}); err != nil {
		t.Fatal(err)
	}
	h, err := inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3,
		Channel: "COUNTER", TTL: 10 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	bid, _, err := svc.CreateBooking(ctx, BookingRequest{
		HoldID: h.HoldID, TripID: tripID, OperatorID: operatorID,
		Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3,
		Channel: "COUNTER", TotalPoisha: total,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SettleCounterSale(ctx, bid, "", method); err != nil {
		t.Fatalf("settle counter sale (%s): %v", method, err)
	}
	return bid
}

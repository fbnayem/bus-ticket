package commerce

import (
	"context"
	"errors"
	"testing"
)

// Support acting on a booking must obey the same money laws as everyone else. A
// goodwill refund settles back through the gateway (1101), never the cash drawer,
// and the books stay whole. And the goodwill amount is capped at what was actually
// paid — refunding more than the fare is not generosity, it is a leak. This proves
// both: the ledger stays balanced and gateway-settled on a valid override, and an
// over-refund is refused. Remove the cap in SupportRefund and the refusal below
// stops happening — the test goes red.
func TestSupportRefundSettlesToGatewayAndCannotExceedPaid(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	_, pnrs, totals := ticketedTrip(t, 2)

	// A goodwill override of half the fare, settled back to the gateway.
	pnr, total := pnrs[0], totals[0]
	paid, err := svc.SupportRefund(ctx, pnr, total/2, "goodwill — delayed bus")
	if err != nil {
		t.Fatal(err)
	}
	if paid != total/2 {
		t.Fatalf("refunded %d, want the override %d", paid, total/2)
	}
	assertLedgerWhole(t)

	var refunded string
	if err := pool.QueryRow(ctx, `SELECT status FROM commerce.bookings WHERE pnr=$1`, pnr).Scan(&refunded); err != nil {
		t.Fatal(err)
	}
	if refunded != "REFUNDED" {
		t.Fatalf("booking is %s, want REFUNDED", refunded)
	}

	// The money went back through the gateway (1101), not out of a cash drawer (1001).
	var gateway, cash int64
	pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1101'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1001'),0)
		  FROM finance.ledger_entries le JOIN finance.journal_entries je USING (journal_id)
		 WHERE je.description = 'refund settled ' || $1`, pnr).Scan(&gateway, &cash)
	if gateway != paid || cash != 0 {
		t.Fatalf("refund settled to Gateway=%d Cash=%d, want Gateway=%d Cash=0", gateway, cash, paid)
	}

	// A goodwill refund larger than the fare is refused, not paid.
	pnr2, total2 := pnrs[1], totals[1]
	if _, err := svc.SupportRefund(ctx, pnr2, total2+1, "over-refund attempt"); !errors.Is(err, ErrRefundExceedsPaid) {
		t.Fatalf("an override of %d on a %d booking returned err=%v, want ErrRefundExceedsPaid — "+
			"support must never refund more than was paid", total2+1, total2, err)
	}
}

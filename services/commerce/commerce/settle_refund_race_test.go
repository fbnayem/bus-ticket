package commerce

import (
	"context"
	"sync"
	"testing"
)

// A refund settles exactly once, no matter how many settle calls race. In
// production SettleRefund is driven by the payment provider's refund callback,
// and gateway callbacks are retried and delivered concurrently by design. Before
// the FOR UPDATE re-check inside the transaction, the outstanding refund was read
// unlocked and flipped to SUCCESS with an unconditional UPDATE, so two callbacks
// both posted a balanced 2201 DR / 1101 CR journal and the gateway paid the
// passenger back twice — while the trial balance stayed zero because each journal
// balanced on its own. This manufactures one REQUESTED refund and fires eight
// concurrent settles at it, proving the gateway is credited exactly once.
func TestConcurrentSettleRefundPaysGatewayOnce(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	_, pnrs, totals := ticketedTrip(t, 1)
	pnr, total := pnrs[0], totals[0]
	refund := total / 2

	// Record the refund liability (REQUESTED) without settling it — the state a
	// passenger cancellation leaves behind while it waits for the gateway to call
	// back. applyCancellation is the same core the passenger and trip paths use.
	ref, err := svc.loadBookingRef(ctx, pnr)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.applyCancellation(ctx, ref, 50, refund, 24, "audit: settle-refund race", false); err != nil {
		t.Fatal(err)
	}

	const N = 8
	var wg sync.WaitGroup
	errs := make([]error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = svc.SettleRefund(ctx, pnr)
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Fatalf("settle %d errored: %v (every settle is idempotent and must return nil)", i, e)
		}
	}

	// The gateway clearing account is credited exactly once, for exactly the
	// refund. Under the unguarded code this was N × refund — real money out the
	// door more than once.
	var gatewayOut int64
	pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1101'),0)
		  FROM finance.ledger_entries le JOIN finance.journal_entries je USING(journal_id)
		 WHERE je.description = 'refund settled ' || $1`, pnr).Scan(&gatewayOut)
	if gatewayOut != refund {
		t.Fatalf("gateway paid out %d, want exactly the single refund %d — a settle race moved money more than once", gatewayOut, refund)
	}

	// And the refund settled to SUCCESS exactly once.
	var settled int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM commerce.refunds r JOIN commerce.bookings b USING(booking_id)
		 WHERE b.pnr=$1 AND r.status='SUCCESS'`, pnr).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if settled != 1 {
		t.Fatalf("SUCCESS refund rows = %d, want 1", settled)
	}
	assertLedgerWhole(t)
}

package commerce

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// A refund must happen exactly once, no matter how many requests race — a double
// click, a retry storm, two agents on the same case. Before the row lock in
// applyCancellation, N concurrent refunds each posted a balanced refund journal
// and paid out N times, and the trial balance stayed zero because every journal
// balanced on its own, so nothing caught the over-refund. This fires eight
// concurrent refunds at one booking and proves exactly one moves money.
func TestConcurrentRefundsRefundExactlyOnce(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	_, pnrs, totals := ticketedTrip(t, 1)
	pnr, total := pnrs[0], totals[0]
	override := total / 2

	const N = 8
	var wg sync.WaitGroup
	amounts := make([]int64, N)
	errs := make([]error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			amounts[i], errs[i] = svc.SupportRefund(ctx, pnr, override, "race")
		}(i)
	}
	wg.Wait()

	wins, losses := 0, 0
	for i := 0; i < N; i++ {
		switch {
		case errs[i] == nil && amounts[i] == override:
			wins++
		case errors.Is(errs[i], ErrNotCancellable):
			losses++
		default:
			t.Fatalf("goroutine %d got unexpected (amount=%d, err=%v)", i, amounts[i], errs[i])
		}
	}
	if wins != 1 {
		t.Fatalf("%d refunds succeeded, want exactly 1 — the rest must lose the race with ErrNotCancellable", wins)
	}
	if wins+losses != N {
		t.Fatalf("wins(%d)+losses(%d) != %d", wins, losses, N)
	}

	// Exactly one cancellation record, and the gateway paid out the refund once.
	var cancels int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM commerce.cancellations c JOIN commerce.bookings b USING(booking_id)
		  WHERE b.pnr=$1`, pnr).Scan(&cancels); err != nil {
		t.Fatal(err)
	}
	if cancels != 1 {
		t.Fatalf("cancellation rows = %d, want 1 — a race duplicated the cancellation", cancels)
	}
	var gatewayOut int64
	pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1101'),0)
		  FROM finance.ledger_entries le JOIN finance.journal_entries je USING(journal_id)
		 WHERE je.description = 'refund settled ' || $1`, pnr).Scan(&gatewayOut)
	if gatewayOut != override {
		t.Fatalf("gateway paid out %d, want exactly the single refund %d — money moved more than once", gatewayOut, override)
	}
	assertLedgerWhole(t)
	_ = total
}

package commerce

import (
	"context"
	"testing"
)

// A cash refund must come out of the drawer, not the gateway, and the shift's own
// cash log must fall by exactly the refund. If it does not, the clerk's drawer
// reads OVER at close and they are blamed for money they correctly handed back.
//
// This drives a real cancellation and a real cash settlement against the database,
// then checks the two things that make a counter refund honest: the ledger credits
// Cash (1001) and stays balanced, and the shift reconciliation — float plus the
// sum of movements — drops by the refund. Break the sign of the cash-log movement
// and the reconciliation assertion below goes red.
func TestCounterCashRefundLeavesTheDrawerAndReconciles(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	_, pnrs, totals := ticketedTrip(t, 1)
	pnr, total := pnrs[0], totals[0]

	// An open drawer on this operator's counter, with a float.
	counterID := mustUUID(t)
	if _, err := pool.Exec(ctx,
		`INSERT INTO counter.counters (counter_id, operator_id, name)
		 VALUES ($1::uuid,$2::uuid,'Refund Test Counter')`, counterID, operatorID); err != nil {
		t.Fatal(err)
	}
	var staffID string
	if err := pool.QueryRow(ctx, `SELECT staff_id::text FROM staff.staff_users LIMIT 1`).Scan(&staffID); err != nil {
		t.Fatal(err)
	}
	shiftID := mustUUID(t)
	const float = int64(500000)
	if _, err := pool.Exec(ctx,
		`INSERT INTO counter.shifts (shift_id, counter_id, staff_id, status, opening_float_poisha)
		 VALUES ($1::uuid,$2::uuid,$3::uuid,'OPEN',$4)`, shiftID, counterID, staffID, float); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM counter.cash_transactions WHERE shift_id=$1::uuid`, shiftID)
		pool.Exec(ctx, `DELETE FROM counter.shifts WHERE shift_id=$1::uuid`, shiftID)
		pool.Exec(ctx, `DELETE FROM counter.counters WHERE counter_id=$1::uuid`, counterID)
	})

	// Cancel at a chosen amount (bypassing the policy tables so the test is
	// self-contained), producing a REQUESTED refund, then settle it as cash.
	ref, err := svc.loadBookingRef(ctx, pnr)
	if err != nil {
		t.Fatal(err)
	}
	refund := total / 2
	if err := svc.applyCancellation(ctx, ref, 50, refund, 4, "passenger changed plans", true); err != nil {
		t.Fatal(err)
	}
	paid, err := svc.SettleRefundCash(ctx, pnr, shiftID)
	if err != nil {
		t.Fatal(err)
	}
	if paid != refund {
		t.Fatalf("settled %d, want the requested refund %d", paid, refund)
	}

	// The books stay whole across the whole platform.
	assertLedgerWhole(t)

	// The drawer's expected close = float + sum(movements) must be float - refund.
	var expected int64
	if err := pool.QueryRow(ctx,
		`SELECT $1 + COALESCE(sum(amount_poisha),0) FROM counter.cash_transactions
		  WHERE shift_id=$2::uuid AND method='CASH'`, float, shiftID).Scan(&expected); err != nil {
		t.Fatal(err)
	}
	if expected != float-refund {
		t.Fatalf("drawer expected %d, want float(%d) - refund(%d) = %d — "+
			"a cash refund must reduce the drawer by exactly the refund",
			expected, float, refund, float-refund)
	}

	// The money left Cash (1001), never Gateway Clearing (1101).
	var cash, gateway int64
	pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1001'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE side='CR' AND account_code='1101'),0)
		  FROM finance.ledger_entries le JOIN finance.journal_entries je USING (journal_id)
		 WHERE je.description = 'counter refund ' || $1`, pnr).Scan(&cash, &gateway)
	if cash != refund || gateway != 0 {
		t.Fatalf("refund credited Cash=%d Gateway=%d, want Cash=%d Gateway=0", cash, gateway, refund)
	}
}

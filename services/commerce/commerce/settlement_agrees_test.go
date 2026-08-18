package commerce

import (
	"context"
	"testing"
	"time"
)

// A settlement must say the same thing the ledger said.
//
// It does not read the ledger — it recomputes an operator's payable from the
// bookings, deliberately, so a late refund is picked up on the next run. That
// makes it a second implementation of the platform's cut, and a second
// implementation is a place for the two to drift apart quietly.
//
// They had. The commission was recomputed from total_poisha, which is what the
// passenger paid; on a discounted on-board sale that is less than the published
// price, so the settlement produced a smaller platform cut than the journal had
// already posted and handed the operator the difference. Across the demo data
// it was ৳14,781.00 posted against ৳14,350.16 recomputed — ৳430.84 adrift, and
// growing with every discount a conductor granted.
//
// The assertion is per booking rather than in total, because two errors of
// opposite sign summing to zero is exactly the kind of agreement that is not
// agreement.
func TestSettlementCommissionAgreesWithTheLedger(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	const demoOperator = "11111111-1111-1111-1111-111111111111"

	// Walk back the start of the window until a period turns up that has not
	// already been signed off — an approved settlement is history and refuses
	// to be recalculated, which is the point of the state machine.
	var settlementID string
	var items int
	to := time.Now().Format("2006-01-02")
	for span := 1; span <= 60 && settlementID == ""; span++ {
		from := time.Now().AddDate(0, 0, -span).Format("2006-01-02")
		id, err := svc.CalculateSettlement(ctx, demoOperator, from, to)
		if err != nil {
			t.Fatalf("calculate settlement %s..%s: %v", from, to, err)
		}
		var status string
		if err := pool.QueryRow(ctx,
			`SELECT status FROM finance.settlements WHERE settlement_id=$1::uuid`,
			id).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "CALCULATED" {
			continue // already approved or paid; try a longer window
		}
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM finance.settlement_items WHERE settlement_id=$1::uuid`,
			id).Scan(&items); err != nil {
			t.Fatal(err)
		}
		if items > 0 {
			settlementID = id
		}
	}
	if settlementID == "" {
		t.Fatal("no calculable settlement window with any bookings in it; " +
			"this proof cannot see the thing it exists to check")
	}

	// The bug only shows on a discounted sale, so a run with none in the window
	// proves nothing and must say so rather than pass.
	var discounted int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM finance.settlement_items si
		  JOIN commerce.bookings b USING (booking_id)
		 WHERE si.settlement_id = $1::uuid AND b.discount_poisha > 0`,
		settlementID).Scan(&discounted); err != nil {
		t.Fatal(err)
	}
	if discounted == 0 {
		t.Fatal("no discounted booking in this settlement window; the drift this " +
			"proof guards against would be invisible")
	}

	var mismatches int
	var worst int64
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(abs(si.commission_poisha - e.amount_poisha)), 0)
		  FROM finance.settlement_items si
		  JOIN commerce.bookings b ON b.booking_id = si.booking_id
		  JOIN finance.journal_entries j ON j.description = 'booking ticketed ' || b.pnr
		  JOIN finance.ledger_entries e ON e.journal_id = j.journal_id
		                               AND e.account_code = '4101'
		 WHERE si.settlement_id = $1::uuid
		   AND si.commission_poisha <> e.amount_poisha`,
		settlementID).Scan(&mismatches, &worst); err != nil {
		t.Fatal(err)
	}
	if mismatches != 0 {
		t.Fatalf("%d settlement item(s) disagree with the ledger about the platform "+
			"cut, worst by %d poisha — the settlement and the books cannot say two "+
			"different things about the same sale", mismatches, worst)
	}
	t.Logf("%d items, %d of them discounted, none adrift from the ledger", items, discounted)
}

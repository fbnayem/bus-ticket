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
	settlementID := calculableSettlement(t, ctx)
	var items int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM finance.settlement_items WHERE settlement_id=$1::uuid`,
		settlementID).Scan(&items)

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

// The platform must not pay out cash it never received.
//
// About forty percent of the demo operator's sales are taken in cash by their
// own counter clerks and conductors. The passenger has already handed the
// operator that money. Paying them their share of it again is not a rounding
// error, it is the whole amount twice.
//
// What decides whether the operator already holds the cash is HOW THE BOOKING
// WAS PAID, not which channel it came through. A counter clerk who takes a card
// or a bKash payment has sent that money to the platform's gateway exactly like
// a website sale — the drawer never saw it. Keying the deduction on the channel
// (COUNTER) instead of the payment (a CASH provider) charged the operator the
// whole fare of every counter card sale, for money the platform itself
// collected. So this proof is keyed on the payment, and both halves matter:
// every CASH-paid booking is deducted, and nothing else is.
func TestSettlementDeductsOnlyTheCashTheOperatorAlreadyHas(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	settlementID := calculableSettlement(t, ctx)

	// hasCash is a fact about the payment, checked directly against the payments
	// ledger rather than inferred from the channel — a card sale at a counter is
	// a COUNTER booking that the operator never took cash for.
	const hasCash = `EXISTS (SELECT 1 FROM commerce.payments p
	                          WHERE p.booking_id = si.booking_id AND p.status='PAID'
	                            AND p.provider='CASH')`

	// Half one: every CASH-paid booking is deducted, net of any cash refund the
	// operator has already handed back out of the drawer.
	var wrongCash int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM finance.settlement_items si
		 WHERE si.settlement_id = $1::uuid
		   AND `+hasCash+`
		   AND si.cash_collected_poisha <> si.gross_poisha
		         - COALESCE((SELECT sum(rf.amount_poisha) FROM commerce.refunds rf
		                      WHERE rf.booking_id = si.booking_id AND rf.status='SUCCESS'),0)`,
		settlementID).Scan(&wrongCash); err != nil {
		t.Fatal(err)
	}
	if wrongCash != 0 {
		t.Errorf("%d cash-paid item(s) were not deducted at the amount the drawer holds", wrongCash)
	}

	// Half two: nothing the platform actually received (card, MFS, web, agent) is
	// deducted — including a card sale that happened to be taken at a counter.
	var wrongCard int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM finance.settlement_items si
		 WHERE si.settlement_id = $1::uuid
		   AND NOT `+hasCash+`
		   AND si.cash_collected_poisha <> 0`,
		settlementID).Scan(&wrongCard); err != nil {
		t.Fatal(err)
	}
	if wrongCard != 0 {
		t.Errorf("%d item(s) the platform collected were deducted anyway", wrongCard)
	}

	// And the net is the subtraction it claims to be, line by line.
	var brokenNet int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM finance.settlement_items
		 WHERE settlement_id = $1::uuid
		   AND net_poisha <> gross_poisha - commission_poisha
		                     - refund_poisha - cash_collected_poisha`,
		settlementID).Scan(&brokenNet); err != nil {
		t.Fatal(err)
	}
	if brokenNet != 0 {
		t.Errorf("%d item(s) whose net is not gross - commission - refund - cash", brokenNet)
	}

	var cash, sales int64
	_ = pool.QueryRow(ctx, `
		SELECT COALESCE(sum(cash_collected_poisha),0), COALESCE(sum(gross_poisha),0)
		  FROM finance.settlement_items WHERE settlement_id = $1::uuid`,
		settlementID).Scan(&cash, &sales)
	if cash == 0 {
		t.Fatal("no operator-held cash in this window; the double payment this " +
			"proof guards against would be invisible")
	}
	t.Logf("Tk %.2f of Tk %.2f was already in the operator hands and is not paid again",
		float64(cash)/100, float64(sales)/100)
}

// calculableSettlement returns a freshly calculated settlement with lines in it.
//
// It walks the start of the window back until it finds a period nobody has
// signed off: an approved settlement is history and refuses to be recalculated,
// which is the point of the state machine and not something to work around.
func calculableSettlement(t *testing.T, ctx context.Context) string {
	t.Helper()
	const demoOperator = "11111111-1111-1111-1111-111111111111"
	// Both ends of the window move. Walking only the start ran out: a period
	// this database has already taken to APPROVED is history and refuses to be
	// recalculated, which is the point of the state machine — and after enough
	// smoke runs every window ending today had been signed off, so this proof
	// stopped being able to see the thing it exists to check.
	for toBack := 0; toBack <= 3; toBack++ {
		to := time.Now().AddDate(0, 0, -toBack).Format("2006-01-02")
		// Widest window first. The shortest one that happens to have any lines in
		// it is the one least likely to contain a discounted sale or an on-board
		// one, and both proofs below refuse to pass on a window where the fault
		// they guard against would be invisible.
		// Up to half a year back, not sixty days. Each run of the smoke suite
		// signs one window off for good, so a database that has been worked
		// against for a while has no short unused window left — and every window
		// that ends today is the only kind that contains today's sales.
		for span := 180; span >= 1; span-- {
			from := time.Now().AddDate(0, 0, -(toBack + span)).Format("2006-01-02")
			id, err := svc.CalculateSettlement(ctx, demoOperator, from, to)
			if err != nil {
				t.Fatalf("calculate settlement %s..%s: %v", from, to, err)
			}
			var status string
			var items int
			if err := pool.QueryRow(ctx, `
				SELECT s.status, (SELECT count(*) FROM finance.settlement_items i
				                   WHERE i.settlement_id = s.settlement_id)
				  FROM finance.settlements s WHERE s.settlement_id = $1::uuid`,
				id).Scan(&status, &items); err != nil {
				t.Fatal(err)
			}
			if status == "CALCULATED" && items > 0 {
				return id
			}
		}
	}
	t.Fatal("no calculable settlement window with any bookings in it; " +
		"this proof cannot see the thing it exists to check")
	return ""
}

package commerce

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/busticket/platform/services/inventory/inventory"
)

// Only an ACTIVE operator may take a booking. CreateBooking is the single
// chokepoint every sales channel funnels through, so the block lives there: a
// PENDING/SUSPENDED/BLOCKED/TERMINATED operator must be refused even if a stale
// hold or a direct call reaches this far. Remove the status check and the
// suspended-operator booking succeeds, turning this red.
func TestCreateBookingRefusesInactiveOperator(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

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

	// Suspend the operator, then restore on the way out no matter what — leaving
	// the shared demo operator suspended would break every other proof.
	if _, err := pool.Exec(ctx,
		`UPDATE catalog.operators SET status='SUSPENDED' WHERE operator_id=$1::uuid`, operatorID); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `UPDATE catalog.operators SET status='ACTIVE' WHERE operator_id=$1::uuid`, operatorID)

	req := BookingRequest{
		HoldID: h.HoldID, TripID: tripID, OperatorID: operatorID,
		Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3,
		Channel: "WEB", TotalPoisha: 80000,
	}
	if _, _, err := svc.CreateBooking(ctx, req); !errors.Is(err, ErrOperatorInactive) {
		t.Fatalf("suspended operator booking returned %v, want ErrOperatorInactive", err)
	}

	// The refusal rolled back before consuming the hold, so re-activating and
	// re-booking the same hold must now succeed — proving the block is the only
	// thing that stood in the way.
	if _, err := pool.Exec(ctx,
		`UPDATE catalog.operators SET status='ACTIVE' WHERE operator_id=$1::uuid`, operatorID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.CreateBooking(ctx, req); err != nil {
		t.Fatalf("active operator booking failed: %v", err)
	}
}

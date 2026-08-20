package httpapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

// Changing an operator's account status is a PLATFORM action. An operator user —
// even an owner — must never do it: the old handler let any OPERATOR_OWNER
// (who wrongly held operator.write) suspend or terminate a competitor, or
// re-activate their own suspended account. And the lifecycle must be enforced:
// TERMINATED is terminal, so a terminated tenant cannot be flipped back to
// ACTIVE. Both guards are exercised here; remove either and it goes red.
func TestOperatorStatusIsPlatformOnlyAndLifecycled(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	ctx := context.Background()

	// A throwaway operator to mutate, cleaned up on exit.
	var opID string
	if err := testPool.QueryRow(ctx,
		`INSERT INTO catalog.operators (legal_name, brand, status)
		 VALUES ('Audit Test Lines', 'AuditTest', 'ACTIVE') RETURNING operator_id::text`).
		Scan(&opID); err != nil {
		t.Fatal(err)
	}
	defer testPool.Exec(ctx, `DELETE FROM catalog.operators WHERE operator_id=$1::uuid`, opID)

	set := func(caller *staff.Identity, status string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/v1/admin/operators/"+opID+"/status",
			strings.NewReader(`{"status":"`+status+`"}`))
		req.SetPathValue("operatorID", opID)
		s.handleOperatorStatus(rec, req, caller)
		return rec.Code
	}

	// An operator owner (Green Line) is refused outright — the security fix.
	if code := set(ownerID(), "SUSPENDED"); code != 403 {
		t.Fatalf("operator owner changing an operator's status returned %d, want 403", code)
	}

	// Platform staff (no operator scope) may drive the lifecycle...
	platform := &staff.Identity{StaffID: greenLineOwner}
	if code := set(platform, "TERMINATED"); code != 200 { // ACTIVE -> TERMINATED is legal
		t.Fatalf("platform terminating an ACTIVE operator returned %d, want 200", code)
	}
	// ...but TERMINATED is terminal: it cannot be resurrected.
	if code := set(platform, "ACTIVE"); code != 409 {
		t.Fatalf("resurrecting a TERMINATED operator returned %d, want 409 illegal_transition", code)
	}
}

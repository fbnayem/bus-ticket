package httpapi

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

// The trip manifest carries passenger names, phone numbers and QR boarding
// tokens. Trip ids are handed out by public search for EVERY operator, so if the
// manifest does not check tenancy, one operator's id becomes a key to a
// competitor's passenger list. This proves an operator is refused another
// operator's manifest and still served their own. Remove the guard in
// handleManifest and the first assertion goes red.
func TestManifestRefusesAnotherOperatorsTrip(t *testing.T) {
	requireDB(t)
	s := ownerServer() // identity is pinned to Green Line via ownerID()
	ctx := context.Background()

	var shohaghTrip string
	if err := testPool.QueryRow(ctx,
		`SELECT trip_id::text FROM catalog.trips WHERE operator_id=$1::uuid LIMIT 1`,
		shohaghOperator).Scan(&shohaghTrip); err != nil {
		t.Skip("no shohagh trip in this database")
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/operator/trips/"+shohaghTrip+"/manifest", nil)
	req.SetPathValue("tripID", shohaghTrip)
	s.handleManifest(rec, req, ownerID())
	if rec.Code != 403 {
		t.Fatalf("Green Line reading a Shohagh manifest returned %d, want 403 — "+
			"a trip id must not leak another operator's passengers and QR tokens", rec.Code)
	}

	var glTrip string
	if err := testPool.QueryRow(ctx,
		`SELECT trip_id::text FROM catalog.trips WHERE operator_id=$1::uuid LIMIT 1`,
		greenLineOperator).Scan(&glTrip); err != nil {
		t.Skip("no green line trip")
	}
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/api/v1/operator/trips/"+glTrip+"/manifest", nil)
	req2.SetPathValue("tripID", glTrip)
	s.handleManifest(rec2, req2, ownerID())
	if rec2.Code != 200 {
		t.Fatalf("Green Line reading its OWN manifest returned %d, want 200", rec2.Code)
	}

	// Platform staff (no operator scope) may read any operator's manifest.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest("GET", "/api/v1/operator/trips/"+shohaghTrip+"/manifest", nil)
	req3.SetPathValue("tripID", shohaghTrip)
	s.handleManifest(rec3, req3, &staff.Identity{StaffID: greenLineOwner})
	if rec3.Code != 200 {
		t.Fatalf("platform staff (no operator) reading a manifest returned %d, want 200", rec3.Code)
	}
}

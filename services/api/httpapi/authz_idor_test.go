package httpapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

// A settlement statement is an operator's per-booking revenue book — every PNR,
// channel, and the gross/commission/refund/cash/net for each. The detail route is
// guarded only by settlement.read, which operator owners and accountants hold, and
// it took the settlement id straight from the path. Without an ownership check one
// operator's accountant could read a competitor's books by id. This proves the
// cross-tenant read is refused. Remove the guard in handleSettlementDetail and it
// goes red.
func TestSettlementDetailRefusesAnotherOperator(t *testing.T) {
	requireDB(t)
	s := ownerServer() // identity pinned to Green Line via ownerID()
	ctx := context.Background()

	var sid string
	if err := testPool.QueryRow(ctx,
		`SELECT settlement_id::text FROM finance.settlements WHERE operator_id=$1::uuid LIMIT 1`,
		shohaghOperator).Scan(&sid); err != nil {
		t.Skip("no shohagh settlement in this database to test cross-tenant refusal against")
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/admin/settlements/"+sid, nil)
	req.SetPathValue("settlementID", sid)
	s.handleSettlementDetail(rec, req, ownerID())
	if rec.Code != 404 {
		t.Fatalf("Green Line reading a Shohagh settlement statement returned %d, want 404 — "+
			"a settlement id must not leak a competitor's per-booking revenue book", rec.Code)
	}
}

// A driver's GPS ping is written against a trip id taken from the path, and trip
// ids are public (search hands them out for every operator). Without an ownership
// check a driver could POST a spoofed position onto a competitor's trip, and the
// passenger tracking page would show it as a live fix. This proves the write is
// refused across tenants. Remove the ownsTrip check in handlePosition and it goes
// red.
func TestPositionRefusesAnotherOperatorsTrip(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	ctx := context.Background()

	var shohaghTrip string
	if err := testPool.QueryRow(ctx,
		`SELECT trip_id::text FROM catalog.trips WHERE operator_id=$1::uuid LIMIT 1`,
		shohaghOperator).Scan(&shohaghTrip); err != nil {
		t.Skip("no shohagh trip in this database")
	}

	body := strings.NewReader(`{"lat":23.78,"lng":90.41}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/driver/trips/"+shohaghTrip+"/position", body)
	req.SetPathValue("tripID", shohaghTrip)
	s.handlePosition(rec, req, ownerID())
	if rec.Code != 403 {
		t.Fatalf("Green Line posting GPS to a Shohagh trip returned %d, want 403 — "+
			"a trip id must not let one operator spoof another's live position", rec.Code)
	}

	// Platform staff (no operator scope) may act on any trip: not a 403.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/v1/driver/trips/"+shohaghTrip+"/position",
		strings.NewReader(`{"lat":23.78,"lng":90.41}`))
	req2.SetPathValue("tripID", shohaghTrip)
	s.handlePosition(rec2, req2, &staff.Identity{StaffID: greenLineOwner})
	if rec2.Code == 403 {
		t.Fatalf("platform staff posting a position was refused with 403; only cross-operator writes should be")
	}
}

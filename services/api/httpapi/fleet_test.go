package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

const shohaghOperator = "11111111-1111-1111-1111-111111111112"

func createLayout(t *testing.T, s *Server, id *staff.Identity, name string) string {
	t.Helper()
	body, _ := json.Marshal(layoutRequest{
		Name:  name,
		Decks: 1,
		Seats: []layoutItem{
			{SeatNo: "A1", Row: 0, Col: 0, SeatType: "NORMAL"},
			{SeatNo: "A2", Row: 0, Col: 1, SeatType: "NORMAL"},
			{SeatNo: "B1", Row: 1, Col: 0, SeatType: "FEMALE_RESERVED"},
			{SeatNo: "B2", Row: 1, Col: 1, SeatType: "NORMAL"},
		},
	})
	rec := httptest.NewRecorder()
	s.handleCreateLayout(rec, httptest.NewRequest("POST", "/api/v1/operator/layouts", bytes.NewReader(body)), id)
	if rec.Code != 201 {
		t.Fatalf("create layout answered %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		LayoutID string `json:"layout_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.LayoutID
}

func putLayout(s *Server, id *staff.Identity, layoutID, name string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(layoutRequest{
		Name: name, Decks: 1,
		Seats: []layoutItem{{SeatNo: "A1", Row: 0, Col: 0, SeatType: "NORMAL"}},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/v1/operator/layouts/"+layoutID, bytes.NewReader(body))
	req.SetPathValue("layoutID", layoutID)
	s.handleUpdateLayout(rec, req, id)
	return rec
}

// A seat layout must stop being editable the moment a passenger could hold a
// ticket against it — a historical ticket has to stay readable against the map
// that was live when it was sold. This proves the gate: editable before any
// trip, locked after one.
func TestLayoutLocksAfterATripIsSold(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()
	id := ownerID()

	layoutID := createLayout(t, s, id, "Immutability Deck")

	// Editable while no trip has been sold against it.
	if rec := putLayout(s, id, layoutID, "Immutability Deck"); rec.Code != 200 {
		t.Fatalf("a fresh layout should be editable, got %d: %s", rec.Code, rec.Body.String())
	}

	// Stand up a route, a bus on this layout, and a trip on that bus.
	var routeID, busID string
	var busType string
	if err := testPool.QueryRow(ctx,
		`SELECT bus_type_id::text FROM catalog.bus_types LIMIT 1`).Scan(&busType); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO catalog.routes (operator_id, name)
		VALUES ($1::uuid,'Lock Test Route') RETURNING route_id::text`, greenLineOperator).Scan(&routeID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO catalog.buses (operator_id, registration, bus_type_id, layout_id, status)
		VALUES ($1::uuid, 'LOCK-'||substr(gen_random_uuid()::text,1,8), $2::uuid, $3::uuid, 'ACTIVE')
		RETURNING bus_id::text`, greenLineOperator, busType, layoutID).Scan(&busID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO catalog.trips (operator_id, route_id, bus_id, service_date, depart_at, segment_count, layout_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, catalog.bd_today(), now() + interval '2 hours', 1, $4::uuid)`,
		greenLineOperator, routeID, busID, layoutID); err != nil {
		t.Fatal(err)
	}

	// Now the edit must be refused. Remove the frozen/in-use guard in
	// handleUpdateLayout and this returns 200 instead — which is the bug.
	rec := putLayout(s, id, layoutID, "Immutability Deck")
	if rec.Code != 409 {
		t.Fatalf("editing a layout with a sold trip should be refused with 409, got %d: %s",
			rec.Code, rec.Body.String())
	}
}

// A tenant may not pin a bus to another operator's seat map. This proves the
// ownership check on the layout, not merely that the endpoint works.
func TestBusRejectsAnotherOperatorsLayout(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()

	// A layout owned by Shohagh, not Green Line.
	var foreignLayout string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO catalog.seat_layouts (operator_id, name, version, decks)
		VALUES ($1::uuid, 'Foreign Deck '||substr(gen_random_uuid()::text,1,8), 1, 1)
		RETURNING layout_id::text`, shohaghOperator).Scan(&foreignLayout); err != nil {
		t.Fatal(err)
	}
	var busType string
	if err := testPool.QueryRow(ctx,
		`SELECT bus_type_id::text FROM catalog.bus_types LIMIT 1`).Scan(&busType); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(busRequest{
		Registration: "TENANT-TEST", BusTypeID: busType, LayoutID: foreignLayout, Status: "ACTIVE",
	})
	rec := httptest.NewRecorder()
	// Green Line's owner attempting to use Shohagh's layout.
	s.handleCreateBus(rec, httptest.NewRequest("POST", "/api/v1/operator/buses", bytes.NewReader(body)), ownerID())
	if rec.Code != 403 {
		t.Fatalf("a bus on another operator's layout should be forbidden (403), got %d: %s",
			rec.Code, rec.Body.String())
	}
}

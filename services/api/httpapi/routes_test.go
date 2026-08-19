package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

func twoLocations(t *testing.T) (string, string) {
	t.Helper()
	rows, err := testPool.Query(context.Background(),
		`SELECT location_id::text FROM catalog.locations WHERE kind IN ('CITY','TERMINAL','DISTRICT') LIMIT 2`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		ids = append(ids, s)
	}
	if len(ids) < 2 {
		t.Fatal("seed has fewer than two locations")
	}
	return ids[0], ids[1]
}

func createRoute(t *testing.T, s *Server, id *staff.Identity, name string) string {
	t.Helper()
	a, b := twoLocations(t)
	body, _ := json.Marshal(routeCreateRequest{
		Name: name,
		Stops: []routeStopIn{
			{LocationID: a, IsBoarding: true},
			{LocationID: b, IsDropping: true},
		},
	})
	rec := httptest.NewRecorder()
	s.handleCreateRoute(rec, httptest.NewRequest("POST", "/api/v1/operator/routes", bytes.NewReader(body)), id)
	if rec.Code != 201 {
		t.Fatalf("create route answered %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		RouteID string `json:"route_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.RouteID
}

func putStops(s *Server, id *staff.Identity, routeID string) *httptest.ResponseRecorder {
	a, b := "", ""
	// Reuse whatever two locations the route already has, by asking the DB.
	rows, _ := testPool.Query(context.Background(),
		`SELECT location_id::text FROM catalog.route_stops WHERE route_id=$1::uuid ORDER BY stop_seq LIMIT 2`, routeID)
	var ids []string
	for rows.Next() {
		var v string
		_ = rows.Scan(&v)
		ids = append(ids, v)
	}
	rows.Close()
	a, b = ids[0], ids[1]
	body, _ := json.Marshal(routeStopsRequest{Stops: []routeStopIn{
		{LocationID: a, IsBoarding: true}, {LocationID: b, IsDropping: true},
	}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/v1/operator/routes/"+routeID+"/stops", bytes.NewReader(body))
	req.SetPathValue("routeID", routeID)
	s.handleSetRouteStops(rec, req, id)
	return rec
}

// A route's stops are the coordinate system its trips' seat maps are numbered
// against. Once a trip runs, the stops must freeze — renumbering them would
// reinterpret every seat already sold. This proves the gate.
func TestRouteStopsLockAfterATripRuns(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()
	id := ownerID()

	routeID := createRoute(t, s, id, "Lock Route Test")

	if rec := putStops(s, id, routeID); rec.Code != 200 {
		t.Fatalf("a route with no trips should accept a stop change, got %d: %s", rec.Code, rec.Body.String())
	}

	// Put a trip on this route using one of Green Line's existing buses.
	var busID, layoutID string
	if err := testPool.QueryRow(ctx, `
		SELECT bus_id::text, layout_id::text FROM catalog.buses
		 WHERE operator_id=$1::uuid LIMIT 1`, greenLineOperator).Scan(&busID, &layoutID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO catalog.trips (operator_id, route_id, bus_id, service_date, depart_at, segment_count, layout_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, catalog.bd_today(), now() + interval '3 hours', 1, $4::uuid)`,
		greenLineOperator, routeID, busID, layoutID); err != nil {
		t.Fatal(err)
	}

	// Remove the hasTrips guard in handleSetRouteStops and this returns 200.
	rec := putStops(s, id, routeID)
	if rec.Code != 409 {
		t.Fatalf("changing stops on a route with a trip should be refused with 409, got %d: %s",
			rec.Code, rec.Body.String())
	}
}

// A tenant may not read or reshape another operator's route.
func TestRouteDetailIsOperatorScoped(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()

	var foreignRoute string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO catalog.routes (operator_id, name)
		VALUES ($1::uuid, 'Shohagh Private '||substr(gen_random_uuid()::text,1,8))
		RETURNING route_id::text`, shohaghOperator).Scan(&foreignRoute); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/operator/routes/"+foreignRoute, nil)
	req.SetPathValue("routeID", foreignRoute)
	s.handleRouteDetail(rec, req, ownerID())
	if rec.Code != 403 {
		t.Fatalf("reading another operator's route should be forbidden (403), got %d: %s",
			rec.Code, rec.Body.String())
	}
}

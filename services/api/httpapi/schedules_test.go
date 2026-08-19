package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/busticket/platform/services/api/tripgen"
	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/staff/staff"
)

// daysFromMask expands a schedule's day bitmask, and the schema + the generator
// both number bit 0 as Monday. This unit test pins that convention — it caught
// the display reading bit 0 as Sunday, which showed operators the wrong days.
func TestDaysFromMaskIsMondayFirst(t *testing.T) {
	if got := daysFromMask(1); len(got) != 1 || got[0] != "Mon" {
		t.Fatalf("bit 0 should be Monday, got %v", got)
	}
	if got := daysFromMask(64); len(got) != 1 || got[0] != "Sun" {
		t.Fatalf("bit 6 should be Sunday, got %v", got)
	}
	if got := daysFromMask(127); len(got) != 7 {
		t.Fatalf("all seven bits should be all seven days, got %v", got)
	}
}

func schedServer() *Server {
	s := ownerServer()
	s.gen = tripgen.New(testPool, inventory.New(testPool))
	s.horizon = 14
	return s
}

func greenLineBus(t *testing.T) string {
	t.Helper()
	var busID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT bus_id::text FROM catalog.buses WHERE operator_id=$1::uuid LIMIT 1`, greenLineOperator).
		Scan(&busID); err != nil {
		t.Fatal(err)
	}
	return busID
}

func postSchedule(s *Server, id *staff.Identity, routeID, busID string, mask int) *httptest.ResponseRecorder {
	from := time.Now().Format("2006-01-02")
	body, _ := json.Marshal(scheduleRequest{
		RouteID: routeID, BusID: busID, DepartLocal: "23:00", DaysMask: mask, ValidFrom: from,
	})
	rec := httptest.NewRecorder()
	s.handleCreateSchedule(rec, httptest.NewRequest("POST", "/api/v1/operator/schedules", bytes.NewReader(body)), id)
	return rec
}

// Saving a schedule must put real, seat-bearing trips on the board at once, and
// a schedule that has already generated trips must not be deletable out from
// under them — it is ended, not erased.
func TestScheduleGeneratesTripsAndDeleteGuard(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := schedServer()
	id := ownerID()

	routeID := createRoute(t, s, id, "Sched Test Route")
	busID := greenLineBus(t)

	rec := postSchedule(s, id, routeID, busID, 127) // every day
	if rec.Code != 201 {
		t.Fatalf("create schedule answered %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ScheduleID string `json:"schedule_id"`
		Trips      int    `json:"trips_generated"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if created.Trips < 1 {
		t.Fatalf("an every-day schedule over a 14-day horizon generated %d trips, want at least 1", created.Trips)
	}

	// The trips are real: one exists for this schedule, OPEN, with seat
	// inventory opened against it.
	var tripID string
	var seatCount int
	if err := testPool.QueryRow(ctx, `
		SELECT t.trip_id::text,
		       (SELECT count(*) FROM inventory.trip_seats ts WHERE ts.trip_id = t.trip_id)
		  FROM catalog.trips t
		 WHERE t.schedule_id = $1::uuid AND t.status = 'OPEN'
		 ORDER BY t.service_date LIMIT 1`, created.ScheduleID).Scan(&tripID, &seatCount); err != nil {
		t.Fatalf("no OPEN trip materialised for the schedule: %v", err)
	}
	if seatCount < 1 {
		t.Fatalf("the generated trip has %d seats of inventory, want a full deck", seatCount)
	}

	// Delete is refused while trips exist — remove the trips>0 guard and this
	// becomes a 200, orphaning trips that may hold passengers.
	del := httptest.NewRecorder()
	dreq := httptest.NewRequest("DELETE", "/api/v1/operator/schedules/"+created.ScheduleID, nil)
	dreq.SetPathValue("scheduleID", created.ScheduleID)
	s.handleDeleteSchedule(del, dreq, id)
	if del.Code != 409 {
		t.Fatalf("deleting a schedule with trips should be refused with 409, got %d: %s", del.Code, del.Body.String())
	}

	// Ending it is the safe path and succeeds.
	end := httptest.NewRecorder()
	ereq := httptest.NewRequest("POST", "/api/v1/operator/schedules/"+created.ScheduleID+"/end", nil)
	ereq.SetPathValue("scheduleID", created.ScheduleID)
	s.handleEndSchedule(end, ereq, id)
	if end.Code != 200 {
		t.Fatalf("ending a schedule should succeed, got %d: %s", end.Code, end.Body.String())
	}
}

// A tenant may not build a schedule on another operator's bus.
func TestScheduleRejectsAnotherOperatorsBus(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := schedServer()
	id := ownerID()

	routeID := createRoute(t, s, id, "Sched Tenancy Route")

	var foreignBus string
	if err := testPool.QueryRow(ctx,
		`SELECT bus_id::text FROM catalog.buses WHERE operator_id=$1::uuid LIMIT 1`, shohaghOperator).
		Scan(&foreignBus); err != nil {
		t.Skipf("no Shohagh bus seeded to test against: %v", err)
	}

	rec := postSchedule(s, id, routeID, foreignBus, 127)
	if rec.Code != 403 {
		t.Fatalf("a schedule on another operator's bus should be forbidden (403), got %d: %s",
			rec.Code, rec.Body.String())
	}
}

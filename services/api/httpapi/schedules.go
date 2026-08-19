package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/staff/staff"
)

// Schedule and one-off trip management — the engine that turns a route and a bus
// into departures on the board.
//
// A schedule ("Dhaka→Chattogram, 10:00 PM, every day, from the 1st") is saved
// once and the generator materialises its trips over the rolling horizon
// immediately, so the operator sees the departures appear rather than waiting
// for the next tick. A one-off trip is the same machinery for a single extra
// departure with no schedule behind it — the Eid relief bus.

func (s *Server) scheduleRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/operator/schedules", s.guard("schedule.write", s.handleCreateSchedule))
	m.HandleFunc("POST /api/v1/operator/schedules/{scheduleID}/end", s.guard("schedule.write", s.handleEndSchedule))
	m.HandleFunc("DELETE /api/v1/operator/schedules/{scheduleID}", s.guard("schedule.write", s.handleDeleteSchedule))
	m.HandleFunc("POST /api/v1/operator/trips", s.guard("schedule.write", s.handleCreateOneOffTrip))
}

type scheduleRequest struct {
	RouteID     string `json:"route_id"`
	BusID       string `json:"bus_id"`
	DepartLocal string `json:"depart_local"` // "HH:MM", Dhaka wall-clock
	DaysMask    int    `json:"days_mask"`    // bit 0 = Monday
	ValidFrom   string `json:"valid_from"`   // "YYYY-MM-DD"
	ValidTo     string `json:"valid_to"`     // optional "YYYY-MM-DD"
}

type oneOffTripRequest struct {
	RouteID     string `json:"route_id"`
	BusID       string `json:"bus_id"`
	Date        string `json:"date"`         // "YYYY-MM-DD"
	DepartLocal string `json:"depart_local"` // "HH:MM"
}

// operatorOwnsRouteAndBus is the tenancy gate the schedule endpoints share: a
// schedule may only be built from this operator's own route and own bus.
func (s *Server) operatorOwnsRouteAndBus(r *http.Request, op, routeID, busID string) (bool, string) {
	var routeOwner, busOwner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.routes WHERE route_id=$1::uuid`, routeID).Scan(&routeOwner); err != nil {
		return false, "Choose a route."
	}
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.buses WHERE bus_id=$1::uuid`, busID).Scan(&busOwner); err != nil {
		return false, "Choose a bus."
	}
	if routeOwner != op || busOwner != op {
		return false, "That route or bus belongs to another operator."
	}
	return true, ""
}

func validClock(s string) bool {
	_, err := time.Parse("15:04", s)
	return err == nil
}

func (s *Server) handleCreateSchedule(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A schedule must belong to an operator.")
		return
	}
	var req scheduleRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if !validClock(req.DepartLocal) {
		fail(w, 400, "bad_time", "Enter a departure time as HH:MM.")
		return
	}
	if req.DaysMask <= 0 || req.DaysMask > 127 {
		fail(w, 400, "bad_days", "Choose at least one day of the week.")
		return
	}
	if _, err := time.Parse("2006-01-02", req.ValidFrom); err != nil {
		fail(w, 400, "bad_date", "Enter a start date.")
		return
	}
	if req.ValidTo != "" {
		if _, err := time.Parse("2006-01-02", req.ValidTo); err != nil {
			fail(w, 400, "bad_date", "That end date could not be read.")
			return
		}
	}
	if ok, msg := s.operatorOwnsRouteAndBus(r, op, req.RouteID, req.BusID); !ok {
		fail(w, 403, "forbidden", msg)
		return
	}

	var scheduleID string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO catalog.schedules
			(operator_id, route_id, bus_id, depart_local, days_mask, valid_from, valid_to)
		VALUES ($1::uuid,$2::uuid,$3::uuid,$4::time,$5,$6::date, NULLIF($7,'')::date)
		RETURNING schedule_id::text`,
		op, req.RouteID, req.BusID, req.DepartLocal, req.DaysMask, req.ValidFrom, req.ValidTo).
		Scan(&scheduleID); err != nil {
		s.log.Error("create schedule", "err", err)
		fail(w, 500, "schedule_failed", "The schedule could not be saved.")
		return
	}

	// Materialise this schedule's trips now. Generation is idempotent, so
	// re-running across every schedule adds only the new one's departures.
	created := 0
	if s.gen != nil {
		if res, err := s.gen.Generate(r.Context(), s.horizon); err != nil {
			s.log.Error("generate after schedule", "err", err)
		} else {
			created = res.TripsCreated
		}
	}
	s.stf.Audit(r.Context(), id, "schedule.create", "schedule:"+scheduleID, req.DepartLocal)
	writeJSON(w, 201, map[string]any{"schedule_id": scheduleID, "trips_generated": created})
}

func (s *Server) handleEndSchedule(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	scheduleID := r.PathValue("scheduleID")
	owner, ok := s.scheduleOwner(r, scheduleID)
	if !ok {
		fail(w, 404, "schedule_not_found", "That schedule does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That schedule belongs to another operator.")
		return
	}
	// End it today: generation stops beyond today, but every trip already on the
	// board — and every ticket sold against one — is left untouched. To pull a
	// specific future departure, the operator cancels that trip, which refunds
	// its passengers.
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE catalog.schedules SET valid_to = catalog.bd_today() WHERE schedule_id=$1::uuid`,
		scheduleID); err != nil {
		fail(w, 500, "schedule_failed", "The schedule could not be ended.")
		return
	}
	s.stf.Audit(r.Context(), id, "schedule.end", "schedule:"+scheduleID, "")
	writeJSON(w, 200, map[string]any{"schedule_id": scheduleID, "ended": true})
}

func (s *Server) handleDeleteSchedule(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	scheduleID := r.PathValue("scheduleID")
	owner, ok := s.scheduleOwner(r, scheduleID)
	if !ok {
		fail(w, 404, "schedule_not_found", "That schedule does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That schedule belongs to another operator.")
		return
	}
	// Delete is only for a schedule that has produced nothing yet — a mistake
	// caught immediately. Once trips exist, ending it is the safe path, because
	// those trips may already hold passengers.
	var trips int
	_ = s.pool.QueryRow(r.Context(),
		`SELECT count(*) FROM catalog.trips WHERE schedule_id=$1::uuid`, scheduleID).Scan(&trips)
	if trips > 0 {
		fail(w, 409, "schedule_in_use",
			"This schedule has already put trips on the board. End it instead — that keeps the trips already running.")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM catalog.schedules WHERE schedule_id=$1::uuid`, scheduleID); err != nil {
		fail(w, 500, "schedule_failed", "The schedule could not be deleted.")
		return
	}
	s.stf.Audit(r.Context(), id, "schedule.delete", "schedule:"+scheduleID, "")
	writeJSON(w, 200, map[string]any{"schedule_id": scheduleID, "deleted": true})
}

func (s *Server) handleCreateOneOffTrip(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A trip must belong to an operator.")
		return
	}
	var req oneOffTripRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if !validClock(req.DepartLocal) {
		fail(w, 400, "bad_time", "Enter a departure time as HH:MM.")
		return
	}
	if _, err := time.Parse("2006-01-02", strings.TrimSpace(req.Date)); err != nil {
		fail(w, 400, "bad_date", "Enter the date of the trip.")
		return
	}
	if ok, msg := s.operatorOwnsRouteAndBus(r, op, req.RouteID, req.BusID); !ok {
		fail(w, 403, "forbidden", msg)
		return
	}
	if s.gen == nil {
		fail(w, 500, "unavailable", "Trip generation is not available.")
		return
	}
	tripID, seats, err := s.gen.CreateOneOff(r.Context(), op, req.RouteID, req.BusID, req.Date, req.DepartLocal)
	if err != nil {
		s.log.Error("one-off trip", "err", err)
		fail(w, 400, "trip_failed", "That trip could not be created — check the route has its stops and fares set.")
		return
	}
	s.stf.Audit(r.Context(), id, "trip.oneoff", "trip:"+tripID, req.Date)
	writeJSON(w, 201, map[string]any{"trip_id": tripID, "seats": seats})
}

func (s *Server) scheduleOwner(r *http.Request, scheduleID string) (string, bool) {
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.schedules WHERE schedule_id=$1::uuid`, scheduleID).Scan(&owner); err != nil {
		return "", false
	}
	return owner, true
}

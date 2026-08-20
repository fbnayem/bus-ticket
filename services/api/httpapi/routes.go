package httpapi

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/staff/staff"
)

// Route and stop management — the write side of the network an operator sells
// across.
//
// A route's stops are numbered 0..N-1, dense and in travel order, because that
// numbering *is* the seat-inventory model: a segment ordinal k spans stop k to
// k+1, and a journey's seat demand is the bitmask (1<<drop) - (1<<board). So the
// stop list can be reshaped freely before the first trip runs and never after —
// once a trip exists, its materialised seat map is pinned to this exact stop
// sequence, and renumbering it would silently reinterpret every sold seat.

func (s *Server) routeCrudRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/operator/routes", s.guard("route.write", s.handleCreateRoute))
	m.HandleFunc("GET /api/v1/operator/routes/{routeID}", s.guard("route.read", s.handleRouteDetail))
	m.HandleFunc("PATCH /api/v1/operator/routes/{routeID}", s.guard("route.write", s.handleRenameRoute))
	m.HandleFunc("PUT /api/v1/operator/routes/{routeID}/stops", s.guard("route.write", s.handleSetRouteStops))
	m.HandleFunc("PUT /api/v1/operator/routes/{routeID}/segments", s.guard("route.write", s.handleSetRouteSegments))
}

type routeStopIn struct {
	LocationID string `json:"location_id"`
	IsBoarding bool   `json:"is_boarding"`
	IsDropping bool   `json:"is_dropping"`
}

type routeCreateRequest struct {
	Name  string        `json:"name"`
	Stops []routeStopIn `json:"stops"`
}

type routeStopsRequest struct {
	Stops []routeStopIn `json:"stops"`
}

type routeRenameRequest struct {
	Name string `json:"name"`
}

// validateStops checks a proposed stop list. A route needs at least two stops
// (nowhere to nowhere is not a journey) and at most 63 — the seat bitmask spans
// 62 segments, and trips CHECK segment_count BETWEEN 1 AND 62. The same place
// may not appear twice, since a bitmask has one bit per stop.
func validateStops(stops []routeStopIn) string {
	if len(stops) < 2 {
		return "A route needs at least a start and an end."
	}
	if len(stops) > 63 {
		return "A route can have at most 63 stops."
	}
	seen := map[string]bool{}
	for i := range stops {
		stops[i].LocationID = strings.TrimSpace(stops[i].LocationID)
		if stops[i].LocationID == "" {
			return "Every stop needs a place."
		}
		if seen[stops[i].LocationID] {
			return "The same place appears twice — each stop must be a different place."
		}
		seen[stops[i].LocationID] = true
	}
	return ""
}

// insertStops writes a dense 0-based stop sequence inside the caller's tx.
func insertStops(r *http.Request, tx pgx.Tx, routeID string, stops []routeStopIn) error {
	for seq, st := range stops {
		// The endpoints of a line are, by nature, a boarding point and a
		// dropping point respectively; default them so a caller that omits the
		// flags still gets a sensible route.
		board := st.IsBoarding || seq == 0
		drop := st.IsDropping || seq == len(stops)-1
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO catalog.route_stops (route_id, stop_seq, location_id, is_boarding, is_dropping)
			VALUES ($1::uuid,$2,$3::uuid,$4,$5)`,
			routeID, seq, st.LocationID, board, drop); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleCreateRoute(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A route must belong to an operator.")
		return
	}
	var req routeCreateRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		fail(w, 400, "bad_name", "Give the route a name.")
		return
	}
	if msg := validateStops(req.Stops); msg != "" {
		fail(w, 400, "bad_stops", msg)
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "route_failed", "The route could not be saved.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck

	var routeID string
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO catalog.routes (operator_id, name) VALUES ($1::uuid,$2) RETURNING route_id::text`,
		op, req.Name).Scan(&routeID); err != nil {
		fail(w, 500, "route_failed", "The route could not be saved.")
		return
	}
	if err := insertStops(r, tx, routeID, req.Stops); err != nil {
		s.log.Error("insert stops", "err", err)
		fail(w, 400, "bad_stops", "One of those stops is not a known place.")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "route_failed", "The route could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "route.create", "route:"+routeID, req.Name)
	writeJSON(w, 201, map[string]any{"route_id": routeID, "name": req.Name, "stops": len(req.Stops)})
}

func (s *Server) handleRouteDetail(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	routeID := r.PathValue("routeID")
	var name, owner string
	var hasTrips bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT name, operator_id::text,
		       EXISTS (SELECT 1 FROM catalog.trips t WHERE t.route_id = $1::uuid)
		  FROM catalog.routes WHERE route_id=$1::uuid`, routeID).Scan(&name, &owner, &hasTrips); err != nil {
		fail(w, 404, "route_not_found", "That route does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That route belongs to another operator.")
		return
	}

	// minutes[k] is the running time from stop k to stop k+1, so a stop carries the
	// leg time onward from it. LEFT JOIN keeps stops whose segment time is not yet
	// set (NULL surfaces as a gap the operator can fill).
	rows, err := s.pool.Query(r.Context(), `
		SELECT rs.stop_seq, rs.location_id::text, l.name, rs.is_boarding, rs.is_dropping, sm.minutes
		  FROM catalog.route_stops rs
		  JOIN catalog.locations l ON l.location_id = rs.location_id
		  LEFT JOIN catalog.route_segment_minutes sm
		         ON sm.route_id = rs.route_id AND sm.from_stop_seq = rs.stop_seq
		 WHERE rs.route_id=$1::uuid ORDER BY rs.stop_seq`, routeID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the stops.")
		return
	}
	defer rows.Close()
	stops := []map[string]any{}
	for rows.Next() {
		var seq int
		var locID, locName string
		var board, drop bool
		var minutes *int
		if rows.Scan(&seq, &locID, &locName, &board, &drop, &minutes) != nil {
			continue
		}
		stops = append(stops, map[string]any{
			"stop_seq": seq, "location_id": locID, "name": locName,
			"is_boarding": board, "is_dropping": drop, "minutes_to_next": minutes,
		})
	}
	farePairs, fullyPriced := s.routeFareCoverage(r, routeID, len(stops))
	writeJSON(w, 200, map[string]any{
		"route_id": routeID, "name": name, "editable": !hasTrips, "stops": stops,
		"fare_pairs": farePairs, "fully_priced": fullyPriced,
	})
}

type segmentIn struct {
	FromStopSeq int `json:"from_stop_seq"`
	Minutes     int `json:"minutes"`
}

type routeSegmentsRequest struct {
	Segments []segmentIn `json:"segments"`
}

// handleSetRouteSegments records how long each leg of a route takes, so the
// board can show a realistic arrival time at every intermediate stop rather than
// only a departure. A segment is keyed by its from-stop; minutes must be positive
// and the from-stop must be a real, non-final stop of the route. Unlike stops and
// fares, segment times are pure display — they touch no seat and no money — so
// they stay editable even after trips run: correcting a drive-time estimate never
// reinterprets a sold ticket.
func (s *Server) handleSetRouteSegments(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	routeID := r.PathValue("routeID")
	var req routeSegmentsRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	owner, ok := s.routeOwner(r, routeID)
	if !ok {
		fail(w, 404, "route_not_found", "That route does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That route belongs to another operator.")
		return
	}
	// The last stop has no onward leg, so a segment may start at any stop except
	// the final one: from_stop_seq must be in 0..stopCount-2.
	var stopCount int
	_ = s.pool.QueryRow(r.Context(),
		`SELECT count(*) FROM catalog.route_stops WHERE route_id=$1::uuid`, routeID).Scan(&stopCount)
	for _, seg := range req.Segments {
		if seg.Minutes <= 0 {
			fail(w, 400, "bad_minutes", "Every leg's time must be more than zero minutes.")
			return
		}
		if seg.FromStopSeq < 0 || seg.FromStopSeq >= stopCount-1 {
			fail(w, 400, "bad_segment", "A leg time was given for a stop that has no next stop.")
			return
		}
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "route_failed", "The times could not be saved.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	for _, seg := range req.Segments {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO catalog.route_segment_minutes (route_id, from_stop_seq, minutes)
			VALUES ($1::uuid,$2,$3)
			ON CONFLICT (route_id, from_stop_seq) DO UPDATE SET minutes = EXCLUDED.minutes`,
			routeID, seg.FromStopSeq, seg.Minutes); err != nil {
			fail(w, 500, "route_failed", "The times could not be saved.")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "route_failed", "The times could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "route.segments", "route:"+routeID, "")
	writeJSON(w, 200, map[string]any{"route_id": routeID, "segments": len(req.Segments)})
}

func (s *Server) handleRenameRoute(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	routeID := r.PathValue("routeID")
	var req routeRenameRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		fail(w, 400, "bad_name", "Give the route a name.")
		return
	}
	owner, ok := s.routeOwner(r, routeID)
	if !ok {
		fail(w, 404, "route_not_found", "That route does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That route belongs to another operator.")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE catalog.routes SET name=$2 WHERE route_id=$1::uuid`, routeID, req.Name); err != nil {
		fail(w, 500, "route_failed", "The route could not be renamed.")
		return
	}
	s.stf.Audit(r.Context(), id, "route.rename", "route:"+routeID, req.Name)
	writeJSON(w, 200, map[string]any{"route_id": routeID, "name": req.Name})
}

func (s *Server) handleSetRouteStops(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	routeID := r.PathValue("routeID")
	var req routeStopsRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if msg := validateStops(req.Stops); msg != "" {
		fail(w, 400, "bad_stops", msg)
		return
	}

	var owner string
	var hasTrips bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT operator_id::text,
		       EXISTS (SELECT 1 FROM catalog.trips t WHERE t.route_id = $1::uuid)
		  FROM catalog.routes WHERE route_id=$1::uuid`, routeID).Scan(&owner, &hasTrips); err != nil {
		fail(w, 404, "route_not_found", "That route does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That route belongs to another operator.")
		return
	}
	if hasTrips {
		fail(w, 409, "route_locked",
			"This route already has trips, so its stops can't be changed — the seats on those trips are numbered against this exact stop order. Create a new route instead.")
		return
	}

	// A fare and a segment time are keyed by stop_seq, and stop_seq only means
	// anything relative to which place sits at that ordinal. If the places change
	// — a stop inserted, removed or reordered — every surviving fare and segment
	// time silently re-attaches to a different journey. So decide up front whether
	// the *places* moved: read the current ordered location list and compare it to
	// the proposed one. Identical means this edit only toggled boarding/dropping
	// flags, and the prices stand; anything else remaps the ordinals and the old
	// prices must go rather than be quietly misattributed.
	oldLocs, err := s.routeLocationSeq(r, routeID)
	if err != nil {
		fail(w, 500, "route_failed", "The stops could not be saved.")
		return
	}
	newLocs := make([]string, len(req.Stops))
	for i, st := range req.Stops {
		newLocs[i] = st.LocationID
	}
	placesChanged := !sameStrings(oldLocs, newLocs)

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "route_failed", "The stops could not be saved.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM catalog.route_stops WHERE route_id=$1::uuid`, routeID); err != nil {
		fail(w, 500, "route_failed", "The stops could not be saved.")
		return
	}
	if err := insertStops(r, tx, routeID, req.Stops); err != nil {
		fail(w, 400, "bad_stops", "One of those stops is not a known place.")
		return
	}
	if placesChanged {
		// The seq->place map changed, so nothing keyed by seq can be trusted. Clear
		// this route's fares and segment times together; the operator re-prices the
		// new shape, and #19's coverage flag tells them it needs doing.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM catalog.route_fares WHERE route_id=$1::uuid`, routeID); err != nil {
			fail(w, 500, "route_failed", "The stops could not be saved.")
			return
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM catalog.route_segment_minutes WHERE route_id=$1::uuid`, routeID); err != nil {
			fail(w, 500, "route_failed", "The stops could not be saved.")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "route_failed", "The stops could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "route.stops", "route:"+routeID, "")
	writeJSON(w, 200, map[string]any{"route_id": routeID, "stops": len(req.Stops)})
}

// routeOwner returns the operator that owns a route, and whether it exists.
func (s *Server) routeOwner(r *http.Request, routeID string) (string, bool) {
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.routes WHERE route_id=$1::uuid`, routeID).Scan(&owner); err != nil {
		return "", false
	}
	return owner, true
}

// routeLocationSeq returns a route's stop places in ordinal order, so a stop
// edit can be compared place-for-place against the existing sequence.
func (s *Server) routeLocationSeq(r *http.Request, routeID string) ([]string, error) {
	rows, err := s.pool.Query(r.Context(),
		`SELECT location_id::text FROM catalog.route_stops WHERE route_id=$1::uuid ORDER BY stop_seq`, routeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var loc string
		if err := rows.Scan(&loc); err != nil {
			return nil, err
		}
		out = append(out, loc)
	}
	return out, rows.Err()
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// routeFareCoverage reports how completely a route is priced. A leg from stop i
// to stop j can only be sold if a fare covers it, and after #3 the search index
// withholds any leg it can't price — so an operator who set a name and stops but
// no fares would see their route simply not appear, with no hint why. These two
// figures drive a plain "priced / needs pricing" badge: fare_pairs is how many
// distinct (from,to) fares exist, and fully_priced is whether the end-to-end
// journey (first stop to last) — the one every route must sell — has a fare.
func (s *Server) routeFareCoverage(r *http.Request, routeID string, stopCount int) (pairs int, fullyPriced bool) {
	_ = s.pool.QueryRow(r.Context(),
		`SELECT count(DISTINCT (from_stop_seq, to_stop_seq)) FROM catalog.route_fares WHERE route_id=$1::uuid`,
		routeID).Scan(&pairs)
	if stopCount >= 2 {
		_ = s.pool.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM catalog.route_fares
			                WHERE route_id=$1::uuid AND from_stop_seq=0 AND to_stop_seq=$2)`,
			routeID, stopCount-1).Scan(&fullyPriced)
	}
	return pairs, fullyPriced
}

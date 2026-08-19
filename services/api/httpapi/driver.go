package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/staff/staff"
)

// The driver and crew app API.
//
// Boarding validation is a chain, and every link can only reject:
//
//	token signature -> ticket exists -> right trip -> not cancelled ->
//	not already boarded -> mark BOARDED
//
// The scan carries a client_ref minted on the device before the scan is sent,
// so a helper scanning with no signal can queue results and flush them later,
// repeatedly, without double-marking anyone.

func (s *Server) driverRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/driver/trips", s.guard("driver.trip", s.handleDriverTrips))
	m.HandleFunc("GET /api/v1/driver/trips/{tripID}/manifest", s.guard("driver.trip", s.handleManifest))
	m.HandleFunc("POST /api/v1/driver/trips/{tripID}/status", s.guard("driver.trip", s.handleDriverTripStatus))
	m.HandleFunc("POST /api/v1/driver/trips/{tripID}/position", s.guard("driver.trip", s.handlePosition))
	m.HandleFunc("POST /api/v1/driver/scan", s.guard("boarding.scan", s.handleScan))
	m.HandleFunc("GET /api/v1/driver/scans", s.guard("boarding.scan", s.handleScanLog))
	m.HandleFunc("POST /api/v1/driver/incidents", s.guard("driver.trip", s.handleReportIncident))
	m.HandleFunc("GET /api/v1/driver/incidents", s.guard("driver.trip", s.handleListIncidents))
}

// tripOperatorID returns the operator that owns a trip. A trip id is public —
// search hands it out for every operator — so any driver/crew action that reads
// or writes against one must confirm it belongs to the caller's operator first,
// or the trip id becomes a key into a competitor's operation.
func (s *Server) tripOperatorID(ctx context.Context, tripID string) (string, error) {
	var op string
	err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, tripID).Scan(&op)
	return op, err
}

// ownsTrip writes the appropriate failure and returns false when the caller may
// not act on this trip. Platform staff (no operator scope) may act on any.
func (s *Server) ownsTrip(w http.ResponseWriter, r *http.Request, id *staff.Identity, tripID string) bool {
	op, err := s.tripOperatorID(r.Context(), tripID)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "trip_not_found", "No trip with that reference.")
		return false
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not check that trip.")
		return false
	}
	if id.OperatorID != "" && id.OperatorID != op {
		fail(w, 403, "forbidden", "That trip belongs to another operator.")
		return false
	}
	return true
}

func (s *Server) handleDriverTrips(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	// A crew member sees the trips they are rostered on. If nobody has
	// assigned them yet, they see today's departures for their operator so
	// the app is usable on day one rather than an empty screen.
	rows, err := s.pool.Query(r.Context(), `
		SELECT t.trip_id::text, t.depart_at, t.status, r.name, b.registration,
		       COALESCE(tc.crew_role, 'UNASSIGNED'),
		       (SELECT count(*) FROM commerce.bookings bk
		          JOIN commerce.booking_seats bs ON bs.booking_id = bk.booking_id
		         WHERE bk.trip_id = t.trip_id
		           AND bk.status IN ('TICKETED','CONFIRMED','COMPLETED')),
		       (SELECT count(*) FROM commerce.tickets tk
		          JOIN commerce.bookings bk ON bk.booking_id = tk.booking_id
		         WHERE bk.trip_id = t.trip_id AND tk.status = 'BOARDED')
		  FROM catalog.trips t
		  JOIN catalog.routes r ON r.route_id = t.route_id
		  JOIN catalog.buses b ON b.bus_id = t.bus_id
		  LEFT JOIN ops.trip_crew tc ON tc.trip_id = t.trip_id AND tc.staff_id = $1::uuid
		 WHERE t.operator_id = $2::uuid
		   AND t.service_date BETWEEN catalog.bd_today() - 1 AND catalog.bd_today() + 2
		 ORDER BY (tc.staff_id IS NULL), t.depart_at
		 LIMIT 25`, id.StaffID, id.OperatorID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your trips.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, status, route, reg, role string
		var depart time.Time
		var pax, boarded int
		if rows.Scan(&tid, &depart, &status, &route, &reg, &role, &pax, &boarded) != nil {
			continue
		}
		out = append(out, map[string]any{
			"trip_id": tid, "depart_at": depart, "status": status, "route": route,
			"registration": reg, "crew_role": role,
			"passengers": pax, "boarded": boarded,
		})
	}
	writeJSON(w, 200, map[string]any{"trips": out})
}

// handleDriverTripStatus lets crew move a trip through the part of the
// lifecycle they are actually in a position to observe. A driver can say the
// bus has departed; a driver cannot cancel a trip.
func (s *Server) handleDriverTripStatus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req tripStatusRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	switch req.Status {
	case "BOARDING", "DEPARTED", "IN_PROGRESS", "ARRIVED":
	default:
		fail(w, 403, "not_permitted", "Crew can start boarding, depart and arrive. Cancelling is done by the office.")
		return
	}
	s.handleTripStatus(w, r, id)
}

type positionRequest struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	SpeedKph float64 `json:"speed_kph"`
	Heading  int     `json:"heading"`
}

// handlePosition ingests a GPS ping from the driver app. This is what turns
// the passenger tracking page from "estimated from the timetable" into a real
// position — and the tracking page says which of the two it is showing.
func (s *Server) handlePosition(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	var req positionRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.Lat == 0 && req.Lng == 0 {
		fail(w, 400, "bad_position", "A position needs a latitude and a longitude.")
		return
	}
	if !s.ownsTrip(w, r, id, tripID) {
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO ops.bus_positions (trip_id, lat, lng, speed_kph, heading, source)
		VALUES ($1::uuid, $2, $3, NULLIF($4,0), NULLIF($5,0), 'DRIVER_APP')`,
		tripID, req.Lat, req.Lng, req.SpeedKph, req.Heading); err != nil {
		fail(w, 500, "position_failed", "The position could not be recorded.")
		return
	}
	writeJSON(w, 202, map[string]any{"trip_id": tripID, "recorded": true})
}

type scanRequest struct {
	ClientRef string `json:"client_ref"`
	TripID    string `json:"trip_id"`
	QRToken   string `json:"qr_token"`
	PNR       string `json:"pnr"`
	SeatNo    string `json:"seat_no"`
	DeviceRef string `json:"device_ref"`
	ScannedAt string `json:"scanned_at"`
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	var req scanRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.ClientRef == "" {
		fail(w, 400, "client_ref_required", "Every scan needs a reference from the device.")
		return
	}
	// A crew member may only scan into their own operator's trip. Without this a
	// helper who knows a competitor's PNR/QR and trip id could flip that
	// passenger's ticket to BOARDED, so the real crew's later scan reads
	// ALREADY_BOARDED and a genuine passenger is challenged at the door.
	if req.TripID != "" && !s.ownsTrip(w, r, id, req.TripID) {
		return
	}

	// A replayed scan returns its original verdict. A helper flushing an
	// offline queue twice must not turn a valid boarding into a duplicate.
	var priorResult, priorSeat, priorPNR string
	err := s.pool.QueryRow(ctx, `
		SELECT result, COALESCE(seat_no,''), COALESCE(pnr,'')
		  FROM ops.boarding_scans WHERE client_ref = $1`, req.ClientRef).
		Scan(&priorResult, &priorSeat, &priorPNR)
	if err == nil {
		writeJSON(w, 200, map[string]any{
			"result": priorResult, "seat_no": priorSeat, "pnr": priorPNR,
			"replayed": true, "message": scanMessage(priorResult, priorSeat),
		})
		return
	}

	result, seat, pnr, passenger := s.validateScan(ctx, req)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO ops.boarding_scans
			(client_ref, trip_id, pnr, seat_no, result, scanned_by, device_ref, scanned_at)
		VALUES ($1, $2::uuid, NULLIF($3,''), NULLIF($4,''), $5, $6::uuid, NULLIF($7,''),
		        COALESCE(NULLIF($8,'')::timestamptz, now()))
		ON CONFLICT (client_ref) DO NOTHING`,
		req.ClientRef, req.TripID, pnr, seat, result, id.StaffID, req.DeviceRef, req.ScannedAt); err != nil {
		s.log.Error("record scan", "err", err)
	}

	status := 200
	if result != "BOARDED" {
		status = 409
	}
	writeJSON(w, status, map[string]any{
		"result": result, "seat_no": seat, "pnr": pnr, "passenger": passenger,
		"message": scanMessage(result, seat),
	})
}

// validateScan runs the chain. Note it never trusts the scanned payload for
// anything but lookup: the ticket row decides, not the QR contents.
func (s *Server) validateScan(ctx context.Context, req scanRequest) (result, seat, pnr, passenger string) {
	var ticketID, ticketStatus, bookingStatus, ticketTrip string
	query := `
		SELECT t.ticket_id::text, t.pnr, t.seat_no, t.status, b.status, b.trip_id::text,
		       COALESCE(p.full_name,'')
		  FROM commerce.tickets t
		  JOIN commerce.bookings b ON b.booking_id = t.booking_id
		  LEFT JOIN commerce.booking_passengers p
		         ON p.booking_id = t.booking_id AND p.seat_no = t.seat_no
		 WHERE `
	var row pgx.Row
	switch {
	case req.QRToken != "":
		row = s.pool.QueryRow(ctx, query+`t.qr_token = $1`, req.QRToken)
	case req.PNR != "" && req.SeatNo != "":
		row = s.pool.QueryRow(ctx, query+`t.pnr = upper($1) AND t.seat_no = $2`, req.PNR, req.SeatNo)
	case req.PNR != "":
		// A PNR alone is enough. A helper reading a booking reference off a
		// phone screen should not have to ask which seat it is; take the
		// first ticket on that PNR still waiting to board.
		row = s.pool.QueryRow(ctx, query+`t.pnr = upper($1)
			 ORDER BY (t.status <> 'VALID'), t.seat_no LIMIT 1`, req.PNR)
	default:
		return "BAD_TOKEN", "", "", ""
	}
	if err := row.Scan(&ticketID, &pnr, &seat, &ticketStatus, &bookingStatus, &ticketTrip, &passenger); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "NOT_FOUND", "", req.PNR, ""
		}
		return "BAD_TOKEN", "", "", ""
	}
	if ticketTrip != req.TripID {
		return "WRONG_TRIP", seat, pnr, passenger
	}
	if bookingStatus == "CANCELLED" || bookingStatus == "REFUNDED" || ticketStatus == "CANCELLED" {
		return "CANCELLED", seat, pnr, passenger
	}
	if ticketStatus == "BOARDED" {
		return "ALREADY_BOARDED", seat, pnr, passenger
	}

	// The mark itself is a conditional UPDATE, so two devices scanning the same
	// QR in the same second produce exactly one boarding and one duplicate.
	ct, err := s.pool.Exec(ctx, `
		UPDATE commerce.tickets SET status = 'BOARDED', boarded_at = now()
		 WHERE ticket_id = $1::uuid AND status = 'VALID'`, ticketID)
	if err != nil || ct.RowsAffected() != 1 {
		return "ALREADY_BOARDED", seat, pnr, passenger
	}
	return "BOARDED", seat, pnr, passenger
}

func scanMessage(result, seat string) string {
	switch result {
	case "BOARDED":
		return "Boarded — seat " + seat
	case "ALREADY_BOARDED":
		return "Already scanned. Seat " + seat + " is marked boarded."
	case "WRONG_TRIP":
		return "This ticket is for a different departure."
	case "CANCELLED":
		return "This ticket was cancelled. Do not board."
	case "NOT_FOUND":
		return "No ticket found for that code."
	default:
		return "That code could not be read."
	}
}

func (s *Server) handleScanLog(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.URL.Query().Get("trip_id")
	// Scoped to the caller's operator: an empty trip_id must not return the last
	// 60 scans across every operator, and a supplied one must belong to them.
	rows, err := s.pool.Query(r.Context(), `
		SELECT COALESCE(sc.pnr,''), COALESCE(sc.seat_no,''), sc.result, sc.scanned_at,
		       COALESCE(u.full_name,'')
		  FROM ops.boarding_scans sc
		  LEFT JOIN staff.staff_users u ON u.staff_id = sc.scanned_by
		  JOIN catalog.trips t ON t.trip_id = sc.trip_id
		 WHERE ($1='' OR sc.trip_id = $1::uuid)
		   AND ($2='' OR t.operator_id = $2::uuid)
		 ORDER BY sc.scanned_at DESC LIMIT 60`, tripID, id.OperatorID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load scans.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, seat, result, by string
		var at time.Time
		if rows.Scan(&pnr, &seat, &result, &at, &by) != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "seat_no": seat, "result": result, "scanned_at": at, "scanned_by": by,
		})
	}
	writeJSON(w, 200, map[string]any{"scans": out})
}

type incidentRequest struct {
	TripID   string `json:"trip_id"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Note     string `json:"note"`
}

func (s *Server) handleReportIncident(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req incidentRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.Note == "" {
		fail(w, 400, "note_required", "Describe what happened.")
		return
	}
	if req.Severity == "" {
		req.Severity = "LOW"
	}
	if !s.ownsTrip(w, r, id, req.TripID) {
		return
	}
	// The incident and the event that tells somebody about it are written in one
	// transaction. A breakdown recorded but not raised is a bus nobody comes for.
	var incidentID string
	if err := s.pool.QueryRow(r.Context(), `
		WITH i AS (
		    INSERT INTO ops.incidents (trip_id, kind, severity, note, reported_by)
		    VALUES ($1::uuid,$2,$3,$4,$5::uuid) RETURNING incident_id, trip_id, kind, note
		), o AS (
		    INSERT INTO ops.outbox (aggregate_id, event_type, payload)
		    SELECT i.trip_id, 'incident.reported', jsonb_build_object(
		        'trip_id', i.trip_id::text, 'incident_id', i.incident_id::text,
		        'kind', i.kind, 'note', i.note, 'severity', $3::text)
		      FROM i
		)
		SELECT incident_id::text FROM i`,
		req.TripID, req.Kind, req.Severity, req.Note, id.StaffID).Scan(&incidentID); err != nil {
		s.log.Error("incident", "err", err)
		fail(w, 500, "report_failed", "The report could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "ops.incident", "trip:"+req.TripID, req.Kind)
	writeJSON(w, 201, map[string]any{"incident_id": incidentID})
}

func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT i.incident_id::text, i.trip_id::text, i.kind, i.severity, i.note,
		       i.created_at, COALESCE(u.full_name,''), r.name, t.depart_at
		  FROM ops.incidents i
		  LEFT JOIN staff.staff_users u ON u.staff_id = i.reported_by
		  JOIN catalog.trips t ON t.trip_id = i.trip_id
		  JOIN catalog.routes r ON r.route_id = t.route_id
		 WHERE ($1='' OR t.operator_id = $1::uuid)
		 ORDER BY i.created_at DESC LIMIT 40`, id.OperatorID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load incidents.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var iid, tid, kind, severity, note, by, route string
		var at, depart time.Time
		if rows.Scan(&iid, &tid, &kind, &severity, &note, &at, &by, &route, &depart) != nil {
			continue
		}
		out = append(out, map[string]any{
			"incident_id": iid, "trip_id": tid, "kind": kind, "severity": severity,
			"note": note, "created_at": at, "reported_by": by,
			"route": route, "depart_at": depart,
		})
	}
	writeJSON(w, 200, map[string]any{"incidents": out})
}

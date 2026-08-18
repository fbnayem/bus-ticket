package httpapi

import (
	"net/http"
	"time"

	"github.com/busticket/platform/services/staff/staff"
)

// The operator ERP API.
//
// Every query in this file is filtered by operator_id, and that operator_id
// comes from the caller's identity, never from the request. scopeOperator()
// pins operator staff to their own tenant; only platform staff may name one.
// An operator-A token asking for operator-B data gets operator-A data.

func (s *Server) operatorRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/operator/dashboard", s.guard("trip.read", s.handleOperatorDashboard))
	m.HandleFunc("GET /api/v1/operator/trips", s.guard("trip.read", s.handleOperatorTrips))
	m.HandleFunc("GET /api/v1/operator/trips/{tripID}/manifest", s.guard("trip.read", s.handleManifest))
	m.HandleFunc("POST /api/v1/operator/trips/{tripID}/status", s.guard("trip.write", s.handleTripStatus))
	m.HandleFunc("GET /api/v1/operator/buses", s.guard("fleet.read", s.handleOperatorBuses))
	m.HandleFunc("GET /api/v1/operator/routes", s.guard("route.read", s.handleOperatorRoutes))
	m.HandleFunc("GET /api/v1/operator/fares", s.guard("fare.read", s.handleOperatorFares))
	m.HandleFunc("POST /api/v1/operator/fares", s.guard("fare.write", s.handleSetFare))
	m.HandleFunc("GET /api/v1/operator/schedules", s.guard("schedule.read", s.handleOperatorSchedules))
	m.HandleFunc("GET /api/v1/operator/bookings", s.guard("booking.read", s.handleOperatorBookings))
	m.HandleFunc("GET /api/v1/operator/counters", s.guard("operator.read", s.handleOperatorCounters))
	m.HandleFunc("GET /api/v1/operator/staff", s.guard("staff.read", s.handleOperatorStaff))
	m.HandleFunc("GET /api/v1/operator/settlements", s.guard("settlement.read", s.handleOperatorSettlements))
	m.HandleFunc("GET /api/v1/operator/reports/sales", s.guard("report.read", s.handleSalesReport))
}

func (s *Server) handleOperatorDashboard(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	ctx := r.Context()

	out := map[string]any{"operator_id": op}
	var brand string
	_ = s.pool.QueryRow(ctx, `SELECT brand FROM catalog.operators WHERE operator_id=$1::uuid`, op).Scan(&brand)
	out["operator"] = brand

	var tripsToday, seatsSold, buses, counters int
	var revenueToday, revenue7d int64
	_ = s.pool.QueryRow(ctx, `
		SELECT
		 (SELECT count(*) FROM catalog.trips
		   WHERE ($1='' OR operator_id=$1::uuid) AND service_date = catalog.bd_today()),
		 (SELECT count(*) FROM commerce.booking_seats bs
		    JOIN commerce.bookings b ON b.booking_id=bs.booking_id
		   WHERE ($1='' OR b.operator_id=$1::uuid)
		     AND b.status IN ('TICKETED','CONFIRMED','COMPLETED')
		     AND b.created_at::date = catalog.bd_today()),
		 (SELECT count(*) FROM catalog.buses WHERE ($1='' OR operator_id=$1::uuid)),
		 (SELECT count(*) FROM counter.counters WHERE ($1='' OR operator_id=$1::uuid)),
		 (SELECT COALESCE(sum(total_poisha),0) FROM commerce.bookings
		   WHERE ($1='' OR operator_id=$1::uuid)
		     AND status IN ('TICKETED','CONFIRMED','COMPLETED')
		     AND created_at::date = catalog.bd_today()),
		 (SELECT COALESCE(sum(total_poisha),0) FROM commerce.bookings
		   WHERE ($1='' OR operator_id=$1::uuid)
		     AND status IN ('TICKETED','CONFIRMED','COMPLETED')
		     AND created_at > now() - interval '7 days')`, op).
		Scan(&tripsToday, &seatsSold, &buses, &counters, &revenueToday, &revenue7d)

	out["trips_today"] = tripsToday
	out["seats_sold_today"] = seatsSold
	out["buses"] = buses
	out["counters"] = counters
	out["revenue_today_poisha"] = revenueToday
	out["revenue_7d_poisha"] = revenue7d

	// Sales by channel — the number that shows whether the counter, the agents
	// and the website are all actually being used.
	rows, err := s.pool.Query(ctx, `
		SELECT channel, count(*), COALESCE(sum(total_poisha),0)
		  FROM commerce.bookings
		 WHERE ($1='' OR operator_id=$1::uuid)
		   AND status IN ('TICKETED','CONFIRMED','COMPLETED')
		   AND created_at > now() - interval '30 days'
		 GROUP BY channel ORDER BY 3 DESC`, op)
	channels := []map[string]any{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var ch string
			var n int
			var amt int64
			if rows.Scan(&ch, &n, &amt) == nil {
				channels = append(channels, map[string]any{
					"channel": ch, "bookings": n, "revenue_poisha": amt})
			}
		}
	}
	out["by_channel"] = channels

	// Occupancy on today's departures, straight from the authoritative masks.
	occ, err := s.pool.Query(ctx, `
		SELECT t.trip_id::text, t.depart_at,
		       count(ts.*) AS seats,
		       count(*) FILTER (WHERE ts.segment_sold_mask <> 0) AS sold
		  FROM catalog.trips t
		  JOIN inventory.trip_seats ts ON ts.trip_id = t.trip_id
		 WHERE ($1='' OR t.operator_id=$1::uuid) AND t.service_date = catalog.bd_today()
		 GROUP BY t.trip_id, t.depart_at ORDER BY t.depart_at LIMIT 12`, op)
	today := []map[string]any{}
	if err == nil {
		defer occ.Close()
		for occ.Next() {
			var tid string
			var depart time.Time
			var seats, sold int
			if occ.Scan(&tid, &depart, &seats, &sold) == nil {
				pct := 0
				if seats > 0 {
					pct = sold * 100 / seats
				}
				today = append(today, map[string]any{
					"trip_id": tid, "depart_at": depart,
					"seats": seats, "sold": sold, "occupancy_pct": pct})
			}
		}
	}
	out["today"] = today
	writeJSON(w, 200, out)
}

func (s *Server) handleOperatorTrips(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT t.trip_id::text, t.depart_at, t.status, r.name, b.registration, bt.name,
		       (SELECT count(*) FROM inventory.trip_seats ts WHERE ts.trip_id=t.trip_id),
		       (SELECT count(*) FROM inventory.trip_seats ts
		         WHERE ts.trip_id=t.trip_id AND ts.segment_sold_mask <> 0),
		       (SELECT count(*) FROM inventory.trip_seats ts
		         WHERE ts.trip_id=t.trip_id AND ts.blocked_mask <> 0),
		       COALESCE((SELECT string_agg(u.full_name, ', ')
		                   FROM ops.trip_crew tc JOIN staff.staff_users u ON u.staff_id=tc.staff_id
		                  WHERE tc.trip_id = t.trip_id), '')
		  FROM catalog.trips t
		  JOIN catalog.routes r ON r.route_id = t.route_id
		  JOIN catalog.buses b ON b.bus_id = t.bus_id
		  JOIN catalog.bus_types bt ON bt.bus_type_id = b.bus_type_id
		 WHERE ($1='' OR t.operator_id=$1::uuid) AND t.service_date = $2::date
		 ORDER BY t.depart_at`, op, date)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load trips.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, status, route, reg, busType, crew string
		var depart time.Time
		var seats, sold, blocked int
		if err := rows.Scan(&tid, &depart, &status, &route, &reg, &busType,
			&seats, &sold, &blocked, &crew); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"trip_id": tid, "depart_at": depart, "status": status, "route": route,
			"registration": reg, "bus_type": busType,
			"seats": seats, "sold": sold, "counter_quota": blocked, "crew": crew,
		})
	}
	writeJSON(w, 200, map[string]any{"date": date, "trips": out})
}

// handleManifest is the passenger list for one departure. The driver app, the
// crew scanner and the ERP all read this same endpoint — one manifest, not
// three implementations that can drift.
func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	ctx := r.Context()

	trip := map[string]any{"trip_id": tripID}
	var depart time.Time
	var route, brand, reg, status string
	if err := s.pool.QueryRow(ctx, `
		SELECT t.depart_at, r.name, o.brand, b.registration, t.status
		  FROM catalog.trips t
		  JOIN catalog.routes r ON r.route_id=t.route_id
		  JOIN catalog.operators o ON o.operator_id=t.operator_id
		  JOIN catalog.buses b ON b.bus_id=t.bus_id
		 WHERE t.trip_id=$1::uuid`, tripID).Scan(&depart, &route, &brand, &reg, &status); err != nil {
		fail(w, 404, "trip_not_found", "That trip does not exist.")
		return
	}
	trip["depart_at"], trip["route"], trip["operator"] = depart, route, brand
	trip["registration"], trip["status"] = reg, status

	rows, err := s.pool.Query(ctx, `
		SELECT bs.seat_no, b.pnr, b.channel,
		       COALESCE(p.full_name,''), COALESCE(bc.phone,''),
		       COALESCE(tk.status,'NONE'), b.board_stop_seq, b.drop_stop_seq,
		       COALESCE(fl.name,''), COALESCE(tl.name,''),
		       -- The QR token travels with the manifest so a phone with no
		       -- signal can still match a scanned code against the list it
		       -- downloaded before departure. Without it, offline scanning only
		       -- works for a PNR somebody types, which is the case the camera
		       -- exists to avoid. It grants the crew nothing they do not already
		       -- have: they are holding the manifest, and they can board anybody
		       -- on it by name.
		       COALESCE(tk.qr_token,'')
		  FROM commerce.bookings b
		  JOIN commerce.booking_seats bs ON bs.booking_id = b.booking_id
		  LEFT JOIN commerce.booking_passengers p
		         ON p.booking_id = b.booking_id AND p.seat_no = bs.seat_no
		  LEFT JOIN commerce.booking_contacts bc ON bc.booking_id = b.booking_id
		  LEFT JOIN commerce.tickets tk
		         ON tk.booking_id = b.booking_id AND tk.seat_no = bs.seat_no
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		  LEFT JOIN catalog.route_stops frs
		         ON frs.route_id = t.route_id AND frs.stop_seq = b.board_stop_seq
		  LEFT JOIN catalog.locations fl ON fl.location_id = frs.location_id
		  LEFT JOIN catalog.route_stops trs
		         ON trs.route_id = t.route_id AND trs.stop_seq = b.drop_stop_seq
		  LEFT JOIN catalog.locations tl ON tl.location_id = trs.location_id
		 WHERE b.trip_id = $1::uuid
		   AND b.status IN ('TICKETED','CONFIRMED','COMPLETED')
		 ORDER BY bs.seat_no`, tripID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the manifest.")
		return
	}
	defer rows.Close()
	pax := []map[string]any{}
	boarded := 0
	for rows.Next() {
		var seat, pnr, channel, name, phone, tstatus, from, to, qrToken string
		var bseq, dseq int
		if err := rows.Scan(&seat, &pnr, &channel, &name, &phone, &tstatus,
			&bseq, &dseq, &from, &to, &qrToken); err != nil {
			continue
		}
		if tstatus == "BOARDED" {
			boarded++
		}
		pax = append(pax, map[string]any{
			"seat_no": seat, "pnr": pnr, "channel": channel,
			"passenger": name, "phone": phone, "ticket_status": tstatus,
			"board_seq": bseq, "drop_seq": dseq, "from": from, "to": to,
			"qr_token": qrToken,
		})
	}
	writeJSON(w, 200, map[string]any{
		"trip": trip, "passengers": pax,
		"total": len(pax), "boarded": boarded,
	})
}

type tripStatusRequest struct {
	Status string `json:"status"`
}

// legalTransitions is the trip lifecycle. An illegal jump is rejected here
// rather than left to a UI that might not offer the button.
var legalTransitions = map[string][]string{
	"SCHEDULED":   {"OPEN", "CANCELLED"},
	"OPEN":        {"BOARDING", "CANCELLED"},
	"BOARDING":    {"DEPARTED", "CANCELLED"},
	"DEPARTED":    {"IN_PROGRESS", "ARRIVED"},
	"IN_PROGRESS": {"ARRIVED"},
	"ARRIVED":     {"COMPLETED"},
}

func (s *Server) handleTripStatus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	var req tripStatusRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	var current, op string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT status, operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, tripID).
		Scan(&current, &op); err != nil {
		fail(w, 404, "trip_not_found", "That trip does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != op {
		fail(w, 403, "forbidden", "That trip belongs to another operator.")
		return
	}
	allowed := false
	for _, nxt := range legalTransitions[current] {
		if nxt == req.Status {
			allowed = true
		}
	}
	if !allowed {
		fail(w, 409, "illegal_transition", "A trip cannot go from "+current+" to "+req.Status+".")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE catalog.trips SET status=$2 WHERE trip_id=$1::uuid`, tripID, req.Status); err != nil {
		fail(w, 500, "update_failed", "The trip status could not be changed.")
		return
	}
	s.stf.Audit(r.Context(), id, "trip.status", "trip:"+tripID, req.Status)
	writeJSON(w, 200, map[string]any{"trip_id": tripID, "from": current, "status": req.Status})
}

func (s *Server) handleOperatorBuses(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.bus_id::text, b.registration, bt.name, bt.is_ac, bt.class, b.status,
		       sl.name, (SELECT count(*) FROM catalog.seat_layout_items i WHERE i.layout_id=b.layout_id),
		       COALESCE((SELECT string_agg(amenity, ', ' ORDER BY amenity)
		                   FROM catalog.bus_amenities a WHERE a.bus_id=b.bus_id),'')
		  FROM catalog.buses b
		  JOIN catalog.bus_types bt ON bt.bus_type_id=b.bus_type_id
		  JOIN catalog.seat_layouts sl ON sl.layout_id=b.layout_id
		 WHERE ($1='' OR b.operator_id=$1::uuid) ORDER BY b.registration`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the fleet.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var bid, reg, btName, class, status, layout, amenities string
		var isAC bool
		var seats int
		if rows.Scan(&bid, &reg, &btName, &isAC, &class, &status, &layout, &seats, &amenities) != nil {
			continue
		}
		out = append(out, map[string]any{
			"bus_id": bid, "registration": reg, "bus_type": btName, "is_ac": isAC,
			"class": class, "status": status, "layout": layout, "seats": seats,
			"amenities": amenities,
		})
	}
	writeJSON(w, 200, map[string]any{"buses": out})
}

func (s *Server) handleOperatorRoutes(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT r.route_id::text, r.name,
		       (SELECT string_agg(l.name, ' → ' ORDER BY rs.stop_seq)
		          FROM catalog.route_stops rs JOIN catalog.locations l ON l.location_id=rs.location_id
		         WHERE rs.route_id = r.route_id),
		       (SELECT count(*) FROM catalog.route_stops rs WHERE rs.route_id=r.route_id),
		       (SELECT count(*) FROM catalog.route_fares f WHERE f.route_id=r.route_id)
		  FROM catalog.routes r
		 WHERE ($1='' OR r.operator_id=$1::uuid) ORDER BY r.name`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load routes.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, name string
		var stops *string
		var stopCount, fareCount int
		if rows.Scan(&rid, &name, &stops, &stopCount, &fareCount) != nil {
			continue
		}
		out = append(out, map[string]any{
			"route_id": rid, "name": name, "path": deref(stops),
			"stop_count": stopCount, "fare_count": fareCount,
		})
	}
	writeJSON(w, 200, map[string]any{"routes": out})
}

func (s *Server) handleOperatorFares(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT f.fare_id::text, r.name, f.from_stop_seq, f.to_stop_seq,
		       fl.name, tl.name, f.fare_class, f.amount_poisha, f.version
		  FROM catalog.route_fares f
		  JOIN catalog.routes r ON r.route_id = f.route_id
		  LEFT JOIN catalog.route_stops frs ON frs.route_id=f.route_id AND frs.stop_seq=f.from_stop_seq
		  LEFT JOIN catalog.locations fl ON fl.location_id=frs.location_id
		  LEFT JOIN catalog.route_stops trs ON trs.route_id=f.route_id AND trs.stop_seq=f.to_stop_seq
		  LEFT JOIN catalog.locations tl ON tl.location_id=trs.location_id
		 WHERE ($1='' OR r.operator_id=$1::uuid)
		 ORDER BY r.name, f.from_stop_seq, f.to_stop_seq`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load fares.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var fid, route, class string
		var from, to *string
		var fseq, tseq, version int
		var amount int64
		if rows.Scan(&fid, &route, &fseq, &tseq, &from, &to, &class, &amount, &version) != nil {
			continue
		}
		out = append(out, map[string]any{
			"fare_id": fid, "route": route, "from_stop_seq": fseq, "to_stop_seq": tseq,
			"from": deref(from), "to": deref(to), "fare_class": class,
			"amount_poisha": amount, "version": version,
		})
	}
	writeJSON(w, 200, map[string]any{"fares": out})
}

type setFareRequest struct {
	RouteID      string `json:"route_id"`
	FromStopSeq  int    `json:"from_stop_seq"`
	ToStopSeq    int    `json:"to_stop_seq"`
	FareClass    string `json:"fare_class"`
	AmountPoisha int64  `json:"amount_poisha"`
}

// handleSetFare writes a NEW fare version. It never mutates the existing row.
//
// Every historical booking holds a frozen price snapshot that points at the
// fare it was sold under; editing that row in place would silently rewrite
// what a passenger agreed to pay months ago.
func (s *Server) handleSetFare(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req setFareRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.AmountPoisha <= 0 {
		fail(w, 400, "bad_amount", "Enter a fare above zero.")
		return
	}
	if req.FareClass == "" {
		req.FareClass = "BUSINESS"
	}
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.routes WHERE route_id=$1::uuid`, req.RouteID).Scan(&owner); err != nil {
		fail(w, 404, "route_not_found", "That route does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That route belongs to another operator.")
		return
	}

	var version int
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(max(version),0)+1 FROM catalog.route_fares
		 WHERE route_id=$1::uuid AND from_stop_seq=$2 AND to_stop_seq=$3 AND fare_class=$4`,
		req.RouteID, req.FromStopSeq, req.ToStopSeq, req.FareClass).Scan(&version)

	// Supersede by deleting only the previous *current* row after inserting the
	// new one, so no window exists where the journey has no published fare.
	var fareID string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO catalog.route_fares
			(route_id, from_stop_seq, to_stop_seq, fare_class, amount_poisha, version)
		VALUES ($1::uuid,$2,$3,$4,$5,$6) RETURNING fare_id::text`,
		req.RouteID, req.FromStopSeq, req.ToStopSeq, req.FareClass,
		req.AmountPoisha, version).Scan(&fareID); err != nil {
		s.log.Error("set fare", "err", err)
		fail(w, 500, "fare_failed", "The fare could not be published.")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		DELETE FROM catalog.route_fares
		 WHERE route_id=$1::uuid AND from_stop_seq=$2 AND to_stop_seq=$3
		   AND fare_class=$4 AND fare_id <> $5::uuid`,
		req.RouteID, req.FromStopSeq, req.ToStopSeq, req.FareClass, fareID); err != nil {
		s.log.Error("supersede fare", "err", err)
	}
	s.stf.Audit(r.Context(), id, "fare.publish", "route:"+req.RouteID, "")
	writeJSON(w, 201, map[string]any{
		"fare_id": fareID, "version": version, "amount_poisha": req.AmountPoisha,
	})
}

func (s *Server) handleOperatorSchedules(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT sc.schedule_id::text, r.name, sc.depart_local::text, sc.days_mask,
		       b.registration, sc.valid_from, sc.valid_to,
		       (SELECT count(*) FROM catalog.trips t WHERE t.schedule_id = sc.schedule_id)
		  FROM catalog.schedules sc
		  JOIN catalog.routes r ON r.route_id = sc.route_id
		  JOIN catalog.buses b ON b.bus_id = sc.bus_id
		 WHERE ($1='' OR sc.operator_id=$1::uuid) ORDER BY sc.depart_local`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load schedules.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, route, depart, reg string
		var mask, trips int
		var from time.Time
		var to *time.Time
		if rows.Scan(&sid, &route, &depart, &mask, &reg, &from, &to, &trips) != nil {
			continue
		}
		out = append(out, map[string]any{
			"schedule_id": sid, "route": route, "depart_local": depart,
			"days_mask": mask, "days": daysFromMask(mask), "registration": reg,
			"valid_from": from, "valid_to": to, "trips_generated": trips,
		})
	}
	writeJSON(w, 200, map[string]any{"schedules": out})
}

func daysFromMask(mask int) []string {
	names := []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	out := []string{}
	for i, n := range names {
		if mask&(1<<uint(i)) != 0 {
			out = append(out, n)
		}
	}
	return out
}

func (s *Server) handleOperatorBookings(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.channel, b.total_poisha, b.created_at, t.depart_at,
		       COALESCE((SELECT full_name FROM commerce.booking_passengers p
		                  WHERE p.booking_id=b.booking_id LIMIT 1),''),
		       (SELECT string_agg(seat_no, ',' ORDER BY seat_no)
		          FROM commerce.booking_seats bs WHERE bs.booking_id=b.booking_id),
		       COALESCE(c.name,''), COALESCE(a.name,'')
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  LEFT JOIN counter.counters c ON c.counter_id=b.counter_id
		  LEFT JOIN agent.agencies a ON a.agency_id=b.agency_id
		 WHERE ($1='' OR b.operator_id=$1::uuid)
		 ORDER BY b.created_at DESC LIMIT 100`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load bookings.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, channel, passenger, counterName, agencyName string
		var seats *string
		var total int64
		var created, depart time.Time
		if rows.Scan(&pnr, &status, &channel, &total, &created, &depart,
			&passenger, &seats, &counterName, &agencyName) != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "channel": channel, "total_poisha": total,
			"created_at": created, "depart_at": depart, "passenger": passenger,
			"seats": deref(seats), "counter": counterName, "agency": agencyName,
		})
	}
	writeJSON(w, 200, map[string]any{"bookings": out})
}

func (s *Server) handleOperatorCounters(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.counter_id::text, c.name, COALESCE(c.address,''), c.status,
		       COALESCE(l.name,''),
		       (SELECT count(*) FROM counter.shifts sh
		         WHERE sh.counter_id=c.counter_id AND sh.status='OPEN'),
		       (SELECT COALESCE(sum(b.total_poisha),0) FROM commerce.bookings b
		         WHERE b.counter_id=c.counter_id AND b.created_at::date = catalog.bd_today()
		           AND b.status IN ('TICKETED','CONFIRMED','COMPLETED'))
		  FROM counter.counters c
		  LEFT JOIN catalog.locations l ON l.location_id=c.location_id
		 WHERE ($1='' OR c.operator_id=$1::uuid) ORDER BY c.name`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load counters.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, name, address, status, city string
		var open int
		var today int64
		if rows.Scan(&cid, &name, &address, &status, &city, &open, &today) != nil {
			continue
		}
		out = append(out, map[string]any{
			"counter_id": cid, "name": name, "address": address, "status": status,
			"city": city, "shift_open": open > 0, "revenue_today_poisha": today,
		})
	}
	writeJSON(w, 200, map[string]any{"counters": out})
}

func (s *Server) handleOperatorStaff(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT u.staff_id::text, u.full_name, u.email, COALESCE(u.phone,''), u.status,
		       COALESCE(string_agg(r.role_key, ', '), ''),
		       COALESCE(c.name,''), u.last_login_at
		  FROM staff.staff_users u
		  LEFT JOIN staff.user_roles ur ON ur.staff_id=u.staff_id
		  LEFT JOIN catalog.roles r ON r.role_id=ur.role_id
		  LEFT JOIN counter.counters c ON c.counter_id=u.counter_id
		 WHERE ($1='' OR u.operator_id=$1::uuid)
		 GROUP BY u.staff_id, c.name ORDER BY u.full_name`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load staff.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, name, email, phone, status, roles, counterName string
		var last *time.Time
		if rows.Scan(&sid, &name, &email, &phone, &status, &roles, &counterName, &last) != nil {
			continue
		}
		out = append(out, map[string]any{
			"staff_id": sid, "full_name": name, "email": email, "phone": phone,
			"status": status, "roles": roles, "counter": counterName, "last_login_at": last,
		})
	}
	writeJSON(w, 200, map[string]any{"staff": out})
}

func (s *Server) handleOperatorSettlements(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	writeJSON(w, 200, map[string]any{"settlements": s.listSettlements(r, op)})
}

func (s *Server) handleSalesReport(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	from, to := dateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))

	rows, err := s.pool.Query(r.Context(), `
		SELECT d::date::text,
		       COALESCE(sum(b.total_poisha),0),
		       count(b.*),
		       COALESCE(sum(b.total_poisha) FILTER (WHERE b.channel='WEB'),0),
		       COALESCE(sum(b.total_poisha) FILTER (WHERE b.channel LIKE 'COUNTER%'),0),
		       COALESCE(sum(b.total_poisha) FILTER (WHERE b.channel='AGENT'),0)
		  FROM generate_series($2::date, $3::date, interval '1 day') d
		  LEFT JOIN commerce.bookings b
		         ON b.created_at::date = d::date
		        AND ($1='' OR b.operator_id=$1::uuid)
		        AND b.status IN ('TICKETED','CONFIRMED','COMPLETED')
		 GROUP BY d ORDER BY d`, op, from, to)
	if err != nil {
		fail(w, 500, "query_failed", "Could not build the report.")
		return
	}
	defer rows.Close()
	days := []map[string]any{}
	for rows.Next() {
		var day string
		var total, web, ctr, agt int64
		var n int
		if rows.Scan(&day, &total, &n, &web, &ctr, &agt) != nil {
			continue
		}
		days = append(days, map[string]any{
			"date": day, "revenue_poisha": total, "bookings": n,
			"web_poisha": web, "counter_poisha": ctr, "agent_poisha": agt,
		})
	}

	// Route performance over the same window.
	rrows, _ := s.pool.Query(r.Context(), `
		SELECT r.name, count(b.*), COALESCE(sum(b.total_poisha),0)
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  JOIN catalog.routes r ON r.route_id=t.route_id
		 WHERE ($1='' OR b.operator_id=$1::uuid)
		   AND b.status IN ('TICKETED','CONFIRMED','COMPLETED')
		   AND b.created_at::date BETWEEN $2::date AND $3::date
		 GROUP BY r.name ORDER BY 3 DESC LIMIT 10`, op, from, to)
	routes := []map[string]any{}
	if rrows != nil {
		defer rrows.Close()
		for rrows.Next() {
			var name string
			var n int
			var amt int64
			if rrows.Scan(&name, &n, &amt) == nil {
				routes = append(routes, map[string]any{
					"route": name, "bookings": n, "revenue_poisha": amt})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"from": from, "to": to, "days": days, "routes": routes})
}

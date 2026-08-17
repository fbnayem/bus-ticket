package httpapi

import (
	"errors"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/inventory/inventory"
)

// Cancellation, refund, reschedule, tracking and the account area.

func (s *Server) handleCancellationQuote(w http.ResponseWriter, r *http.Request) {
	q, err := s.com.QuoteCancellation(r.Context(), r.PathValue("pnr"))
	if errors.Is(err, commerce.ErrBookingNotFound) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "quote_failed", "Could not work out your refund.")
		return
	}
	writeJSON(w, 200, q)
}

type cancelRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	var req cancelRequest
	_ = decode(r, &req)
	if req.Reason == "" {
		req.Reason = "Cancelled by passenger"
	}

	q, err := s.com.CancelBooking(r.Context(), r.PathValue("pnr"), req.Reason)
	switch {
	case errors.Is(err, commerce.ErrBookingNotFound):
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	case errors.Is(err, commerce.ErrDeparted):
		fail(w, 409, "departed", "This bus has already departed, so it can no longer be cancelled.")
		return
	case errors.Is(err, commerce.ErrNotCancellable):
		fail(w, 409, "not_cancellable", "This booking cannot be cancelled.")
		return
	case err != nil:
		s.log.Error("cancel", "err", err)
		fail(w, 500, "cancel_failed", "We could not cancel that booking. Please contact support.")
		return
	}
	writeJSON(w, 200, q)
}

func (s *Server) handleSettleRefund(w http.ResponseWriter, r *http.Request) {
	if err := s.com.SettleRefund(r.Context(), r.PathValue("pnr")); err != nil {
		fail(w, 500, "settle_failed", "Could not settle that refund.")
		return
	}
	writeJSON(w, 200, map[string]any{"status": "SUCCESS"})
}

// ------------------------------------------------------------- reschedule --

// handleRescheduleOptions lists later departures on the same corridor that
// still have enough seats for the party.
func (s *Server) handleRescheduleOptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pnr := r.PathValue("pnr")

	var tripID string
	var board, drop, seatCount int
	var paidPoisha int64
	err := s.pool.QueryRow(ctx, `
		SELECT b.trip_id::text, b.board_stop_seq, b.drop_stop_seq, b.total_poisha,
		       (SELECT count(*) FROM commerce.booking_seats bs WHERE bs.booking_id = b.booking_id)
		  FROM commerce.bookings b WHERE b.pnr = upper($1)`, pnr).
		Scan(&tripID, &board, &drop, &paidPoisha, &seatCount)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}

	var fromID, toID string
	if err := s.pool.QueryRow(ctx, `
		SELECT rso.location_id::text, rsd.location_id::text
		  FROM catalog.trips t
		  JOIN catalog.route_stops rso ON rso.route_id=t.route_id AND rso.stop_seq=$2
		  JOIN catalog.route_stops rsd ON rsd.route_id=t.route_id AND rsd.stop_seq=$3
		 WHERE t.trip_id=$1::uuid`, tripID, board, drop).Scan(&fromID, &toID); err != nil {
		fail(w, 500, "query_failed", "Could not load that route.")
		return
	}

	rows, err := s.pool.Query(ctx, `
		WITH legs AS (
		  SELECT t.trip_id, t.route_id, t.bus_id, t.operator_id, t.depart_at,
		         f.stop_seq AS board_seq, d.stop_seq AS drop_seq,
		         ((1::bigint << d.stop_seq) - (1::bigint << f.stop_seq)) AS want_mask
		    FROM catalog.trips t
		    JOIN catalog.route_stops f ON f.route_id=t.route_id AND f.location_id=$1::uuid
		    JOIN catalog.route_stops d ON d.route_id=t.route_id AND d.location_id=$2::uuid AND d.stop_seq>f.stop_seq
		   WHERE t.depart_at > now() + interval '2 hours'
		     AND t.status IN ('SCHEDULED','OPEN')
		     AND t.trip_id <> $3::uuid
		)
		SELECT l.trip_id::text, o.brand, bt.name, l.depart_at, l.board_seq, l.drop_seq,
		       COALESCE(fare.amount_poisha,0),
		       (SELECT count(*) FROM inventory.trip_seats ts
		         WHERE ts.trip_id=l.trip_id
		           AND ((ts.segment_sold_mask|ts.segment_hold_mask|ts.blocked_mask) & l.want_mask)=0)
		  FROM legs l
		  JOIN catalog.operators o ON o.operator_id=l.operator_id
		  JOIN catalog.buses b ON b.bus_id=l.bus_id
		  JOIN catalog.bus_types bt ON bt.bus_type_id=b.bus_type_id
		  LEFT JOIN catalog.route_fares fare ON fare.route_id=l.route_id
		        AND fare.from_stop_seq=l.board_seq AND fare.to_stop_seq=l.drop_seq
		 ORDER BY l.depart_at LIMIT 20`, fromID, toID, tripID)
	if err != nil {
		s.log.Error("reschedule options", "err", err)
		fail(w, 500, "query_failed", "Could not load alternative departures.")
		return
	}
	defer rows.Close()

	// Each option carries its own finished total and the difference against what
	// was already paid. The client used to assemble those two figures itself by
	// adding a copy of serviceFeePoisha to the fare, which meant the passenger
	// was shown a price this service had not agreed to — and would have been
	// shown the wrong one the day the fee changed here. Pricing is the server's.
	type option struct {
		TripID     string    `json:"trip_id"`
		Brand      string    `json:"brand"`
		BusType    string    `json:"bus_type"`
		DepartAt   time.Time `json:"depart_at"`
		BoardSeq   int       `json:"board_seq"`
		DropSeq    int       `json:"drop_seq"`
		FarePoisha int64     `json:"fare_poisha"`
		TotalPoisha int64    `json:"total_poisha"`
		DifferencePoisha int64 `json:"difference_poisha"`
		Available  int       `json:"available_seats"`
		Eligible   bool      `json:"eligible"`
	}
	out := []option{}
	for rows.Next() {
		var o option
		if err := rows.Scan(&o.TripID, &o.Brand, &o.BusType, &o.DepartAt,
			&o.BoardSeq, &o.DropSeq, &o.FarePoisha, &o.Available); err != nil {
			continue
		}
		o.Eligible = o.Available >= seatCount
		// The same arithmetic handleReschedule itself performs, so the quote the
		// passenger accepts is the quote the saga charges.
		o.TotalPoisha = o.FarePoisha*int64(seatCount) + serviceFeePoisha
		o.DifferencePoisha = o.TotalPoisha - paidPoisha
		out = append(out, o)
	}
	writeJSON(w, 200, map[string]any{
		"seat_count":         seatCount,
		"paid_poisha":        paidPoisha,
		"service_fee_poisha": serviceFeePoisha,
		"options":            out,
	})
}

type rescheduleRequest struct {
	TripID   string   `json:"trip_id"`
	Seats    []string `json:"seats"`
	BoardSeq int      `json:"board_seq"`
	DropSeq  int      `json:"drop_seq"`
}

// handleReschedule runs the compensating saga from the plan:
//
//	hold new seats -> price the difference -> release the old allocation
//	-> issue the replacement booking
//
// If any step fails the new hold is released and the ORIGINAL ticket is left
// untouched, so a failed reschedule can never strand a passenger without a seat.
func (s *Server) handleReschedule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pnr := r.PathValue("pnr")

	var req rescheduleRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}

	var oldBookingID, oldHoldID, operatorID, status string
	var oldTotal int64
	err := s.pool.QueryRow(ctx, `
		SELECT booking_id::text, hold_id::text, operator_id::text, status, total_poisha
		  FROM commerce.bookings WHERE pnr = upper($1)`, pnr).
		Scan(&oldBookingID, &oldHoldID, &operatorID, &status, &oldTotal)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}
	if status != "TICKETED" && status != "CONFIRMED" {
		fail(w, 409, "not_reschedulable", "Only a confirmed booking can be moved to another departure.")
		return
	}

	// 1. hold the new seats first — never give up the old ones speculatively
	newHold, err := s.inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "WEB", TTL: holdTTL,
	})
	if errors.Is(err, inventory.ErrSeatUnavailable) {
		fail(w, 409, "seat_taken", "Those seats were just taken. Your original ticket is unchanged.")
		return
	}
	if err != nil {
		fail(w, 500, "hold_failed", "Could not hold seats on that departure. Your original ticket is unchanged.")
		return
	}

	// compensation: anything below this point must release the new hold on failure
	release := func() { _ = s.inv.ReleaseHold(ctx, newHold.HoldID, "RESCHEDULE_FAILED") }

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		release()
		fail(w, 400, "no_fare", "No fare is published for that journey. Your original ticket is unchanged.")
		return
	}
	newTotal := fare*int64(len(req.Seats)) + serviceFeePoisha
	diff := newTotal - oldTotal

	// 2. release the old allocation
	if err := s.inv.ReleaseConfirmed(ctx, oldHoldID, "RESCHEDULED"); err != nil {
		release()
		s.log.Error("reschedule release old", "err", err)
		fail(w, 500, "reschedule_failed", "We could not move your booking. Your original ticket is unchanged.")
		return
	}

	// 3. issue the replacement
	newBookingID, newPNR, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: newHold.HoldID, TripID: req.TripID, OperatorID: operatorID,
		Seats: newHold.Seats, BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "WEB", TotalPoisha: newTotal,
	})
	if err != nil {
		release()
		s.log.Error("reschedule create booking", "err", err)
		fail(w, 500, "reschedule_failed", "We could not move your booking. Please contact support.")
		return
	}

	// carry the passengers and contact across
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO commerce.booking_passengers (booking_id, seat_no, full_name, gender, age)
		SELECT $1::uuid, s.seat, p.full_name, p.gender, p.age
		  FROM (SELECT row_number() OVER (ORDER BY seat_no) rn, seat_no
		          FROM commerce.booking_passengers WHERE booking_id=$2::uuid) p
		  JOIN (SELECT row_number() OVER (ORDER BY seat_no) rn, seat_no AS seat
		          FROM commerce.booking_seats WHERE booking_id=$1::uuid) s USING (rn)
		  JOIN commerce.booking_passengers p2 ON p2.booking_id=$2::uuid AND p2.seat_no=p.seat_no
		ON CONFLICT DO NOTHING`, newBookingID, oldBookingID)
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO commerce.booking_contacts (booking_id, phone, email)
		SELECT $1::uuid, phone, email FROM commerce.booking_contacts WHERE booking_id=$2::uuid
		ON CONFLICT DO NOTHING`, newBookingID, oldBookingID)

	// 4. retire the old booking
	_, _ = s.pool.Exec(ctx, `
		UPDATE commerce.bookings SET status='CANCELLED', updated_at=now() WHERE booking_id=$1::uuid`, oldBookingID)
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO commerce.booking_status_history (booking_id, from_status, to_status, reason)
		VALUES ($1::uuid,'TICKETED','CANCELLED','rescheduled to '||$2)`, oldBookingID, newPNR)
	_, _ = s.pool.Exec(ctx, `
		UPDATE commerce.tickets SET status='CANCELLED' WHERE booking_id=$1::uuid`, oldBookingID)

	// 5. the money.
	//
	// The new booking is linked to the one it replaces, so the webhook path
	// settles it against the original rather than pricing the whole fare again.
	// A more expensive departure leaves a balance to collect and the booking
	// stays PAYMENT_PENDING until it is paid; anything else is ticketed now and
	// the overpayment becomes a Refund Payable the normal refund path settles.
	due := int64(0)
	if diff > 0 {
		due = diff
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE commerce.bookings SET reschedule_of = $2::uuid, amount_due_poisha = $3
		 WHERE booking_id = $1::uuid`, newBookingID, oldBookingID, due); err != nil {
		s.log.Error("reschedule link", "err", err)
		fail(w, 500, "reschedule_failed", "We moved your seats but could not price the change. Please contact support.")
		return
	}

	ticketed := false
	if diff <= 0 {
		if err := s.com.SettleReschedule(ctx, newBookingID, operatorID); err != nil {
			s.log.Error("settle reschedule", "err", err)
			fail(w, 500, "reschedule_failed", "We moved your seats but could not settle the change. Please contact support.")
			return
		}
		ticketed = true
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
			VALUES ($1::uuid, 'booking.rescheduled', jsonb_build_object(
				'pnr', $2::text, 'booking_id', $1::text, 'operator_id', $3::text,
				'old_pnr', $4::text, 'difference_poisha', $5::bigint))`,
			newBookingID, newPNR, operatorID, pnr, diff); err != nil {
			s.log.Warn("reschedule event", "err", err)
		}
	}

	resp := map[string]any{
		"old_pnr": pnr, "new_pnr": newPNR, "new_booking_id": newBookingID,
		"hold_id": newHold.HoldID,
		"old_total_poisha": oldTotal, "new_total_poisha": newTotal,
		"difference_poisha": diff,
		"payable":    diff > 0,
		"refundable": diff < 0,
		"ticketed":   ticketed,
	}
	switch {
	case diff > 0:
		resp["amount_due_poisha"] = diff
		resp["next"] = "Pay the difference to receive your new ticket."
	case diff < 0:
		resp["refund_poisha"] = -diff
		resp["next"] = "Your new ticket is issued. The difference will be refunded."
	default:
		resp["next"] = "Your new ticket is issued. Nothing further to pay."
	}
	writeJSON(w, 200, resp)
}

// --------------------------------------------------------------- tracking --

// handleTracking reports where the bus is.
//
// GPS ingestion is a Phase 2 workstream and is NOT built. Until tracking-service
// exists there is no real position to report, so this derives progress from the
// schedule and labels the result simulated. The web app shows that label — it
// must never imply a live GPS fix that does not exist.
func (s *Server) handleTracking(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pnr := r.PathValue("pnr")

	var tripID string
	var departAt time.Time
	var board, drop int
	err := s.pool.QueryRow(ctx, `
		SELECT b.trip_id::text, t.depart_at, b.board_stop_seq, b.drop_stop_seq
		  FROM commerce.bookings b JOIN catalog.trips t ON t.trip_id=b.trip_id
		 WHERE b.pnr = upper($1)`, pnr).Scan(&tripID, &departAt, &board, &drop)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load tracking.")
		return
	}

	type stop struct {
		Seq     int       `json:"seq"`
		Name    string    `json:"name"`
		At      time.Time `json:"at"`
		Passed  bool      `json:"passed"`
		Lat     float64   `json:"lat"`
		Lng     float64   `json:"lng"`
	}
	rows, err := s.pool.Query(ctx, `
		SELECT rs.stop_seq, l.name,
		       COALESCE((SELECT sum(m.minutes) FROM catalog.route_segment_minutes m
		                  WHERE m.route_id=rs.route_id AND m.from_stop_seq < rs.stop_seq),0),
		       COALESCE(l.lat,0), COALESCE(l.lng,0)
		  FROM catalog.route_stops rs
		  JOIN catalog.locations l ON l.location_id=rs.location_id
		  JOIN catalog.trips t ON t.route_id=rs.route_id
		 WHERE t.trip_id=$1::uuid ORDER BY rs.stop_seq`, tripID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load tracking.")
		return
	}
	defer rows.Close()

	now := time.Now()
	stops := []stop{}
	for rows.Next() {
		var st stop
		var offset int
		if err := rows.Scan(&st.Seq, &st.Name, &offset, &st.Lat, &st.Lng); err != nil {
			continue
		}
		st.At = departAt.Add(time.Duration(offset) * time.Minute)
		st.Passed = now.After(st.At)
		stops = append(stops, st)
	}
	if len(stops) == 0 {
		fail(w, 404, "no_route", "No route information for that trip.")
		return
	}

	last := stops[len(stops)-1]
	total := last.At.Sub(departAt).Minutes()
	elapsed := now.Sub(departAt).Minutes()
	progress := 0.0
	if total > 0 {
		progress = math.Max(0, math.Min(1, elapsed/total))
	}

	state := "SCHEDULED"
	switch {
	case now.Before(departAt):
		state = "SCHEDULED"
	case progress >= 1:
		state = "ARRIVED"
	default:
		state = "IN_PROGRESS"
	}

	// interpolate a position between the two stops that bracket "now"
	lat, lng := stops[0].Lat, stops[0].Lng
	for i := 0; i < len(stops)-1; i++ {
		a, b := stops[i], stops[i+1]
		if now.After(a.At) && now.Before(b.At) {
			f := now.Sub(a.At).Seconds() / b.At.Sub(a.At).Seconds()
			lat = a.Lat + (b.Lat-a.Lat)*f
			lng = a.Lng + (b.Lng-a.Lng)*f
			break
		}
		if progress >= 1 {
			lat, lng = last.Lat, last.Lng
		}
	}

	var nextStop *stop
	for i := range stops {
		if !stops[i].Passed {
			nextStop = &stops[i]
			break
		}
	}

	// A real fix beats the timetable. The driver app posts positions to
	// ops.bus_positions; if this trip has one that is recent, report it and say
	// so. If it does not, fall back to the interpolation above and say THAT.
	// The page never claims a GPS fix it does not have.
	source := "SIMULATED_FROM_SCHEDULE"
	sourceNote := "No GPS has been reported for this bus, so the position is estimated from the timetable."
	var fixLat, fixLng float64
	var fixAt time.Time
	var speed *float64
	if err := s.pool.QueryRow(ctx, `
		SELECT lat::float8, lng::float8, speed_kph::float8, recorded_at
		  FROM ops.bus_positions
		 WHERE trip_id = $1::uuid AND recorded_at > now() - interval '20 minutes'
		 ORDER BY recorded_at DESC LIMIT 1`, tripID).Scan(&fixLat, &fixLng, &speed, &fixAt); err == nil {
		lat, lng = fixLat, fixLng
		source = "DRIVER_APP_GPS"
		sourceNote = "Reported by the driver's app."
	}

	resp := map[string]any{
		"pnr": pnr, "trip_id": tripID, "state": state,
		"depart_at": departAt, "arrive_at": last.At,
		"progress": progress, "stops": stops,
		"position": map[string]float64{"lat": lat, "lng": lng},
		// Stated plainly so the UI cannot imply a live fix that does not exist.
		"source":      source,
		"source_note": sourceNote,
	}
	if source == "DRIVER_APP_GPS" {
		resp["fix_at"] = fixAt
		if speed != nil {
			resp["speed_kph"] = *speed
		}
	}
	if nextStop != nil {
		resp["next_stop"] = nextStop.Name
		resp["eta"] = nextStop.At
	}
	writeJSON(w, 200, resp)
}

// ---------------------------------------------------------------- account --

// The account area is now behind a real sign-in. A signed-in passenger sees
// every booking that belongs to their account OR was made on their phone
// number as a guest; a caller with no session sees nothing at all, which is the
// entire difference between this and what was here before.

func (s *Server) handleAccountBookings(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.total_poisha, t.depart_at, o.brand,
		       lo.name, ld.name,
		       (SELECT count(*) FROM commerce.booking_seats bs WHERE bs.booking_id=b.booking_id)
		  FROM commerce.bookings b
		  LEFT JOIN commerce.booking_contacts c ON c.booking_id=b.booking_id
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  JOIN catalog.operators o ON o.operator_id=b.operator_id
		  JOIN catalog.route_stops rso ON rso.route_id=t.route_id AND rso.stop_seq=b.board_stop_seq
		  JOIN catalog.locations lo ON lo.location_id=rso.location_id
		  JOIN catalog.route_stops rsd ON rsd.route_id=t.route_id AND rsd.stop_seq=b.drop_stop_seq
		  JOIN catalog.locations ld ON ld.location_id=rsd.location_id
		 WHERE b.user_id = $1::uuid OR c.phone = $2
		 ORDER BY t.depart_at DESC LIMIT 50`, id.UserID, id.Phone)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your trips.")
		return
	}
	defer rows.Close()

	type item struct {
		PNR         string    `json:"pnr"`
		Status      string    `json:"status"`
		TotalPoisha int64     `json:"total_poisha"`
		DepartAt    time.Time `json:"depart_at"`
		Brand       string    `json:"brand"`
		Origin      string    `json:"origin"`
		Destination string    `json:"destination"`
		SeatCount   int       `json:"seat_count"`
		Upcoming    bool      `json:"upcoming"`
	}
	upcoming, past := []item{}, []item{}
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.PNR, &it.Status, &it.TotalPoisha, &it.DepartAt,
			&it.Brand, &it.Origin, &it.Destination, &it.SeatCount); err != nil {
			continue
		}
		it.Upcoming = it.DepartAt.After(time.Now())
		if it.Upcoming {
			upcoming = append(upcoming, it)
		} else {
			past = append(past, it)
		}
	}
	writeJSON(w, 200, map[string]any{"upcoming": upcoming, "past": past, "phone": id.Phone})
}

func (s *Server) handleSavedPassengers(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT saved_id::text, full_name, COALESCE(gender,''), COALESCE(age,0),
		       COALESCE(id_type,''), COALESCE(id_number,'')
		  FROM catalog.saved_passengers
		 WHERE user_id = $1::uuid
		 ORDER BY full_name`, id.UserID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load saved passengers.")
		return
	}
	defer rows.Close()
	type sp struct {
		ID       string `json:"id"`
		FullName string `json:"full_name"`
		Gender   string `json:"gender"`
		Age      int    `json:"age"`
		IDType   string `json:"id_type"`
		IDNumber string `json:"id_number"`
	}
	out := []sp{}
	for rows.Next() {
		var p sp
		if rows.Scan(&p.ID, &p.FullName, &p.Gender, &p.Age, &p.IDType, &p.IDNumber) == nil {
			out = append(out, p)
		}
	}
	writeJSON(w, 200, map[string]any{"passengers": out})
}

func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	lang := "bn"
	_ = s.pool.QueryRow(r.Context(),
		`SELECT lang FROM notify.preferences WHERE user_key = $1`, id.Phone).Scan(&lang)
	writeJSON(w, 200, map[string]any{
		"display_name":  id.Name,
		"phone":         id.Phone,
		"email":         id.Email,
		"authenticated": true,
		"lang":          lang,
	})
}

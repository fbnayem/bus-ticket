package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/identity/identity"
	"github.com/busticket/platform/services/inventory/inventory"
)

// inventoryMask re-exports the segment arithmetic so the read paths in this
// package compute availability exactly the way the inventory service does.
// There is one implementation of this rule and this is a call into it.
func inventoryMask(board, drop int) (int64, error) { return inventory.SegmentMask(board, drop) }

const (
	serviceFeePoisha = 5000 // ৳50 platform service fee per booking
	holdBurst        = 20   // seat holds one caller may open per minute
	resendBurst      = 5    // ticket resends allowed per PNR per hour
	holdTTL          = 10 * time.Minute
)

// ------------------------------------------------------------------- holds --

type holdRequest struct {
	TripID   string   `json:"trip_id"`
	Seats    []string `json:"seats"`
	BoardSeq int      `json:"board_seq"`
	DropSeq  int      `json:"drop_seq"`
	Channel  string   `json:"channel"`
}

type priceBreakdown struct {
	FarePoisha       int64  `json:"fare_poisha"`
	SeatCount        int    `json:"seat_count"`
	BasePoisha       int64  `json:"base_poisha"`
	ServiceFeePoisha int64  `json:"service_fee_poisha"`
	DiscountPoisha   int64  `json:"discount_poisha"`
	TotalPoisha      int64  `json:"total_poisha"`
	CouponCode       string `json:"coupon_code,omitempty"`
}

func (s *Server) handleCreateHold(w http.ResponseWriter, r *http.Request) {
	var req holdRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if len(req.Seats) == 0 {
		fail(w, 400, "no_seats", "Choose at least one seat.")
		return
	}
	if len(req.Seats) > 6 {
		fail(w, 400, "too_many_seats", "You can book up to 6 seats at a time.")
		return
	}
	if req.Channel == "" {
		req.Channel = "WEB"
	}

	// A hold locks real inventory before any payment, so an unthrottled hold
	// endpoint is an inventory-denial weapon: a script could hold every seat on
	// every bus and never pay, and the seats would only free on TTL. Cap how
	// often one caller may open a hold. Redis being down fails open (Allow
	// returns true), because a cache outage must not stop genuine sales — the
	// hold TTL and the seat sweeper remain the real guarantee.
	if s.cache != nil {
		if ok, _ := s.cache.Allow(r.Context(), "rl:hold:"+clientIP(r), holdBurst, time.Minute); !ok {
			fail(w, 429, "too_many_holds", "Too many booking attempts in a short time. Please wait a moment and try again.")
			return
		}
	}

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	pb := priceBreakdown{
		FarePoisha: fare, SeatCount: len(req.Seats),
		BasePoisha: fare * int64(len(req.Seats)), ServiceFeePoisha: serviceFeePoisha,
	}
	pb.TotalPoisha = pb.BasePoisha + pb.ServiceFeePoisha

	snapshot := fmt.Sprintf(
		`{"fare_poisha":%d,"seats":%d,"base_poisha":%d,"service_fee_poisha":%d,"total_poisha":%d}`,
		pb.FarePoisha, pb.SeatCount, pb.BasePoisha, pb.ServiceFeePoisha, pb.TotalPoisha)

	hold, err := s.inv.AcquireHold(r.Context(), inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: req.Channel, TTL: holdTTL,
		PriceSnapshot: []byte(snapshot),
	})
	switch {
	case errors.Is(err, inventory.ErrSeatUnavailable):
		// Somebody else took it in the seconds since the map was drawn.
		fail(w, 409, "seat_taken", "Someone just took one of those seats. Pick another and try again.")
		return
	case errors.Is(err, inventory.ErrBadSegments):
		fail(w, 400, "bad_segments", "That boarding and dropping combination is not valid.")
		return
	case err != nil:
		s.log.Error("acquire hold", "err", err)
		fail(w, 500, "hold_failed", "We could not hold those seats. Please try again.")
		return
	}

	writeJSON(w, 201, map[string]any{
		"hold_id": hold.HoldID, "trip_id": hold.TripID, "seats": hold.Seats,
		"board_seq": req.BoardSeq, "drop_seq": req.DropSeq,
		"expires_at": hold.ExpiresAt, "price": pb,
	})
}

func (s *Server) fareFor(r *http.Request, tripID string, board, drop int) (int64, error) {
	// Deterministic and matched to what search shows: the cheapest current fare
	// for the leg. Without the ORDER BY, a leg priced in more than one class or
	// version returned an arbitrary row, so the price a passenger was charged
	// could differ from the one they saw in search. (Per-seat-class pricing is a
	// separate, larger change — tracked with the seat-layout fare_class work.)
	var fare int64
	err := s.pool.QueryRow(r.Context(), `
		SELECT f.amount_poisha
		  FROM catalog.trips t
		  JOIN catalog.route_fares f ON f.route_id = t.route_id
		 WHERE t.trip_id = $1::uuid AND f.from_stop_seq = $2 AND f.to_stop_seq = $3
		 ORDER BY f.amount_poisha ASC, f.version DESC
		 LIMIT 1`, tripID, board, drop).Scan(&fare)
	return fare, err
}

func (s *Server) handleGetHold(w http.ResponseWriter, r *http.Request) {
	holdID := r.PathValue("holdID")
	var status, tripID string
	var expires time.Time
	var snapshot []byte
	err := s.pool.QueryRow(r.Context(), `
		SELECT status, trip_id::text, expires_at, price_snapshot
		  FROM inventory.seat_holds WHERE hold_id = $1::uuid`, holdID).
		Scan(&status, &tripID, &expires, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "hold_not_found", "That seat hold no longer exists.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the hold.")
		return
	}
	seats := []string{}
	rows, _ := s.pool.Query(r.Context(),
		`SELECT seat_no FROM inventory.seat_hold_items WHERE hold_id=$1::uuid ORDER BY seat_no`, holdID)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var sn string
			if rows.Scan(&sn) == nil {
				seats = append(seats, sn)
			}
		}
	}
	// The frozen price snapshot has always been read here and then thrown away,
	// which is why a passenger who reloaded checkout — or opened the link on
	// another device — was shown a form asking for names with no trip and no
	// total attached. The price is the hold's own, taken at hold time and never
	// recomputed, so returning it is strictly more honest than letting the
	// client reconstruct one.
	body := map[string]any{
		"hold_id": holdID, "trip_id": tripID, "status": status,
		"expires_at": expires, "seats": seats,
		"expired": time.Now().After(expires) && status == "HELD",
	}
	// Re-emitted through priceBreakdown rather than passed through raw. The
	// stored snapshot predates that struct and spells the seat count "seats",
	// so handing it back verbatim would make GET /holds/{id} and POST /holds
	// disagree about the shape of the same object — and a client written
	// against one would silently read undefined from the other.
	if len(snapshot) > 0 {
		var snap struct {
			FarePoisha       int64  `json:"fare_poisha"`
			SeatCount        int    `json:"seat_count"`
			Seats            int    `json:"seats"`
			BasePoisha       int64  `json:"base_poisha"`
			ServiceFeePoisha int64  `json:"service_fee_poisha"`
			DiscountPoisha   int64  `json:"discount_poisha"`
			TotalPoisha      int64  `json:"total_poisha"`
			CouponCode       string `json:"coupon_code"`
		}
		if json.Unmarshal(snapshot, &snap) == nil {
			count := snap.SeatCount
			if count == 0 {
				count = snap.Seats
			}
			if count == 0 {
				count = len(seats)
			}
			body["price"] = priceBreakdown{
				FarePoisha:       snap.FarePoisha,
				SeatCount:        count,
				BasePoisha:       snap.BasePoisha,
				ServiceFeePoisha: snap.ServiceFeePoisha,
				DiscountPoisha:   snap.DiscountPoisha,
				TotalPoisha:      snap.TotalPoisha,
				CouponCode:       snap.CouponCode,
			}
		}
	}
	writeJSON(w, 200, body)
}

func (s *Server) handleReleaseHold(w http.ResponseWriter, r *http.Request) {
	if err := s.inv.ReleaseHold(r.Context(), r.PathValue("holdID"), "USER_ABANDONED"); err != nil {
		if errors.Is(err, inventory.ErrHoldNotFound) {
			fail(w, 404, "hold_not_found", "That seat hold no longer exists.")
			return
		}
		fail(w, 500, "release_failed", "Could not release those seats.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------- bookings --

type passengerIn struct {
	SeatNo   string `json:"seat_no"`
	FullName string `json:"full_name"`
	Gender   string `json:"gender"`
	Age      int    `json:"age"`
	IDType   string `json:"id_type"`
	IDNumber string `json:"id_number"`
}

type bookingRequest struct {
	HoldID     string        `json:"hold_id"`
	Passengers []passengerIn `json:"passengers"`
	Phone      string        `json:"phone"`
	Email      string        `json:"email"`
	CouponCode string        `json:"coupon_code"`
}

func (s *Server) handleCreateBooking(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req bookingRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.Phone == "" {
		fail(w, 400, "phone_required", "A mobile number is required so we can send your ticket.")
		return
	}
	if len(req.Passengers) == 0 {
		fail(w, 400, "passengers_required", "Enter details for each passenger.")
		return
	}

	// The hold is the authority on what is being bought.
	var tripID, holdStatus string
	var expires time.Time
	var boardSeq, dropSeq int
	err := s.pool.QueryRow(ctx, `
		SELECT h.trip_id::text, h.status, h.expires_at
		  FROM inventory.seat_holds h WHERE h.hold_id = $1::uuid`, req.HoldID).
		Scan(&tripID, &holdStatus, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "hold_not_found", "Your seat hold has expired. Please choose your seats again.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not read your seat hold.")
		return
	}
	if holdStatus != "HELD" || time.Now().After(expires) {
		fail(w, 409, "hold_expired", "Your seat hold has expired. Please choose your seats again.")
		return
	}

	seats := []string{}
	rows, err := s.pool.Query(ctx,
		`SELECT seat_no FROM inventory.seat_hold_items WHERE hold_id=$1::uuid ORDER BY seat_no`, req.HoldID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not read your seat hold.")
		return
	}
	for rows.Next() {
		var sn string
		if rows.Scan(&sn) == nil {
			seats = append(seats, sn)
		}
	}
	rows.Close()

	// Recover the segment range from the stored mask so pricing matches the hold.
	var mask int64
	if err := s.pool.QueryRow(ctx,
		`SELECT segment_mask FROM inventory.seat_hold_items WHERE hold_id=$1::uuid LIMIT 1`, req.HoldID).
		Scan(&mask); err != nil {
		fail(w, 500, "query_failed", "Could not read your seat hold.")
		return
	}
	boardSeq, dropSeq = maskToRange(mask)

	fare, err := s.fareFor(r, tripID, boardSeq, dropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	pb := priceBreakdown{
		FarePoisha: fare, SeatCount: len(seats),
		BasePoisha: fare * int64(len(seats)), ServiceFeePoisha: serviceFeePoisha,
	}
	subtotal := pb.BasePoisha + pb.ServiceFeePoisha

	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, tripID).Scan(&operatorID); err != nil {
		fail(w, 500, "query_failed", "Could not load the trip.")
		return
	}

	// The promo code is only PRICED here. It is claimed below, after the booking
	// exists, because a claim without a booking to attach it to is a coupon
	// silently burned by somebody who abandoned checkout.
	pctx := promoContext(identity.NormalisePhone(req.Phone), subtotal, operatorID, "", "WEB", "")
	if req.CouponCode != "" {
		q, err := s.promo.Preview(ctx, req.CouponCode, pctx)
		if err != nil {
			fail(w, 400, "coupon_invalid", err.Error())
			return
		}
		pb.DiscountPoisha = q.DiscountPoisha
		pb.CouponCode = q.Code
	}
	pb.TotalPoisha = subtotal - pb.DiscountPoisha

	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: req.HoldID, TripID: tripID, OperatorID: operatorID,
		Seats: seats, BoardSeq: boardSeq, DropSeq: dropSeq,
		Channel: "WEB", TotalPoisha: pb.TotalPoisha,
	})
	if err != nil {
		if errors.Is(err, commerce.ErrOperatorInactive) {
			fail(w, 409, "operator_inactive", "This service is not available for booking right now.")
			return
		}
		s.log.Error("create booking", "err", err)
		fail(w, 500, "booking_failed", "We could not create your booking. Please try again.")
		return
	}

	// Claim for real. If the cap was reached between pricing and here, the
	// passenger keeps the quoted price and the campaign counter stays honest —
	// the alternative is either an over-redeemed coupon or a price that changes
	// under somebody mid-checkout, and of the three this is the cheapest.
	if req.CouponCode != "" {
		if _, err := s.promo.Claim(ctx, req.CouponCode, bookingID, pctx); err != nil {
			s.log.Warn("coupon claim refused after pricing", "err", err, "code", req.CouponCode)
		}
	}

	// Attach the booking to whoever is buying: a signed-in passenger, or the
	// guest account their phone number owns.
	if pid := s.passenger(r); pid != nil {
		if _, err := s.pool.Exec(ctx,
			`UPDATE commerce.bookings SET user_id = $2::uuid WHERE booking_id = $1::uuid`,
			bookingID, pid.UserID); err != nil {
			s.log.Warn("attach booking to passenger", "err", err)
		}
	} else if guestID, err := s.ident.Guest(ctx, req.Phone, req.Email, firstName(req.Passengers)); err == nil {
		if _, err := s.pool.Exec(ctx,
			`UPDATE commerce.bookings SET user_id = $2::uuid WHERE booking_id = $1::uuid`,
			bookingID, guestID); err != nil {
			s.log.Warn("attach booking to guest", "err", err)
		}
	}

	for _, p := range req.Passengers {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO commerce.booking_passengers
				(booking_id, seat_no, full_name, gender, age, id_type, id_number)
			VALUES ($1::uuid,$2,$3,NULLIF($4,''),NULLIF($5,0),NULLIF($6,''),NULLIF($7,''))
			ON CONFLICT (booking_id, seat_no) DO UPDATE SET full_name = EXCLUDED.full_name`,
			bookingID, p.SeatNo, p.FullName, p.Gender, p.Age, p.IDType, p.IDNumber); err != nil {
			s.log.Error("passenger insert", "err", err)
		}
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO commerce.booking_contacts (booking_id, phone, email)
		VALUES ($1::uuid, $2, NULLIF($3,''))
		ON CONFLICT (booking_id) DO UPDATE SET phone = EXCLUDED.phone`,
		bookingID, req.Phone, req.Email); err != nil {
		s.log.Error("contact insert", "err", err)
	}

	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "price": pb,
		"seats": seats, "trip_id": tripID,
	})
}

// maskToRange recovers (board, drop) from a contiguous segment mask.
func maskToRange(mask int64) (int, int) {
	board, drop := -1, -1
	for i := 0; i < 62; i++ {
		if mask&(1<<uint(i)) != 0 {
			if board == -1 {
				board = i
			}
			drop = i + 1
		}
	}
	if board == -1 {
		return 0, 1
	}
	return board, drop
}

func firstName(ps []passengerIn) string {
	if len(ps) == 0 {
		return ""
	}
	return ps[0].FullName
}

// bookFromHold is the channel-neutral path from a live hold to a booking. The
// partner API uses it, and it deliberately shares every step with the website:
// the same hold, the same published fare, the same commerce.CreateBooking.
func (s *Server) bookFromHold(r *http.Request, holdID, channel string) (bookingID, pnr string, total int64, err error) {
	ctx := r.Context()

	var tripID, status string
	var expires time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT trip_id::text, status, expires_at FROM inventory.seat_holds WHERE hold_id = $1::uuid`,
		holdID).Scan(&tripID, &status, &expires); err != nil {
		return "", "", 0, errors.New("that hold does not exist")
	}
	if status != "HELD" || time.Now().After(expires) {
		return "", "", 0, errors.New("that hold has expired")
	}

	rows, err := s.pool.Query(ctx,
		`SELECT seat_no, segment_mask FROM inventory.seat_hold_items WHERE hold_id=$1::uuid ORDER BY seat_no`, holdID)
	if err != nil {
		return "", "", 0, err
	}
	var seats []string
	var mask int64
	for rows.Next() {
		var sn string
		var m int64
		if rows.Scan(&sn, &m) == nil {
			seats = append(seats, sn)
			mask = m
		}
	}
	rows.Close()
	if len(seats) == 0 {
		return "", "", 0, errors.New("that hold owns no seats")
	}
	boardSeq, dropSeq := maskToRange(mask)

	fare, err := s.fareFor(r, tripID, boardSeq, dropSeq)
	if err != nil {
		return "", "", 0, errors.New("no fare is published for that journey")
	}
	total = fare*int64(len(seats)) + serviceFeePoisha

	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, tripID).Scan(&operatorID); err != nil {
		return "", "", 0, err
	}
	bookingID, pnr, err = s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: holdID, TripID: tripID, OperatorID: operatorID,
		Seats: seats, BoardSeq: boardSeq, DropSeq: dropSeq,
		Channel: channel, TotalPoisha: total,
	})
	return bookingID, pnr, total, err
}

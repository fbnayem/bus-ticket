package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/staff/staff"
)

// The on-board channel.
//
// A conductor selling a seat on a moving bus. It is the counter channel with
// three differences and no others: the cash is in a pocket rather than a
// drawer, the fare may be less than the one published, and the person selling
// earns a share of it.
//
// It holds no seat logic. Seats come from the same inventory service the
// website uses, through the same AcquireHold, and are confirmed by the same
// ConfirmHold. That is the platform's rule and this file gets no exception.

func (s *Server) crewRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/crew/duties", s.guard("crew.duty", s.handleOpenDuty))
	m.HandleFunc("POST /api/v1/crew/duties/close", s.guard("crew.duty", s.handleCloseDuty))
	m.HandleFunc("GET /api/v1/crew/duties", s.guard("crew.duty", s.handleDuties))
	m.HandleFunc("POST /api/v1/crew/duties/trips/close", s.guard("crew.duty", s.handleCloseDutyTrip))

	m.HandleFunc("GET /api/v1/crew/sell/context", s.guard("crew.sell", s.handleSellContext))
	m.HandleFunc("POST /api/v1/crew/sales", s.guard("crew.sell", s.handleCrewSale))
	m.HandleFunc("GET /api/v1/crew/sales", s.guard("crew.report", s.handleCrewSales))
	m.HandleFunc("GET /api/v1/crew/report", s.guard("crew.report", s.handleCrewReport))
	m.HandleFunc("GET /api/v1/crew/commissions", s.guard("crew.report", s.handleCrewCommissions))
}

// crewRoleOf is the role this person is rostered in, which decides both their
// discount ceiling and their commission rule.
//
// Somebody with no roster entry is treated as a HELPER: the least authority of
// the three. An unrostered person selling tickets is exactly the case where
// guessing generously is worst.
func (s *Server) crewRoleOf(r *http.Request, staffID string) string {
	var role string
	_ = s.pool.QueryRow(r.Context(), `
		SELECT tc.crew_role
		  FROM ops.trip_crew tc
		  JOIN catalog.trips t ON t.trip_id = tc.trip_id
		 WHERE tc.staff_id = $1::uuid
		   AND t.service_date BETWEEN catalog.bd_today() - 1 AND catalog.bd_today() + 1
		 ORDER BY t.depart_at DESC LIMIT 1`, staffID).Scan(&role)
	if role == "" {
		return "HELPER"
	}
	return role
}

// openDutyOf finds the cash bag this person currently holds, if any.
func (s *Server) openDutyOf(r *http.Request, staffID string) string {
	var id string
	_ = s.pool.QueryRow(r.Context(),
		`SELECT duty_id::text FROM crew.duties WHERE staff_id = $1::uuid AND status = 'OPEN'`,
		staffID).Scan(&id)
	return id
}

// ------------------------------------------------------------------ duty --

type openDutyRequest struct {
	OpeningFloatPoisha int64 `json:"opening_float_poisha"`
}

func (s *Server) handleOpenDuty(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	if id.OperatorID == "" {
		fail(w, 403, "no_operator", "This account is not attached to an operator.")
		return
	}
	var req openDutyRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.OpeningFloatPoisha < 0 {
		fail(w, 400, "bad_float", "An opening float cannot be negative.")
		return
	}
	dutyID, err := s.com.OpenDuty(r.Context(), id.StaffID, id.OperatorID, req.OpeningFloatPoisha)
	if errors.Is(err, commerce.ErrDutyOpen) {
		// Not worth blocking on: they meant to be selling, and they already
		// can. Hand back the bag they have rather than an error.
		writeJSON(w, 200, map[string]any{"duty_id": dutyID, "already_open": true})
		return
	}
	if err != nil {
		s.log.Error("open duty", "err", err)
		fail(w, 500, "duty_failed", "The duty could not be opened.")
		return
	}
	s.stf.Audit(r.Context(), id, "crew.duty.open", "duty:"+dutyID, nil)
	writeJSON(w, 201, map[string]any{"duty_id": dutyID, "already_open": false})
}

type closeDutyRequest struct {
	DutyID            string `json:"duty_id"`
	CountedCashPoisha int64  `json:"counted_cash_poisha"`
	Note              string `json:"note"`
}

func (s *Server) handleCloseDuty(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req closeDutyRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.DutyID == "" {
		req.DutyID = s.openDutyOf(r, id.StaffID)
	}
	if req.DutyID == "" {
		fail(w, 409, "no_duty", "There is no open duty to close.")
		return
	}
	// Taken BEFORE the close, because closing writes a variance movement and
	// the commission a crew member is owed must not move because their bag was
	// short. Those are two different conversations.
	summary, _ := s.com.DutySummary(r.Context(), req.DutyID)

	expected, variance, status, err := s.com.CloseDuty(
		r.Context(), req.DutyID, id.StaffID, req.CountedCashPoisha, req.Note)
	if errors.Is(err, commerce.ErrDutyNotOpen) {
		fail(w, 409, "no_duty", "That duty is not open.")
		return
	}
	if errors.Is(err, commerce.ErrDutyNotYours) {
		// Same answer a missing duty gets. Somebody else's duty id must not be
		// distinguishable from one that does not exist.
		fail(w, 404, "no_duty", "That duty was not found.")
		return
	}
	if err != nil {
		s.log.Error("close duty", "err", err)
		fail(w, 500, "close_failed", "The duty could not be closed.")
		return
	}
	s.stf.Audit(r.Context(), id, "crew.duty.close", "duty:"+req.DutyID, nil)
	writeJSON(w, 200, map[string]any{
		"duty_id": req.DutyID, "status": status,
		"expected_cash_poisha": expected, "counted_cash_poisha": req.CountedCashPoisha,
		"variance_poisha":   variance,
		"commission_poisha": summary.CommissionPoisha,
		"remit_poisha":      summary.RemitPoisha,
	})
}

func (s *Server) handleDuties(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT d.duty_id::text, d.status, d.opening_float_poisha,
		       COALESCE(d.counted_cash_poisha,0), COALESCE(d.expected_cash_poisha,0),
		       COALESCE(d.variance_poisha,0), d.opened_at, d.closed_at,
		       COALESCE((SELECT count(*) FROM commerce.bookings b WHERE b.duty_id = d.duty_id),0),
		       COALESCE((SELECT sum(c.amount_poisha) FROM crew.commissions c WHERE c.duty_id = d.duty_id),0)
		  FROM crew.duties d
		 WHERE d.staff_id = $1::uuid
		 ORDER BY d.opened_at DESC LIMIT 30`, id.StaffID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your duties.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var did, status string
		var float, counted, expected, variance, commission int64
		var sales int
		var opened time.Time
		var closed *time.Time
		if rows.Scan(&did, &status, &float, &counted, &expected, &variance,
			&opened, &closed, &sales, &commission) != nil {
			continue
		}
		out = append(out, map[string]any{
			"duty_id": did, "status": status, "opening_float_poisha": float,
			"counted_cash_poisha": counted, "expected_cash_poisha": expected,
			"variance_poisha": variance, "opened_at": opened, "closed_at": closed,
			"sales_count": sales, "commission_poisha": commission,
		})
	}

	var open any
	if dutyID := s.openDutyOf(r, id.StaffID); dutyID != "" {
		if t, err := s.com.DutySummary(r.Context(), dutyID); err == nil {
			open = t
		}
	}
	writeJSON(w, 200, map[string]any{"duties": out, "open": open})
}

type closeTripRequest struct {
	DutyID string `json:"duty_id"`
	TripID string `json:"trip_id"`
}

func (s *Server) handleCloseDutyTrip(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req closeTripRequest
	if err := decode(r, &req); err != nil || req.TripID == "" {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.DutyID == "" {
		req.DutyID = s.openDutyOf(r, id.StaffID)
	}
	// Ownership in the WHERE clause rather than a guard above it. A duty that
	// is not yours simply is not found.
	var ok bool
	_ = s.pool.QueryRow(r.Context(),
		`SELECT true FROM crew.duties WHERE duty_id = NULLIF($1,'')::uuid AND staff_id = $2::uuid`,
		req.DutyID, id.StaffID).Scan(&ok)
	if !ok {
		fail(w, 404, "no_duty", "That duty was not found.")
		return
	}
	if err := s.com.CloseDutyTrip(r.Context(), req.DutyID, req.TripID); err != nil {
		s.log.Error("close duty trip", "err", err)
		fail(w, 500, "close_failed", "That trip could not be closed off.")
		return
	}
	writeJSON(w, 200, map[string]any{"duty_id": req.DutyID, "trip_id": req.TripID})
}

// -------------------------------------------------------------- discount --

// discountCap is the most this person may take off this fare.
//
// Three limits bind and the smallest wins:
//
//	the operator's policy for their role  — a percentage and a taka ceiling
//	the reason's own ceiling              — a child fare is not a blank cheque
//	the structural maximum                — see commerce.MaxCrewDiscount
//
// An operator with no policy row gets zero. The absence of a policy is not
// permission: a lookup that finds nothing must refuse rather than wave through.
func (s *Server) discountCap(r *http.Request, id *staff.Identity, role, reason string, full int64) int64 {
	if !id.Can("crew.discount") {
		return 0
	}
	var pctBP int
	var maxAmount int64
	if s.pool.QueryRow(r.Context(), `
		SELECT max_pct_bp, max_amount_poisha FROM crew.discount_policies
		 WHERE operator_id = $1::uuid AND crew_role = $2 AND active`,
		id.OperatorID, role).Scan(&pctBP, &maxAmount) != nil {
		return 0
	}
	limit := full * int64(pctBP) / 10000
	if maxAmount > 0 && maxAmount < limit {
		limit = maxAmount
	}
	if reason != "" {
		var reasonBP int
		var active bool
		if s.pool.QueryRow(r.Context(),
			`SELECT max_pct_bp, active FROM crew.discount_reasons WHERE code = $1`,
			reason).Scan(&reasonBP, &active) != nil || !active {
			return 0 // an unknown reason is not a free hand
		}
		if reasonBP > 0 {
			if rc := full * int64(reasonBP) / 10000; rc < limit {
				limit = rc
			}
		}
	}
	if structural := commerce.MaxCrewDiscount(full); structural < limit {
		limit = structural
	}
	if limit < 0 {
		return 0
	}
	return limit
}

func (s *Server) handleSellContext(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	role := s.crewRoleOf(r, id.StaffID)

	var pctBP int
	var maxAmount int64
	_ = s.pool.QueryRow(ctx, `
		SELECT max_pct_bp, max_amount_poisha FROM crew.discount_policies
		 WHERE operator_id = $1::uuid AND crew_role = $2 AND active`,
		id.OperatorID, role).Scan(&pctBP, &maxAmount)

	reasons := []map[string]any{}
	rows, err := s.pool.Query(ctx, `
		SELECT code, label, label_bn, max_pct_bp FROM crew.discount_reasons
		 WHERE active ORDER BY sort_order`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var code, label, labelBn string
			var bp int
			if rows.Scan(&code, &label, &labelBn, &bp) != nil {
				continue
			}
			reasons = append(reasons, map[string]any{
				"code": code, "label": label, "label_bn": labelBn, "max_pct_bp": bp,
			})
		}
	}

	var summary any
	dutyID := s.openDutyOf(r, id.StaffID)
	if dutyID != "" {
		if t, e := s.com.DutySummary(ctx, dutyID); e == nil {
			summary = t
		}
	}

	// The commission rule this person's sales will actually be settled under.
	// The app previews what a discount will cost them before they grant it, and
	// a preview computed from a hardcoded rate would quietly disagree with the
	// receipt the moment an operator configured anything but the default.
	commissionBP, commissionFlat := 0, int64(0)
	if rule, e := s.com.ResolveCrewCommission(ctx, id.OperatorID, "", role); e == nil && rule != nil {
		if rule.Kind == "FLAT" {
			commissionFlat = rule.Amount
		} else {
			commissionBP = rule.ValueBP
		}
	}

	var brand string
	_ = s.pool.QueryRow(ctx, `SELECT brand FROM catalog.operators WHERE operator_id=$1::uuid`,
		id.OperatorID).Scan(&brand)

	writeJSON(w, 200, map[string]any{
		"crew_role":              role,
		"operator_brand":         brand,
		"commission_bp":          commissionBP,
		"commission_flat_poisha": commissionFlat,
		"may_sell":               id.Can("crew.sell"),
		"may_discount":       id.Can("crew.discount") && pctBP > 0,
		"max_pct_bp":         pctBP,
		"max_amount_poisha":  maxAmount,
		"reasons":            reasons,
		"duty_id":            dutyID,
		"duty":               summary,
		"service_fee_poisha": serviceFeePoisha,
	})
}

// ------------------------------------------------------------------ sale --

type crewSaleRequest struct {
	DutyID         string        `json:"duty_id"`
	TripID         string        `json:"trip_id"`
	Seats          []string      `json:"seats"`
	BoardSeq       int           `json:"board_seq"`
	DropSeq        int           `json:"drop_seq"`
	Passengers     []passengerIn `json:"passengers"`
	Phone          string        `json:"phone"`
	DiscountPoisha int64         `json:"discount_poisha"`
	DiscountReason string        `json:"discount_reason"`
}

// handleCrewSale follows handleCounterSale step for step. Where it differs, it
// is because of the three things that make this channel different and nowhere
// else.
func (s *Server) handleCrewSale(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	if id.OperatorID == "" {
		fail(w, 403, "no_operator", "This account is not attached to an operator.")
		return
	}
	var req crewSaleRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if len(req.Seats) == 0 {
		fail(w, 400, "no_seats", "Choose at least one seat.")
		return
	}
	if req.Phone == "" {
		fail(w, 400, "phone_required", "Take a mobile number so the passenger gets their ticket.")
		return
	}

	// A cash bag is optional. The sale is attributed to the person signed in
	// either way — that is the fact that is always true, and it is why the
	// report, the commission and the cash leg are all keyed by staff_id.
	//
	// A bag, when one is open, is picked up automatically and the sale drops
	// into it so the end-of-duty count has something to compare against. What
	// is still refused is a bag id belonging to somebody else: sales are
	// optional to group, never optional to attribute.
	if req.DutyID == "" {
		req.DutyID = s.openDutyOf(r, id.StaffID)
	} else {
		var owns bool
		_ = s.pool.QueryRow(ctx, `
			SELECT true FROM crew.duties
			 WHERE duty_id = $1::uuid AND staff_id = $2::uuid AND status = 'OPEN'`,
			req.DutyID, id.StaffID).Scan(&owns)
		if !owns {
			fail(w, 403, "duty_not_yours", "That cash bag is not yours, or is already closed.")
			return
		}
	}

	// A conductor sells on their own company buses and no others.
	//
	// Checked here, before a seat is held, because the alternative is worse
	// than it looks: the discount ceiling and the commission rule are both
	// looked up per operator, and a sale on somebody else bus resolves the
	// ceiling from the crew member employer while the settlement resolves the
	// commission from the trip owner. The two quietly disagree, and the
	// conductor is shown a commission they will never be paid. Found by selling
	// a Hanif seat with a Green Line account.
	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`,
		req.TripID).Scan(&operatorID); err != nil {
		fail(w, 400, "no_trip", "That trip could not be found.")
		return
	}
	if operatorID != id.OperatorID {
		fail(w, 403, "not_your_bus", "You can only sell on your own company buses.")
		return
	}

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	full := fare*int64(len(req.Seats)) + serviceFeePoisha

	// The discount is refused, never clamped. A conductor who believes they
	// gave 100 taka off and actually gave 50 will be short at handover and will
	// have no way to find out why.
	discount := req.DiscountPoisha
	if discount < 0 {
		fail(w, 400, "bad_discount", "A discount cannot be negative.")
		return
	}
	if discount > 0 {
		if !id.Can("crew.discount") {
			fail(w, 403, "discount_not_permitted", "Your role cannot change the fare.")
			return
		}
		if req.DiscountReason == "" {
			fail(w, 400, "discount_reason_required", "Say why the fare is lower.")
			return
		}
		limit := s.discountCap(r, id, s.crewRoleOf(r, id.StaffID), req.DiscountReason, full)
		if discount > limit {
			failRef(w, 400, "discount_too_large",
				"The most you can take off this fare is "+taka(limit)+".",
				fmt.Sprintf("%d", limit))
			return
		}
	}
	total := full - discount

	// A hold is traceable to the bag when there is one and to the person when
	// there is not; it is never traceable to nothing.
	sessionRef := req.DutyID
	if sessionRef == "" {
		sessionRef = id.StaffID
	}

	// The one and only seat acquisition path.
	hold, err := s.inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "ONBOARD", SessionRef: sessionRef, TTL: 5 * time.Minute,
		PriceSnapshot: []byte(fmt.Sprintf(
			`{"fare_poisha":%d,"seats":%d,"discount_poisha":%d,"total_poisha":%d}`,
			fare, len(req.Seats), discount, total)),
	})
	if errors.Is(err, inventory.ErrSeatUnavailable) {
		fail(w, 409, "seat_taken", "One of those seats has just gone. Refresh the map and try again.")
		return
	}
	if err != nil {
		s.log.Error("crew hold", "err", err)
		fail(w, 500, "hold_failed", "Those seats could not be held.")
		return
	}

	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: hold.HoldID, TripID: req.TripID, OperatorID: operatorID,
		Seats: hold.Seats, BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "ONBOARD", TotalPoisha: total,
	})
	if err != nil {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "BOOKING_FAILED")
		s.log.Error("crew booking", "err", err)
		fail(w, 500, "booking_failed", "The booking could not be created.")
		return
	}
	s.attributeSale(ctx, bookingID, "", "", id.StaffID)
	s.savePassengers(ctx, bookingID, req.Passengers, req.Phone, "")

	// The discount travels on the booking, not only inside the price snapshot,
	// because the crew report and any settlement dispute need to sum it.
	if _, err := s.pool.Exec(ctx, `
		UPDATE commerce.bookings
		   SET discount_poisha = $2, discount_reason = NULLIF($3,''), duty_id = NULLIF($4,'')::uuid
		 WHERE booking_id = $1::uuid`,
		bookingID, discount, req.DiscountReason, req.DutyID); err != nil {
		s.log.Error("crew discount write", "err", err)
	}

	sale, err := s.com.SettleCrewSale(ctx, bookingID, req.DutyID, id.StaffID,
		s.crewRoleOf(r, id.StaffID))
	if err != nil {
		s.log.Error("crew settle", "err", err)
		failRef(w, 500, "payment_failed",
			"Payment could not be recorded. Contact the office with this PNR: "+pnr, pnr)
		return
	}
	s.stf.Audit(ctx, id, "crew.sale", "booking:"+pnr, map[string]any{
		"discount_poisha": discount, "discount_reason": req.DiscountReason,
	})

	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "seats": hold.Seats,
		"full_poisha": full, "discount_poisha": discount, "total_poisha": total,
		"commission_poisha": sale.CommissionPoisha, "forfeit_poisha": sale.ForfeitPoisha,
		"tickets": s.ticketsFor(ctx, bookingID),
	})
}

// taka renders poisha the way the apps do, for an error a conductor reads at a
// roadside stop. 105 taka, not 10500.
func taka(poisha int64) string {
	return fmt.Sprintf("%d Tk", poisha/100)
}

// ---------------------------------------------------------------- report --

func (s *Server) handleCrewSales(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")

	// Ownership is in the WHERE clause. This list can only ever contain their
	// own sales, whatever else arrives in the query string.
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.total_poisha, b.discount_poisha,
		       COALESCE(b.discount_reason,''), b.created_at, t.depart_at, r.name,
		       (SELECT string_agg(seat_no, ',' ORDER BY seat_no)
		          FROM commerce.booking_seats bs WHERE bs.booking_id = b.booking_id),
		       COALESCE((SELECT phone FROM commerce.booking_contacts bc
		                  WHERE bc.booking_id = b.booking_id), ''),
		       COALESCE((SELECT c.amount_poisha FROM crew.commissions c
		                  WHERE c.booking_id = b.booking_id), 0)
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		  JOIN catalog.routes r ON r.route_id = t.route_id
		 WHERE b.sold_by = $1::uuid AND b.channel = 'ONBOARD'
		   AND ($2 = '' OR (b.created_at AT TIME ZONE 'Asia/Dhaka')::date >= $2::date)
		   AND ($3 = '' OR (b.created_at AT TIME ZONE 'Asia/Dhaka')::date <= $3::date)
		   AND ($4 = '' OR b.pnr ILIKE '%' || $4 || '%'
		        OR EXISTS (SELECT 1 FROM commerce.booking_contacts bc
		                    WHERE bc.booking_id = b.booking_id AND bc.phone ILIKE '%' || $4 || '%')
		        OR EXISTS (SELECT 1 FROM commerce.booking_passengers bp
		                    WHERE bp.booking_id = b.booking_id AND bp.full_name ILIKE '%' || $4 || '%'))
		 ORDER BY b.created_at DESC LIMIT 100`, id.StaffID, from, to, q)
	if err != nil {
		s.log.Error("crew sales", "err", err)
		fail(w, 500, "query_failed", "Could not load your sales.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, reason, route, phone string
		var seatsStr *string
		var total, discount, commission int64
		var created, depart time.Time
		if rows.Scan(&pnr, &status, &total, &discount, &reason, &created, &depart,
			&route, &seatsStr, &phone, &commission) != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "total_poisha": total,
			"discount_poisha": discount, "discount_reason": reason,
			"created_at": created, "depart_at": depart, "route": route,
			"seats": deref(seatsStr), "phone": phone, "commission_poisha": commission,
		})
	}
	writeJSON(w, 200, map[string]any{"sales": out})
}

// handleCrewReport answers the three questions a conductor actually has: what
// did I sell today, what did I sell this week, and what do I owe right now.
func (s *Server) handleCrewReport(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()

	// since is a SQL fragment chosen from two literals below, never anything
	// that came in over the wire.
	period := func(since string) map[string]any {
		var sales int
		var gross, discount, commission int64
		_ = s.pool.QueryRow(ctx, `
			SELECT COALESCE(count(*),0), COALESCE(sum(b.total_poisha),0),
			       COALESCE(sum(b.discount_poisha),0),
			       COALESCE((SELECT sum(c.amount_poisha) FROM crew.commissions c
			                   JOIN commerce.bookings cb ON cb.booking_id = c.booking_id
			                  WHERE c.staff_id = $1::uuid
			                    AND (cb.created_at AT TIME ZONE 'Asia/Dhaka')::date >= `+since+`), 0)
			  FROM commerce.bookings b
			 WHERE b.sold_by = $1::uuid AND b.channel = 'ONBOARD'
			   AND (b.created_at AT TIME ZONE 'Asia/Dhaka')::date >= `+since, id.StaffID).
			Scan(&sales, &gross, &discount, &commission)
		return map[string]any{
			"sales_count": sales, "gross_poisha": gross,
			"discount_poisha": discount, "commission_poisha": commission,
			// What is owed for this period if no bag is being counted: the cash
			// taken, less the share that is theirs. With a bag open the duty
			// summary below is the better answer because it also knows about
			// the opening float and any pay-ins; without one, this is the
			// honest figure and it is bounded by the period rather than
			// accumulating since the beginning of time.
			"handover_poisha": gross - commission,
		}
	}

	out := map[string]any{
		"today": period("catalog.bd_today()"),
		"week":  period("catalog.bd_today() - 6"),
	}
	if dutyID := s.openDutyOf(r, id.StaffID); dutyID != "" {
		if t, err := s.com.DutySummary(ctx, dutyID); err == nil {
			out["duty"] = t
		}
	}

	// Per trip: the other half of the answer, so a dispute about the 22:00 run
	// is answered with that run's numbers rather than the day's.
	//
	// Derived from the sales themselves rather than read out of duty_trips.
	// The sealed snapshot is the same arithmetic over the same rows — see
	// CloseDutyTrip — but it only exists for runs that happened inside a cash
	// bag, and a bag is optional now. Deriving is strictly more available and
	// cannot disagree with the sales list next to it. closed_at is still read
	// from the snapshot, because "sealed" is the one fact the sales do not
	// carry themselves.
	trips := []map[string]any{}
	rows, err := s.pool.Query(ctx, `
		SELECT b.trip_id::text, r.name, t.depart_at, count(*),
		       COALESCE(sum(b.total_poisha),0), COALESCE(sum(b.discount_poisha),0),
		       COALESCE(sum((SELECT c.amount_poisha FROM crew.commissions c
		                      WHERE c.booking_id = b.booking_id)), 0),
		       max(dt.closed_at)
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		  JOIN catalog.routes r ON r.route_id = t.route_id
		  LEFT JOIN crew.duty_trips dt
		         ON dt.trip_id = b.trip_id AND dt.duty_id = b.duty_id
		 WHERE b.sold_by = $1::uuid AND b.channel = 'ONBOARD'
		 GROUP BY b.trip_id, r.name, t.depart_at
		 ORDER BY t.depart_at DESC LIMIT 20`, id.StaffID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var tid, route string
			var n int
			var gross, discount, commission int64
			var depart time.Time
			var closed *time.Time
			if rows.Scan(&tid, &route, &depart, &n, &gross, &discount, &commission, &closed) != nil {
				continue
			}
			trips = append(trips, map[string]any{
				"trip_id": tid, "route": route, "depart_at": depart,
				"sales_count": n, "gross_poisha": gross, "discount_poisha": discount,
				"commission_poisha": commission, "closed_at": closed,
			})
		}
	}
	out["trips"] = trips
	writeJSON(w, 200, out)
}

func (s *Server) handleCrewCommissions(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, c.gross_amount_poisha, c.forfeit_poisha, c.amount_poisha,
		       c.created_at, COALESCE(b.discount_reason,'')
		  FROM crew.commissions c
		  JOIN commerce.bookings b ON b.booking_id = c.booking_id
		 WHERE c.staff_id = $1::uuid
		 ORDER BY c.created_at DESC LIMIT 100`, id.StaffID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your commissions.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var earned, forfeited int64
	for rows.Next() {
		var pnr, reason string
		var gross, forfeit, net int64
		var created time.Time
		if rows.Scan(&pnr, &gross, &forfeit, &net, &created, &reason) != nil {
			continue
		}
		earned += net
		forfeited += forfeit
		// All three numbers, never just the net. "15 taka" explains nothing;
		// "40 earned, 25 given away" explains itself.
		out = append(out, map[string]any{
			"pnr": pnr, "gross_poisha": gross, "forfeit_poisha": forfeit,
			"amount_poisha": net, "created_at": created, "discount_reason": reason,
		})
	}
	writeJSON(w, 200, map[string]any{
		"commissions": out, "earned_poisha": earned, "forfeited_poisha": forfeited,
	})
}

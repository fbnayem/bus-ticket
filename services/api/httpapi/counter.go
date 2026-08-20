package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/staff/staff"
)

// errOfflineAmount rejects an offline sale whose quoted total does not match the
// published fare within the operator's absorbable discount range.
var errOfflineAmount = errors.New("the sale total does not match the published fare")

// The counter POS API.
//
// Note what is absent: there is no counter seat map, no counter availability
// query and no counter hold table. The POS calls GET /trips/{id}/seatmap and
// this file calls inventory.AcquireHold — the same code the website uses. A
// counter sale and a web sale contend for the same seat through the same
// conditional UPDATE, which is why the multi-channel contention proof passes.

func (s *Server) counterRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/counter/context", s.guard("counter.sell", s.handleCounterContext))
	m.HandleFunc("POST /api/v1/counter/shifts", s.guard("counter.shift", s.handleOpenShift))
	m.HandleFunc("POST /api/v1/counter/shifts/close", s.guard("counter.shift", s.handleCloseShift))
	m.HandleFunc("GET /api/v1/counter/shifts", s.guard("counter.report", s.handleShiftHistory))
	m.HandleFunc("POST /api/v1/counter/sales", s.guard("counter.sell", s.handleCounterSale))
	m.HandleFunc("GET /api/v1/counter/sales", s.guard("counter.sell", s.handleCounterSales))
	m.HandleFunc("POST /api/v1/counter/refunds", s.guard("counter.refund", s.handleCounterRefund))
	m.HandleFunc("POST /api/v1/counter/reprint", s.guard("counter.sell", s.handleCounterReprint))
	s.concessionRoutes(m)
	m.HandleFunc("GET /api/v1/counter/quota", s.guard("counter.quota", s.handleListQuota))
	m.HandleFunc("POST /api/v1/counter/quota", s.guard("counter.quota", s.handleAllocateQuota))
	m.HandleFunc("POST /api/v1/counter/quota/release", s.guard("counter.quota", s.handleReleaseQuota))
	m.HandleFunc("POST /api/v1/counter/offline-sales", s.guard("counter.sell", s.handleReplayOffline))
}

func (s *Server) counterOf(id *staff.Identity) (string, error) {
	if id.CounterID == "" {
		return "", errors.New("this account is not attached to a counter")
	}
	return id.CounterID, nil
}

// ------------------------------------------------------------------ context --

func (s *Server) handleCounterContext(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	ctx := r.Context()

	out := map[string]any{"counter_id": counterID}
	var name, address, operator, operatorID string
	if err := s.pool.QueryRow(ctx, `
		SELECT c.name, COALESCE(c.address,''), o.brand, o.operator_id::text
		  FROM counter.counters c JOIN catalog.operators o ON o.operator_id = c.operator_id
		 WHERE c.counter_id = $1::uuid`, counterID).Scan(&name, &address, &operator, &operatorID); err != nil {
		fail(w, 500, "query_failed", "Could not load this counter.")
		return
	}
	out["name"], out["address"], out["operator"], out["operator_id"] = name, address, operator, operatorID

	// The open shift, if any. Everything the POS does with money is gated on
	// this being present — you cannot sell out of a drawer that is not open.
	var shiftID string
	var openedAt time.Time
	var float int64
	err = s.pool.QueryRow(ctx, `
		SELECT shift_id::text, opened_at, opening_float_poisha
		  FROM counter.shifts WHERE counter_id = $1::uuid AND status = 'OPEN'`, counterID).
		Scan(&shiftID, &openedAt, &float)
	if err == nil {
		var sales, cashIn, count int64
		_ = s.pool.QueryRow(ctx, `
			SELECT COALESCE(sum(amount_poisha) FILTER (WHERE kind='SALE'),0),
			       COALESCE(sum(amount_poisha) FILTER (WHERE method='CASH'),0),
			       count(*) FILTER (WHERE kind='SALE')
			  FROM counter.cash_transactions WHERE shift_id = $1::uuid`, shiftID).
			Scan(&sales, &cashIn, &count)
		out["shift"] = map[string]any{
			"shift_id": shiftID, "opened_at": openedAt,
			"opening_float_poisha": float,
			"cash_sales_poisha":    sales,
			"expected_cash_poisha": float + cashIn,
			"sale_count":           count,
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		s.log.Error("shift lookup", "err", err)
	}

	var quota int
	_ = s.pool.QueryRow(ctx,
		`SELECT count(*) FROM counter.quota_items WHERE counter_id=$1::uuid AND status='ALLOCATED'`,
		counterID).Scan(&quota)
	out["quota_seats"] = quota

	// The POS used to carry its own `const SERVICE_FEE = 5000` and quote the
	// clerk a total assembled in the browser. The clerk then took that many taka
	// in CASH across the counter. A copied constant is a bad idea anywhere; in
	// the one place where a person physically hands over notes against the
	// figure on screen, and a drawer has to balance to it at close, it is a
	// defect waiting for the day the fee changes on this side only.
	out["service_fee_poisha"] = serviceFeePoisha
	writeJSON(w, 200, out)
}

// -------------------------------------------------------------------- shift --

type openShiftRequest struct {
	OpeningFloatPoisha int64 `json:"opening_float_poisha"`
}

func (s *Server) handleOpenShift(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req openShiftRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.OpeningFloatPoisha < 0 {
		fail(w, 400, "bad_float", "The opening float cannot be negative.")
		return
	}
	var shiftID string
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO counter.shifts (counter_id, staff_id, opening_float_poisha)
		VALUES ($1::uuid, $2::uuid, $3) RETURNING shift_id::text`,
		counterID, id.StaffID, req.OpeningFloatPoisha).Scan(&shiftID)
	if err != nil {
		// The partial unique index is what rejects a second open drawer.
		fail(w, 409, "shift_already_open", "A shift is already open on this counter. Close it first.")
		return
	}
	s.stf.Audit(r.Context(), id, "counter.shift.open", "shift:"+shiftID, nil)
	writeJSON(w, 201, map[string]any{"shift_id": shiftID})
}

type closeShiftRequest struct {
	ShiftID           string `json:"shift_id"`
	CountedCashPoisha int64  `json:"counted_cash_poisha"`
	Note              string `json:"note"`
}

func (s *Server) handleCloseShift(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req closeShiftRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	expected, variance, status, err := s.com.CloseShift(r.Context(), req.ShiftID, req.CountedCashPoisha, req.Note)
	if errors.Is(err, commerce.ErrShiftNotOpen) {
		fail(w, 409, "shift_not_open", "That shift is not open.")
		return
	}
	if err != nil {
		s.log.Error("close shift", "err", err)
		fail(w, 500, "close_failed", "The shift could not be closed.")
		return
	}
	s.stf.Audit(r.Context(), id, "counter.shift.close", "shift:"+req.ShiftID, nil)
	writeJSON(w, 200, map[string]any{
		"shift_id": req.ShiftID, "status": status,
		"expected_cash_poisha": expected,
		"counted_cash_poisha":  req.CountedCashPoisha,
		"variance_poisha":      variance,
	})
}

func (s *Server) handleShiftHistory(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		// An operator manager reading counter reports names the counter instead —
		// but only one of THEIR counters. Without this ownership check the query
		// param is an IDOR: a manager could read a competitor's drawer counts,
		// variances and clerk names by naming their counter id.
		counterID = r.URL.Query().Get("counter_id")
		if counterID == "" {
			fail(w, 400, "counter_required", "Choose a counter.")
			return
		}
		if id.OperatorID != "" {
			var ok bool
			if err := s.pool.QueryRow(r.Context(),
				`SELECT EXISTS (SELECT 1 FROM counter.counters
				                 WHERE counter_id=$1::uuid AND operator_id=$2::uuid)`,
				counterID, id.OperatorID).Scan(&ok); err != nil || !ok {
				fail(w, 404, "not_found", "No counter with that reference.")
				return
			}
		}
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT s.shift_id::text, s.status, s.opened_at, s.closed_at,
		       s.opening_float_poisha, COALESCE(s.counted_cash_poisha,0),
		       COALESCE(s.expected_cash_poisha,0), COALESCE(s.variance_poisha,0),
		       u.full_name,
		       (SELECT count(*) FROM counter.cash_transactions t
		         WHERE t.shift_id = s.shift_id AND t.kind = 'SALE')
		  FROM counter.shifts s JOIN staff.staff_users u ON u.staff_id = s.staff_id
		 WHERE s.counter_id = $1::uuid
		 ORDER BY s.opened_at DESC LIMIT 40`, counterID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load shifts.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, status, clerk string
		var opened time.Time
		var closed *time.Time
		var float, counted, expected, variance int64
		var sales int
		if err := rows.Scan(&sid, &status, &opened, &closed, &float, &counted,
			&expected, &variance, &clerk, &sales); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"shift_id": sid, "status": status, "opened_at": opened, "closed_at": closed,
			"opening_float_poisha": float, "counted_cash_poisha": counted,
			"expected_cash_poisha": expected, "variance_poisha": variance,
			"clerk": clerk, "sale_count": sales,
		})
	}
	writeJSON(w, 200, map[string]any{"shifts": out})
}

// --------------------------------------------------------------------- sale --

type counterSaleRequest struct {
	ShiftID    string        `json:"shift_id"`
	TripID     string        `json:"trip_id"`
	Seats      []string      `json:"seats"`
	BoardSeq   int           `json:"board_seq"`
	DropSeq    int           `json:"drop_seq"`
	Passengers []passengerIn `json:"passengers"`
	Phone      string        `json:"phone"`
	Method     string        `json:"method"` // CASH | BKASH | NAGAD | CARD
	// Concessions is one code per seat (parallel to Seats); "" is a full-fare
	// seat. A child/student/senior concession reduces that seat's fare, which
	// the operator absorbs.
	Concessions []string `json:"concessions"`
}

func (s *Server) handleCounterSale(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req counterSaleRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.Method == "" {
		req.Method = "CASH"
	}
	if len(req.Seats) == 0 {
		fail(w, 400, "no_seats", "Choose at least one seat.")
		return
	}
	if len(req.Seats) > 6 {
		fail(w, 400, "too_many_seats", "Up to 6 seats can be sold in one booking.")
		return
	}
	if req.Phone == "" {
		fail(w, 400, "phone_required", "Take a mobile number so the passenger gets their ticket.")
		return
	}

	// Cash may only be taken into an open drawer. Without this, a cash sale
	// would have nowhere to be counted at close of shift.
	if req.Method == "CASH" {
		var ok bool
		_ = s.pool.QueryRow(ctx,
			`SELECT true FROM counter.shifts WHERE shift_id = NULLIF($1,'')::uuid
			  AND counter_id = $2::uuid AND status = 'OPEN'`, req.ShiftID, counterID).Scan(&ok)
		if !ok {
			fail(w, 409, "shift_required", "Open a shift before taking cash.")
			return
		}
	}

	if len(req.Concessions) != 0 && len(req.Concessions) != len(req.Seats) {
		fail(w, 400, "bad_concessions", "Give a concession for each seat, or none at all.")
		return
	}

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	full := fare*int64(len(req.Seats)) + serviceFeePoisha

	// The one and only seat acquisition path.
	hold, err := s.inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "COUNTER", SessionRef: counterID, TTL: 5 * time.Minute,
		PriceSnapshot: []byte(fmt.Sprintf(
			`{"fare_poisha":%d,"seats":%d,"total_poisha":%d}`, fare, len(req.Seats), full)),
	})
	if errors.Is(err, inventory.ErrSeatUnavailable) {
		fail(w, 409, "seat_taken", "One of those seats has just gone. Refresh the map and try again.")
		return
	}
	if err != nil {
		s.log.Error("counter hold", "err", err)
		fail(w, 500, "hold_failed", "Those seats could not be held.")
		return
	}

	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, req.TripID).Scan(&operatorID); err != nil {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "TRIP_LOOKUP_FAILED")
		fail(w, 500, "query_failed", "Could not load the trip.")
		return
	}

	// Concessions are resolved against this operator's rates and reduce the
	// fare the passenger pays; the operator absorbs the reduction. total is what
	// is charged, full is the published price the ledger's commission sits on.
	discount := concessionDiscount(fare, req.Concessions, s.concessionRates(ctx, operatorID))
	total := full - discount

	// A concession is absorbed by the operator, so it cannot exceed the operator's
	// own margin — beyond that the Operator Payable leg goes negative and the
	// ledger's positive-amount CHECK rejects the whole journal AFTER payment is
	// taken and the seats confirmed, stranding a paid, seat-held, un-ticketed
	// booking. Refuse it cleanly here, before any money moves, as the crew path
	// does with its discount cap. base is the fare net of the service fee; the
	// operator keeps base minus the platform's tenth of it.
	base := full - serviceFeePoisha
	if discount > base-base/10 {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "DISCOUNT_TOO_LARGE")
		fail(w, 400, "discount_too_large", "That concession is larger than the fare can bear.")
		return
	}

	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: hold.HoldID, TripID: req.TripID, OperatorID: operatorID,
		Seats: hold.Seats, BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "COUNTER", TotalPoisha: total,
	})
	if err != nil {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "BOOKING_FAILED")
		if errors.Is(err, commerce.ErrOperatorInactive) {
			fail(w, 409, "operator_inactive", "This operator is not active, so it cannot sell tickets.")
			return
		}
		s.log.Error("counter booking", "err", err)
		fail(w, 500, "booking_failed", "The booking could not be created.")
		return
	}
	s.attributeSale(ctx, bookingID, counterID, "", id.StaffID)
	s.savePassengers(ctx, bookingID, req.Passengers, req.Phone, "")

	// The concession travels on the booking, not only in the price snapshot, so
	// the settlement recomputes the platform's cut on the full fare and the
	// operator's own reports can sum what concessions cost them.
	if discount > 0 {
		if _, err := s.pool.Exec(ctx, `
			UPDATE commerce.bookings SET discount_poisha = $2, discount_reason = 'CONCESSION'
			 WHERE booking_id = $1::uuid`, bookingID, discount); err != nil {
			s.log.Error("counter concession write", "err", err)
		}
	}

	if err := s.com.SettleCounterSale(ctx, bookingID, req.ShiftID, req.Method); err != nil {
		// The seats are already confirmed and the booking exists at this point, so
		// "nothing has been charged" would be a lie that invites the clerk to
		// re-sell and double-book. Surface the PNR and send them to reconciliation,
		// exactly as the crew sale path does.
		s.log.Error("counter settle", "err", err, "pnr", pnr)
		fail(w, 500, "settle_failed",
			"The seats are held under "+pnr+" but payment could not be recorded. Do not re-sell — settle it from the office.")
		return
	}
	s.stf.Audit(ctx, id, "counter.sale", "booking:"+pnr, nil)

	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "seats": hold.Seats,
		"full_poisha": full, "discount_poisha": discount, "total_poisha": total,
		"method":  req.Method,
		"tickets": s.ticketsFor(ctx, bookingID),
	})
}

func (s *Server) handleCounterSales(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.total_poisha, b.created_at,
		       t.depart_at, o.brand,
		       (SELECT string_agg(seat_no, ',' ORDER BY seat_no)
		          FROM commerce.booking_seats bs WHERE bs.booking_id = b.booking_id),
		       COALESCE(p.provider,'')
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		  JOIN catalog.operators o ON o.operator_id = b.operator_id
		  LEFT JOIN commerce.payments p ON p.booking_id = b.booking_id AND p.status='PAID'
		 WHERE b.counter_id = $1::uuid
		 ORDER BY b.created_at DESC LIMIT 50`, counterID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load sales.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, brand, provider string
		var seats *string
		var total int64
		var created, depart time.Time
		if err := rows.Scan(&pnr, &status, &total, &created, &depart, &brand, &seats, &provider); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "total_poisha": total, "created_at": created,
			"depart_at": depart, "operator": brand, "seats": deref(seats), "provider": provider,
		})
	}
	writeJSON(w, 200, map[string]any{"sales": out})
}

// -------------------------------------------------------------------- quota --

type quotaRequest struct {
	TripID   string   `json:"trip_id"`
	Seats    []string `json:"seats"`
	BoardSeq int      `json:"board_seq"`
	DropSeq  int      `json:"drop_seq"`
}

func (s *Server) handleAllocateQuota(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req quotaRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	mask, err := s.inv.AllocateQuota(r.Context(), counterID, req.TripID, req.Seats, req.BoardSeq, req.DropSeq)
	switch {
	case errors.Is(err, inventory.ErrQuotaTooLarge):
		fail(w, 400, "quota_too_large",
			fmt.Sprintf("A counter can reserve at most %d seats per trip.", inventory.MaxQuotaSeats))
		return
	case errors.Is(err, inventory.ErrSeatUnavailable):
		fail(w, 409, "seat_taken", "One of those seats is no longer free. Nothing was reserved.")
		return
	case err != nil:
		s.log.Error("allocate quota", "err", err)
		fail(w, 500, "quota_failed", "Those seats could not be reserved.")
		return
	}
	s.stf.Audit(r.Context(), id, "counter.quota.allocate", "trip:"+req.TripID, nil)
	writeJSON(w, 201, map[string]any{"trip_id": req.TripID, "seats": req.Seats, "segment_mask": mask})
}

func (s *Server) handleReleaseQuota(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req quotaRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	mask, err := inventory.SegmentMask(req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "bad_segments", "That journey is not valid.")
		return
	}
	if err := s.inv.ReleaseQuota(r.Context(), counterID, req.TripID, req.Seats, mask); err != nil {
		fail(w, 500, "release_failed", "Those seats could not be released.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListQuota(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	seats, err := s.inv.ListQuota(r.Context(), counterID, r.URL.Query().Get("trip_id"))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the quota.")
		return
	}
	// Enrich with trip detail so the POS can show the quota without extra calls.
	out := []map[string]any{}
	for _, q := range seats {
		var depart time.Time
		var from, to, brand string
		_ = s.pool.QueryRow(r.Context(), `
			SELECT t.depart_at, o.brand,
			       (SELECT l.name FROM catalog.route_stops rs JOIN catalog.locations l ON l.location_id=rs.location_id
			         WHERE rs.route_id=t.route_id AND rs.stop_seq=$2),
			       (SELECT l.name FROM catalog.route_stops rs JOIN catalog.locations l ON l.location_id=rs.location_id
			         WHERE rs.route_id=t.route_id AND rs.stop_seq=$3)
			  FROM catalog.trips t JOIN catalog.operators o ON o.operator_id=t.operator_id
			 WHERE t.trip_id=$1::uuid`, q.TripID, q.BoardSeq, q.DropSeq).Scan(&depart, &brand, &from, &to)
		out = append(out, map[string]any{
			"trip_id": q.TripID, "seat_no": q.SeatNo, "segment_mask": q.Mask,
			"board_seq": q.BoardSeq, "drop_seq": q.DropSeq,
			"depart_at": depart, "operator": brand, "from": from, "to": to,
		})
	}
	writeJSON(w, 200, map[string]any{"quota": out})
}

// ----------------------------------------------------------- offline replay --

type offlineSale struct {
	ClientRef   string        `json:"client_ref"`
	TerminalSeq int64         `json:"terminal_seq"`
	TripID      string        `json:"trip_id"`
	Seats       []string      `json:"seats"`
	BoardSeq    int           `json:"board_seq"`
	DropSeq     int           `json:"drop_seq"`
	Passengers  []passengerIn `json:"passengers"`
	Phone       string        `json:"phone"`
	TotalPoisha int64         `json:"total_poisha"`
	SoldAt      time.Time     `json:"sold_at"`
	ShiftID     string        `json:"shift_id"`
}

type replayRequest struct {
	Sales []offlineSale `json:"sales"`
}

// handleReplayOffline drains the terminal's queue.
//
// Every sale carries a client_ref minted on the terminal before the sale was
// made, so this endpoint is safe to call with the same queue any number of
// times — the queue is flushed on reconnect, and a flaky connection means it
// will be flushed twice. The claim insert below is what makes that harmless.
func (s *Server) handleReplayOffline(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req replayRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}

	results := []map[string]any{}
	for _, sale := range req.Sales {
		res := map[string]any{"client_ref": sale.ClientRef, "seats": sale.Seats}
		payload, _ := json.Marshal(sale)

		// Claim the client_ref. If somebody (or an earlier flush) already has
		// it, return what happened the first time and do no work.
		var claimed string
		err := s.pool.QueryRow(ctx, `
			INSERT INTO counter.offline_sales
				(client_ref, counter_id, terminal_seq, payload, sold_at)
			VALUES ($1, $2::uuid, $3, $4::jsonb, $5)
			ON CONFLICT (client_ref) DO NOTHING
			RETURNING client_ref`,
			sale.ClientRef, counterID, sale.TerminalSeq, string(payload), sale.SoldAt).Scan(&claimed)
		if errors.Is(err, pgx.ErrNoRows) {
			var pnr *string
			var status, reason string
			_ = s.pool.QueryRow(ctx, `
				SELECT pnr, status, COALESCE(reject_reason,'') FROM counter.offline_sales
				 WHERE client_ref = $1`, sale.ClientRef).Scan(&pnr, &status, &reason)
			// A claim with no PNR and no rejection is a half-finished attempt — the
			// claim committed but a crash or fault stopped the booking before it was
			// recorded. Reporting it as "already_replayed" with an empty PNR would
			// silently drop a cash sale; surface it so the terminal and the office
			// know it still needs reconciliation rather than assuming it is done.
			if deref(pnr) == "" && status != "REJECTED" {
				res["outcome"] = "pending_reconciliation"
				res["status"] = status
				res["reason"] = "the sale was claimed but never completed — reconcile it in the office"
				results = append(results, res)
				continue
			}
			res["outcome"] = "already_replayed"
			res["pnr"] = deref(pnr)
			res["status"] = status
			if reason != "" {
				res["reason"] = reason
			}
			results = append(results, res)
			continue
		}
		if err != nil {
			res["outcome"] = "error"
			res["reason"] = "could not record the sale"
			results = append(results, res)
			continue
		}

		pnr, err := s.replayOne(ctx, counterID, id.StaffID, sale)
		if err != nil {
			reason := "the seats were not in this counter's quota"
			if !errors.Is(err, inventory.ErrNotInQuota) {
				reason = err.Error()
			}
			_, _ = s.pool.Exec(ctx,
				`UPDATE counter.offline_sales SET status='REJECTED', reject_reason=$2 WHERE client_ref=$1`,
				sale.ClientRef, reason)
			res["outcome"] = "rejected"
			res["reason"] = reason
			results = append(results, res)
			continue
		}
		res["outcome"] = "booked"
		res["pnr"] = pnr
		results = append(results, res)
	}

	s.stf.Audit(ctx, id, "counter.offline.replay", "counter:"+counterID, nil)
	writeJSON(w, 200, map[string]any{"results": results})
}

func (s *Server) replayOne(ctx context.Context, counterID, staffID string, sale offlineSale) (string, error) {
	// The offline terminal quotes its own total, so the server must bound it
	// rather than book whatever figure the queue carries: otherwise a tampered or
	// misbehaving terminal could record a real seat for an arbitrary price and the
	// ledger, settlement and commission would all reconcile to the fabricated
	// number. Recompute the published fare and require the total to sit between
	// the operator's floor (full fare minus the most a concession could absorb)
	// and the full fare. It cannot exceed the published price, and it cannot dip
	// below what the operator could legitimately discount to.
	var fare int64
	if err := s.pool.QueryRow(ctx, `
		SELECT f.amount_poisha FROM catalog.trips t
		  JOIN catalog.route_fares f ON f.route_id = t.route_id
		 WHERE t.trip_id = $1::uuid AND f.from_stop_seq = $2 AND f.to_stop_seq = $3
		 LIMIT 1`, sale.TripID, sale.BoardSeq, sale.DropSeq).Scan(&fare); err != nil {
		return "", fmt.Errorf("no published fare for that journey: %w", err)
	}
	full := fare*int64(len(sale.Seats)) + serviceFeePoisha
	base := full - serviceFeePoisha
	floor := full - (base - base/10) // full minus the operator's absorbable margin
	if sale.TotalPoisha > full || sale.TotalPoisha < floor {
		return "", errOfflineAmount
	}

	// SellQuota is where the rule is enforced: bits move blocked -> sold only
	// if this counter genuinely owned them. A seat outside the quota fails
	// here, in inventory-service, not in the POS.
	holdID, err := s.inv.SellQuota(ctx, counterID, sale.TripID, sale.Seats,
		sale.BoardSeq, sale.DropSeq,
		[]byte(fmt.Sprintf(`{"total_poisha":%d,"offline":true}`, sale.TotalPoisha)))
	if err != nil {
		return "", err
	}

	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, sale.TripID).Scan(&operatorID); err != nil {
		return "", err
	}
	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: holdID, TripID: sale.TripID, OperatorID: operatorID,
		Seats: sale.Seats, BoardSeq: sale.BoardSeq, DropSeq: sale.DropSeq,
		Channel: "COUNTER_OFFLINE", TotalPoisha: sale.TotalPoisha,
	})
	if err != nil {
		return "", err
	}
	s.attributeSale(ctx, bookingID, counterID, "", staffID)
	s.savePassengers(ctx, bookingID, sale.Passengers, sale.Phone, "")

	if err := s.com.SettleCounterSale(ctx, bookingID, sale.ShiftID, "CASH"); err != nil {
		return "", err
	}
	_, _ = s.pool.Exec(ctx, `
		UPDATE counter.offline_sales SET booking_id=$2::uuid, pnr=$3 WHERE client_ref=$1`,
		sale.ClientRef, bookingID, pnr)
	return pnr, nil
}

// ---------------------------------------------------------------- refund --

type counterRefundRequest struct {
	PNR     string `json:"pnr"`
	ShiftID string `json:"shift_id"`
	Reason  string `json:"reason"`
}

// handleCounterRefund refunds a CASH counter sale from the clerk's own drawer.
// The refund amount is the cancellation policy's, not the clerk's to choose, and
// the cash is taken out of the open shift so the drawer reconciles at close. Every
// guard here answers a way this could leak money: another operator's booking, a
// sale that was never cash, or a refund with no drawer to take it from.
func (s *Server) handleCounterRefund(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req counterRefundRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.PNR == "" {
		fail(w, 400, "pnr_required", "Which booking? Give a PNR.")
		return
	}
	if req.Reason == "" {
		fail(w, 400, "reason_required", "A refund needs a reason.")
		return
	}

	// How the booking was paid, and whose it is.
	var bookingOp, channel, status, provider string
	err = s.pool.QueryRow(ctx, `
		SELECT b.operator_id::text, b.channel, b.status,
		       COALESCE((SELECT provider FROM commerce.payments p
		                  WHERE p.booking_id = b.booking_id AND p.status = 'PAID'
		                  ORDER BY p.created_at DESC LIMIT 1), '')
		  FROM commerce.bookings b WHERE b.pnr = upper($1)`, req.PNR).
		Scan(&bookingOp, &channel, &status, &provider)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "No booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}

	// Tenancy: a clerk acts only on their own operator's bookings.
	var counterOp string
	_ = s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM counter.counters WHERE counter_id=$1::uuid`, counterID).Scan(&counterOp)
	if counterOp == "" || bookingOp != counterOp {
		fail(w, 403, "not_your_booking", "That booking belongs to another operator.")
		return
	}
	// A cash refund is only for a cash sale taken at a counter. Refunding cash for
	// a bKash sale would put money on the street that never came off the drawer.
	if channel != "COUNTER" || provider != "CASH" {
		fail(w, 409, "not_a_cash_counter_sale", "Only a cash counter sale can be refunded from the drawer.")
		return
	}
	if status != "TICKETED" && status != "CONFIRMED" && status != "PAID" {
		fail(w, 409, "not_refundable", "This booking cannot be refunded in its current state.")
		return
	}
	// The drawer the cash comes from must be open.
	var open bool
	_ = s.pool.QueryRow(ctx,
		`SELECT true FROM counter.shifts WHERE shift_id = NULLIF($1,'')::uuid
		  AND counter_id = $2::uuid AND status = 'OPEN'`, req.ShiftID, counterID).Scan(&open)
	if !open {
		fail(w, 409, "shift_required", "Open a shift before refunding cash.")
		return
	}

	quote, err := s.com.QuoteCancellation(ctx, req.PNR)
	if err != nil {
		fail(w, 500, "quote_failed", "Could not price the refund.")
		return
	}
	if _, err := s.com.CancelBooking(ctx, req.PNR, req.Reason); err != nil {
		if errors.Is(err, commerce.ErrNotCancellable) {
			fail(w, 409, "already_refunded", "This booking is already being refunded.")
			return
		}
		s.log.Error("counter refund cancel", "err", err)
		fail(w, 500, "refund_failed", "The booking could not be cancelled. Nothing has changed.")
		return
	}
	var paid int64
	if quote.RefundPoisha > 0 {
		paid, err = s.com.SettleRefundCash(ctx, req.PNR, req.ShiftID)
		if err != nil {
			s.log.Error("counter refund settle", "err", err)
			fail(w, 500, "settle_failed",
				"The booking was cancelled but the cash refund did not record. Settle it from the office.")
			return
		}
	}
	outStatus := "REFUNDED"
	if paid == 0 {
		outStatus = "CANCELLED"
	}
	s.stf.Audit(ctx, id, "counter.refund", "booking:"+req.PNR,
		map[string]any{"refund_poisha": paid, "reason": req.Reason})

	writeJSON(w, 200, map[string]any{
		"pnr": req.PNR, "refund_poisha": paid, "refund_pct": quote.RefundPct, "status": outStatus,
	})
}

// ---------------------------------------------------------------- reprint --

type counterReprintRequest struct {
	PNR string `json:"pnr"`
}

// handleCounterReprint hands the clerk the ticket(s) again — the QR is unchanged,
// only reissued on paper — and logs who did it. A reissuable paper ticket is a
// fraud surface, so the reprint is audited even though nothing about the booking
// changes; the boarding scan still catches a seat that tries to board twice.
func (s *Server) handleCounterReprint(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	counterID, err := s.counterOf(id)
	if err != nil {
		fail(w, 403, "no_counter", "This account is not attached to a counter.")
		return
	}
	var req counterReprintRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.PNR == "" {
		fail(w, 400, "pnr_required", "Which booking? Give a PNR.")
		return
	}
	var bookingID, bookingOp, status string
	err = s.pool.QueryRow(ctx,
		`SELECT booking_id::text, operator_id::text, status FROM commerce.bookings WHERE pnr = upper($1)`,
		req.PNR).Scan(&bookingID, &bookingOp, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "No booking with that PNR.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}
	var counterOp string
	_ = s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM counter.counters WHERE counter_id=$1::uuid`, counterID).Scan(&counterOp)
	if counterOp == "" || bookingOp != counterOp {
		fail(w, 403, "not_your_booking", "That booking belongs to another operator.")
		return
	}
	s.stf.Audit(ctx, id, "counter.reprint", "booking:"+req.PNR, nil)
	writeJSON(w, 200, map[string]any{
		"pnr": req.PNR, "status": status, "tickets": s.ticketsFor(ctx, bookingID),
	})
}

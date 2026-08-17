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
	ShiftID            string `json:"shift_id"`
	CountedCashPoisha  int64  `json:"counted_cash_poisha"`
	Note               string `json:"note"`
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
		// An operator manager reading counter reports names the counter instead.
		counterID = r.URL.Query().Get("counter_id")
		if counterID == "" {
			fail(w, 400, "counter_required", "Choose a counter.")
			return
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

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	total := fare*int64(len(req.Seats)) + serviceFeePoisha

	// The one and only seat acquisition path.
	hold, err := s.inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "COUNTER", SessionRef: counterID, TTL: 5 * time.Minute,
		PriceSnapshot: []byte(fmt.Sprintf(
			`{"fare_poisha":%d,"seats":%d,"total_poisha":%d}`, fare, len(req.Seats), total)),
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

	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: hold.HoldID, TripID: req.TripID, OperatorID: operatorID,
		Seats: hold.Seats, BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "COUNTER", TotalPoisha: total,
	})
	if err != nil {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "BOOKING_FAILED")
		s.log.Error("counter booking", "err", err)
		fail(w, 500, "booking_failed", "The booking could not be created.")
		return
	}
	s.attributeSale(ctx, bookingID, counterID, "", id.StaffID)
	s.savePassengers(ctx, bookingID, req.Passengers, req.Phone, "")

	if err := s.com.SettleCounterSale(ctx, bookingID, req.ShiftID, req.Method); err != nil {
		s.log.Error("counter settle", "err", err)
		fail(w, 500, "payment_failed", "Payment could not be recorded. Nothing has been charged.")
		return
	}
	s.stf.Audit(ctx, id, "counter.sale", "booking:"+pnr, nil)

	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "seats": hold.Seats,
		"total_poisha": total, "method": req.Method,
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

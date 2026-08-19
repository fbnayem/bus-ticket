package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/staff/staff"
)

// The owner's view: profit and loss per bus, who sold what, and the costs that
// turn revenue into either.
//
// Everything here is operator-scoped the same way the rest of the ERP is — the
// operator_id comes from the caller's identity, never the request, so an owner
// sees their own fleet and no one else's. Revenue is read from the same
// bookings and commissions every other channel already writes; this file adds
// no new way to earn money, only the way to read what was earned against what
// was spent.
//
// Operating costs live in finance.operating_expenses, deliberately outside the
// platform's double-entry ledger: an operator's diesel is the operator's money,
// not the platform's, and forcing it into the trial balance would corrupt every
// platform account. See migration 025 for the reasoning in full.

func (s *Server) ownerRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/owner/pnl", s.guard("owner.pnl", s.handleOwnerPnl))
	m.HandleFunc("GET /api/v1/owner/sales-by-staff", s.guard("owner.pnl", s.handleOwnerSalesByStaff))
	m.HandleFunc("GET /api/v1/owner/costs", s.guard("owner.pnl", s.handleOwnerCostsList))
	m.HandleFunc("POST /api/v1/owner/costs", s.guard("owner.costs", s.handleOwnerCostAdd))
	m.HandleFunc("DELETE /api/v1/owner/costs/{id}", s.guard("owner.costs", s.handleOwnerCostDelete))
}

// window reads ?from=&to= as inclusive dates, defaulting to the last 30 days.
// Bad dates are ignored rather than errored: a report with a sensible default
// window is more useful than a 400 when a query string is fat-fingered.
func window(r *http.Request) (from, to string) {
	to = r.URL.Query().Get("to")
	from = r.URL.Query().Get("from")
	if !validDate(to) {
		to = time.Now().Format("2006-01-02")
	}
	if !validDate(from) {
		if t, err := time.Parse("2006-01-02", to); err == nil {
			from = t.AddDate(0, 0, -29).Format("2006-01-02")
		}
	}
	return from, to
}

func validDate(s string) bool {
	if s == "" {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// handleOwnerPnl is the profit-and-loss, one row per bus plus an operator total.
//
// The arithmetic is the one written down in migration 025 and proved against
// the live database before it was written here:
//
//	gross − platform commission − staff commission = net fare to operator
//	net fare − (fuel + maintenance + wages + …)     = profit or loss
//
// Platform commission is recomputed from the UNDISCOUNTED base — total plus the
// discount that was granted — exactly as settlement does, so the owner's P&L
// and the platform's settlement never disagree about the platform's cut.
func (s *Server) handleOwnerPnl(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	from, to := window(r)
	ctx := r.Context()

	rows, err := s.pool.Query(ctx, `
		WITH rev AS (
		  SELECT t.bus_id,
		         count(*)                          AS bookings,
		         COALESCE(sum(bk.total_poisha),0)  AS gross,
		         COALESCE(sum(((bk.total_poisha + bk.discount_poisha - $4::bigint)/10) + $4::bigint),0) AS platform_comm,
		         COALESCE(sum(cc.amount_poisha),0) + COALESCE(sum(ac.amount_poisha),0)                  AS staff_comm
		    FROM commerce.bookings bk
		    JOIN catalog.trips t          ON t.trip_id  = bk.trip_id
		    LEFT JOIN crew.commissions cc ON cc.booking_id = bk.booking_id
		    LEFT JOIN agent.commissions ac ON ac.booking_id = bk.booking_id
		   WHERE bk.operator_id = $1::uuid
		     AND bk.status IN ('TICKETED','CONFIRMED','COMPLETED')
		     AND (bk.created_at AT TIME ZONE 'Asia/Dhaka')::date >= $2::date
		     AND (bk.created_at AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
		   GROUP BY t.bus_id
		),
		cost AS (
		  SELECT bus_id,
		         COALESCE(sum(amount_poisha),0)                                          AS costs,
		         COALESCE(sum(amount_poisha) FILTER (WHERE category='FUEL'),0)           AS fuel,
		         COALESCE(sum(amount_poisha) FILTER (WHERE category='MAINTENANCE'),0)    AS maintenance,
		         COALESCE(sum(amount_poisha) FILTER (WHERE category='WAGES'),0)          AS wages,
		         COALESCE(sum(amount_poisha) FILTER (WHERE category NOT IN ('FUEL','MAINTENANCE','WAGES')),0) AS other
		    FROM finance.operating_expenses
		   WHERE operator_id = $1::uuid
		     AND incurred_on >= $2::date AND incurred_on <= $3::date
		   GROUP BY bus_id
		)
		SELECT b.bus_id::text, b.registration,
		       COALESCE(r.bookings,0), COALESCE(r.gross,0), COALESCE(r.platform_comm,0), COALESCE(r.staff_comm,0),
		       COALESCE(c.fuel,0), COALESCE(c.maintenance,0), COALESCE(c.wages,0), COALESCE(c.other,0), COALESCE(c.costs,0)
		  FROM catalog.buses b
		  LEFT JOIN rev  r ON r.bus_id = b.bus_id
		  LEFT JOIN cost c ON c.bus_id = b.bus_id
		 WHERE b.operator_id = $1::uuid
		 ORDER BY (COALESCE(r.gross,0) - COALESCE(r.platform_comm,0) - COALESCE(r.staff_comm,0) - COALESCE(c.costs,0)) DESC`,
		op, from, to, int64(serviceFeePoisha))
	if err != nil {
		s.log.Error("owner pnl", "err", err)
		fail(w, 500, "query_failed", "Could not load the profit and loss.")
		return
	}
	defer rows.Close()

	type busPnl struct {
		BusID       string `json:"bus_id"`
		Bus         string `json:"registration"`
		Bookings    int64  `json:"bookings"`
		Gross       int64  `json:"gross_poisha"`
		Platform    int64  `json:"platform_commission_poisha"`
		StaffComm   int64  `json:"staff_commission_poisha"`
		NetFare     int64  `json:"net_fare_poisha"`
		Fuel        int64  `json:"fuel_poisha"`
		Maintenance int64  `json:"maintenance_poisha"`
		Wages       int64  `json:"wages_poisha"`
		Other       int64  `json:"other_poisha"`
		Costs       int64  `json:"costs_poisha"`
		Profit      int64  `json:"profit_poisha"`
	}
	var buses []busPnl
	var tGross, tPlatform, tStaff, tNet, tCosts, tProfit, tBookings int64
	for rows.Next() {
		var p busPnl
		if err := rows.Scan(&p.BusID, &p.Bus, &p.Bookings, &p.Gross, &p.Platform, &p.StaffComm,
			&p.Fuel, &p.Maintenance, &p.Wages, &p.Other, &p.Costs); err != nil {
			s.log.Error("owner pnl scan", "err", err)
			fail(w, 500, "scan_failed", "Could not read the profit and loss.")
			return
		}
		p.NetFare = p.Gross - p.Platform - p.StaffComm
		p.Profit = p.NetFare - p.Costs
		buses = append(buses, p)
		tBookings += p.Bookings
		tGross += p.Gross
		tPlatform += p.Platform
		tStaff += p.StaffComm
		tNet += p.NetFare
		tCosts += p.Costs
		tProfit += p.Profit
	}

	// Operator-wide overhead: costs with no bus (office, network permit). They
	// belong in the operator total but in no single bus, so they are added here
	// and never to a bus row.
	var oheadFuel, oheadMaint, oheadWages, oheadOther, oheadTotal int64
	_ = s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE category='FUEL'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE category='MAINTENANCE'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE category='WAGES'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE category NOT IN ('FUEL','MAINTENANCE','WAGES')),0),
		       COALESCE(sum(amount_poisha),0)
		  FROM finance.operating_expenses
		 WHERE operator_id = $1::uuid AND bus_id IS NULL
		   AND incurred_on >= $2::date AND incurred_on <= $3::date`, op, from, to).
		Scan(&oheadFuel, &oheadMaint, &oheadWages, &oheadOther, &oheadTotal)
	tCosts += oheadTotal
	tProfit -= oheadTotal

	writeJSON(w, 200, map[string]any{
		"operator_id": op,
		"from":        from,
		"to":          to,
		"buses":       buses,
		"overhead": map[string]any{
			"fuel_poisha": oheadFuel, "maintenance_poisha": oheadMaint,
			"wages_poisha": oheadWages, "other_poisha": oheadOther, "costs_poisha": oheadTotal,
		},
		"totals": map[string]any{
			"bookings": tBookings, "gross_poisha": tGross,
			"platform_commission_poisha": tPlatform, "staff_commission_poisha": tStaff,
			"net_fare_poisha": tNet, "costs_poisha": tCosts, "profit_poisha": tProfit,
		},
	})
}

// handleOwnerSalesByStaff answers "who sold how many tickets, and what did they
// earn?" — the cross-staff report the owner asked for by name. One row per staff
// member who sold anything in the window.
func (s *Server) handleOwnerSalesByStaff(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	from, to := window(r)

	rows, err := s.pool.Query(r.Context(), `
		SELECT su.staff_id::text, su.full_name,
		       COALESCE(string_agg(DISTINCT rr.role_key, ', '), '') AS roles,
		       count(*)                                  AS tickets,
		       COALESCE(sum(bk.total_poisha),0)          AS gross,
		       COALESCE(sum(bk.discount_poisha),0)       AS discount,
		       COALESCE(sum(cc.amount_poisha),0)         AS commission
		  FROM commerce.bookings bk
		  JOIN staff.staff_users su ON su.staff_id = bk.sold_by
		  LEFT JOIN staff.user_roles ur ON ur.staff_id = su.staff_id
		  LEFT JOIN catalog.roles rr    ON rr.role_id  = ur.role_id
		  LEFT JOIN crew.commissions cc ON cc.booking_id = bk.booking_id AND cc.staff_id = su.staff_id
		 WHERE bk.operator_id = $1::uuid
		   AND bk.sold_by IS NOT NULL
		   AND bk.status IN ('TICKETED','CONFIRMED','COMPLETED')
		   AND (bk.created_at AT TIME ZONE 'Asia/Dhaka')::date >= $2::date
		   AND (bk.created_at AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
		 GROUP BY su.staff_id, su.full_name
		 ORDER BY gross DESC`, op, from, to)
	if err != nil {
		s.log.Error("owner sales-by-staff", "err", err)
		fail(w, 500, "query_failed", "Could not load the staff sales report.")
		return
	}
	defer rows.Close()

	type staffRow struct {
		StaffID    string `json:"staff_id"`
		Name       string `json:"full_name"`
		Roles      string `json:"roles"`
		Tickets    int64  `json:"tickets"`
		Gross      int64  `json:"gross_poisha"`
		Discount   int64  `json:"discount_poisha"`
		Commission int64  `json:"commission_poisha"`
	}
	var out []staffRow
	var tTickets, tGross, tDiscount, tComm int64
	for rows.Next() {
		var x staffRow
		if err := rows.Scan(&x.StaffID, &x.Name, &x.Roles, &x.Tickets, &x.Gross, &x.Discount, &x.Commission); err != nil {
			fail(w, 500, "scan_failed", "Could not read the staff sales report.")
			return
		}
		out = append(out, x)
		tTickets += x.Tickets
		tGross += x.Gross
		tDiscount += x.Discount
		tComm += x.Commission
	}
	writeJSON(w, 200, map[string]any{
		"operator_id": op, "from": from, "to": to, "staff": out,
		"totals": map[string]any{
			"tickets": tTickets, "gross_poisha": tGross,
			"discount_poisha": tDiscount, "commission_poisha": tComm,
		},
	})
}

// handleOwnerCostsList lists operating expenses in the window, newest first.
func (s *Server) handleOwnerCostsList(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	from, to := window(r)
	busFilter := strings.TrimSpace(r.URL.Query().Get("bus"))

	rows, err := s.pool.Query(r.Context(), `
		SELECT e.expense_id::text, COALESCE(b.registration,''), COALESCE(e.bus_id::text,''),
		       e.category, e.amount_poisha, e.incurred_on::text, e.note,
		       COALESCE(su.full_name,'')
		  FROM finance.operating_expenses e
		  LEFT JOIN catalog.buses b       ON b.bus_id = e.bus_id
		  LEFT JOIN staff.staff_users su  ON su.staff_id = e.recorded_by
		 WHERE e.operator_id = $1::uuid
		   AND e.incurred_on >= $2::date AND e.incurred_on <= $3::date
		   AND ($4 = '' OR e.bus_id = $4::uuid)
		 ORDER BY e.incurred_on DESC, e.created_at DESC
		 LIMIT 500`, op, from, to, busFilter)
	if err != nil {
		s.log.Error("owner costs list", "err", err)
		fail(w, 500, "query_failed", "Could not load the costs.")
		return
	}
	defer rows.Close()

	type cost struct {
		ExpenseID  string `json:"expense_id"`
		Bus        string `json:"registration"`
		BusID      string `json:"bus_id"`
		Category   string `json:"category"`
		Amount     int64  `json:"amount_poisha"`
		IncurredOn string `json:"incurred_on"`
		Note       string `json:"note"`
		RecordedBy string `json:"recorded_by"`
	}
	var out []cost
	var total int64
	for rows.Next() {
		var c cost
		if err := rows.Scan(&c.ExpenseID, &c.Bus, &c.BusID, &c.Category, &c.Amount, &c.IncurredOn, &c.Note, &c.RecordedBy); err != nil {
			fail(w, 500, "scan_failed", "Could not read the costs.")
			return
		}
		out = append(out, c)
		total += c.Amount
	}
	writeJSON(w, 200, map[string]any{
		"operator_id": op, "from": from, "to": to,
		"costs": out, "total_poisha": total,
	})
}

type costRequest struct {
	BusID      string `json:"bus_id"`
	Category   string `json:"category"`
	Amount     int64  `json:"amount_poisha"`
	IncurredOn string `json:"incurred_on"`
	Note       string `json:"note"`
}

var costCategories = map[string]bool{
	"FUEL": true, "MAINTENANCE": true, "WAGES": true,
	"INSURANCE": true, "TOLL": true, "PERMIT": true, "OTHER": true,
}

// handleOwnerCostAdd records one operating expense.
//
// The bus, if named, must belong to the caller's operator — checked in the
// INSERT's WHERE, not the app, so a request naming another operator's bus
// inserts nothing rather than mis-attributing a cost across a tenant boundary.
func (s *Server) handleOwnerCostAdd(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	var req costRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Category = strings.ToUpper(strings.TrimSpace(req.Category))
	if !costCategories[req.Category] {
		fail(w, 400, "bad_category", "Choose fuel, maintenance, wages, insurance, toll, permit or other.")
		return
	}
	if req.Amount <= 0 {
		fail(w, 400, "bad_amount", "A cost must be more than zero.")
		return
	}
	if !validDate(req.IncurredOn) {
		fail(w, 400, "bad_date", "Give the date the money was spent, as YYYY-MM-DD.")
		return
	}

	ctx := r.Context()
	var expenseID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO finance.operating_expenses (operator_id, bus_id, category, amount_poisha, incurred_on, note, recorded_by)
		SELECT $1::uuid, NULLIF($2,'')::uuid, $3, $4::bigint, $5::date, $6, $7::uuid
		 WHERE $2 = ''
		    OR EXISTS (SELECT 1 FROM catalog.buses b WHERE b.bus_id = NULLIF($2,'')::uuid AND b.operator_id = $1::uuid)
		RETURNING expense_id::text`,
		op, strings.TrimSpace(req.BusID), req.Category, req.Amount, req.IncurredOn, strings.TrimSpace(req.Note), id.StaffID).
		Scan(&expenseID)
	if err != nil {
		// No row returned means the bus was not this operator's, which is the
		// only WHERE that can fail; anything else is a real error.
		fail(w, 400, "bad_bus", "That bus is not in your fleet.")
		return
	}

	s.stf.Audit(ctx, id, "owner.cost.add", "expense:"+expenseID, map[string]any{
		"category": req.Category, "amount_poisha": req.Amount, "bus_id": req.BusID,
	})
	writeJSON(w, 200, map[string]any{"expense_id": expenseID})
}

// handleOwnerCostDelete removes an expense — the sanctioned way to correct one,
// since a cost is never stored as a negative number. Scoped to the operator, so
// one owner cannot delete another's rows.
func (s *Server) handleOwnerCostDelete(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	expenseID := r.PathValue("id")
	ctx := r.Context()
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM finance.operating_expenses WHERE expense_id = $1::uuid AND operator_id = $2::uuid`,
		expenseID, op)
	if err != nil {
		fail(w, 500, "delete_failed", "That cost could not be removed.")
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 404, "not_found", "No such cost in your fleet.")
		return
	}
	s.stf.Audit(ctx, id, "owner.cost.delete", "expense:"+expenseID, nil)
	writeJSON(w, 200, map[string]any{"deleted": true})
}

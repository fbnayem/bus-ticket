package httpapi

import (
	"net/http"

	"github.com/busticket/platform/services/staff/staff"
)

// loadFactorPct is how full the buses ran: seats sold over seats offered. It is
// the single number an operator judges a period by, and the reason it lives in
// its own function is the zero: a day with no trips has no capacity, and dividing
// by it must yield 0%, never a panic and never a nonsense number.
func loadFactorPct(sold, capacity int64) int {
	if capacity <= 0 {
		return 0
	}
	return int(sold * 100 / capacity)
}

// handleOperatorInsights is the operational view over a date range that the
// "today" dashboard cannot give: revenue, seats sold, how full the buses ran, and
// which routes carried it. Tenancy is fixed from the identity, never the request.
// Dates are Asia/Dhaka service dates, so a night run counts on the day it was
// scheduled, not the day it happened to cross midnight.
func (s *Server) handleOperatorInsights(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))

	to := r.URL.Query().Get("to")
	from := r.URL.Query().Get("from")
	if to == "" {
		to = dhakaToday()
	}
	if from == "" {
		from = dhakaDaysAgo(29)
	}

	const live = `('TICKETED','CONFIRMED','COMPLETED')`

	// Trips run and the capacity they offered (over trips only, so no join fans
	// the seat count out).
	var trips, capacity int64
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE(sum((SELECT count(*) FROM inventory.trip_seats ts WHERE ts.trip_id=t.trip_id)),0)
		  FROM catalog.trips t
		 WHERE ($1='' OR t.operator_id=$1::uuid) AND t.service_date BETWEEN $2::date AND $3::date`,
		op, from, to).Scan(&trips, &capacity)

	// Revenue and seats sold (over live bookings on those trips).
	var revenue, seatsSold int64
	_ = s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(b.total_poisha),0),
		       COALESCE(sum((SELECT count(*) FROM commerce.booking_seats bs WHERE bs.booking_id=b.booking_id)),0)
		  FROM catalog.trips t
		  JOIN commerce.bookings b ON b.trip_id=t.trip_id AND b.status IN `+live+`
		 WHERE ($1='' OR t.operator_id=$1::uuid) AND t.service_date BETWEEN $2::date AND $3::date`,
		op, from, to).Scan(&revenue, &seatsSold)

	// Top routes by revenue.
	type routeRow struct {
		Route     string `json:"route"`
		Revenue   int64  `json:"revenue_poisha"`
		SeatsSold int64  `json:"seats_sold"`
		Trips     int64  `json:"trips"`
	}
	routes := []routeRow{}
	if rows, err := s.pool.Query(ctx, `
		SELECT r.name,
		       COALESCE(sum(b.total_poisha),0),
		       COALESCE(sum((SELECT count(*) FROM commerce.booking_seats bs WHERE bs.booking_id=b.booking_id)),0),
		       count(DISTINCT t.trip_id)
		  FROM catalog.trips t
		  JOIN catalog.routes r ON r.route_id=t.route_id
		  JOIN commerce.bookings b ON b.trip_id=t.trip_id AND b.status IN `+live+`
		 WHERE ($1='' OR t.operator_id=$1::uuid) AND t.service_date BETWEEN $2::date AND $3::date
		 GROUP BY r.name ORDER BY 2 DESC LIMIT 8`, op, from, to); err == nil {
		defer rows.Close()
		for rows.Next() {
			var rr routeRow
			if rows.Scan(&rr.Route, &rr.Revenue, &rr.SeatsSold, &rr.Trips) == nil {
				routes = append(routes, rr)
			}
		}
	}

	writeJSON(w, 200, map[string]any{
		"from": from, "to": to,
		"revenue_poisha":  revenue,
		"seats_sold":      seatsSold,
		"trips":           trips,
		"capacity":        capacity,
		"load_factor_pct": loadFactorPct(seatsSold, capacity),
		"top_routes":      routes,
	})
}

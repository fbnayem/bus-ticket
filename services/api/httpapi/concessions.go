package httpapi

import (
	"context"
	"net/http"

	"github.com/busticket/platform/services/staff/staff"
)

// Concession fares — the reduced fares for children, students and senior
// citizens, applied at the counter where a clerk can see the ID that entitles
// someone to one.
//
// A concession reduces the fare by a fixed percentage (basis points) and the
// operator absorbs it; the platform's booking fee and commission are untouched.
// Resolution is override-first: an operator's own row for a code wins, and the
// platform default stands in when they have none.

func (s *Server) concessionRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/counter/concessions", s.guard("counter.sell", s.handleCounterConcessions))
}

// concessionRates returns code -> discount basis points for the concessions in
// force for one operator, the operator's own overrides winning over defaults.
func (s *Server) concessionRates(ctx context.Context, operatorID string) map[string]int {
	rates := map[string]int{}
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (code) code, discount_bp
		  FROM catalog.concession_types
		 WHERE active AND (operator_id IS NULL OR operator_id = $1::uuid)
		 ORDER BY code, (operator_id IS NOT NULL) DESC`, operatorID)
	if err != nil {
		return rates
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		var bp int
		if rows.Scan(&code, &bp) == nil {
			rates[code] = bp
		}
	}
	return rates
}

// concessionDiscount totals the fare reduction for a set of per-seat concession
// codes (parallel to the seats; an empty code is a full-fare seat). Each seat's
// reduction is fare × bp / 10000, and is capped at the fare so a concession can
// never make a seat cost less than nothing.
func concessionDiscount(fare int64, codes []string, rates map[string]int) int64 {
	var d int64
	for _, c := range codes {
		if c == "" {
			continue
		}
		bp, ok := rates[c]
		if !ok {
			continue
		}
		cut := fare * int64(bp) / 10000
		if cut > fare {
			cut = fare
		}
		d += cut
	}
	return d
}

func (s *Server) handleCounterConcessions(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	// The concessions this clerk can grant belong to their operator; a counter
	// account is always pinned to one, so its own overrides are in view.
	op := id.OperatorID
	rows, err := s.pool.Query(r.Context(), `
		SELECT DISTINCT ON (code) code, label, label_bn, discount_bp
		  FROM catalog.concession_types
		 WHERE active AND (operator_id IS NULL OR operator_id = $1::uuid)
		 ORDER BY code, (operator_id IS NOT NULL) DESC`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load concessions.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var code, label, labelBn string
		var bp int
		if rows.Scan(&code, &label, &labelBn, &bp) != nil {
			continue
		}
		out = append(out, map[string]any{
			"code": code, "label": label, "label_bn": labelBn, "discount_bp": bp,
		})
	}
	writeJSON(w, 200, map[string]any{"concessions": out})
}

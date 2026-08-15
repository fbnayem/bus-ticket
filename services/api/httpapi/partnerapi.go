package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/ops/ops"
	"github.com/busticket/platform/services/partner/partner"
	"github.com/busticket/platform/services/promo/promo"
	"github.com/busticket/platform/services/searchidx/searchidx"
)

// The partner API.
//
// Read the handlers below and notice what is NOT in them: no seat arithmetic,
// no availability logic, no pricing. `POST /v1/holds` calls the same
// inventory.AcquireHold the website calls, and `POST /v1/bookings` calls the
// same commerce.CreateBooking. A partner is a sales channel, and the rule that
// governs every sales channel governs this one.
//
// What IS here is the perimeter: signature verification with a replay window,
// quotas, tiers, and a sandbox that has to be certified before a partner can be
// moved to production.

func (s *Server) partnerRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/partner/v1/locations", s.partnerGuard(false, s.pLocations))
	m.HandleFunc("GET /api/v1/partner/v1/search", s.partnerGuard(false, s.pSearch))
	m.HandleFunc("GET /api/v1/partner/v1/trips/{tripID}/availability", s.partnerGuard(false, s.pAvailability))
	m.HandleFunc("POST /api/v1/partner/v1/holds", s.partnerGuard(true, s.pHold))
	m.HandleFunc("POST /api/v1/partner/v1/bookings", s.partnerGuard(true, s.pBooking))
	m.HandleFunc("GET /api/v1/partner/v1/bookings/{pnr}", s.partnerGuard(false, s.pGetBooking))
	m.HandleFunc("POST /api/v1/partner/v1/cancellations", s.partnerGuard(true, s.pCancel))
	m.HandleFunc("GET /api/v1/partner/v1/deliveries", s.partnerGuard(false, s.pDeliveries))

	// The sandbox sink. This is where a partner's webhooks land while they are
	// integrating — and where this build's own webhooks land, so the signing,
	// the delivery and the verification are exercised for real.
	m.HandleFunc("POST /api/v1/partner/sandbox/sink", s.handleSandboxSink)
}

type partnerHandler func(http.ResponseWriter, *http.Request, *partner.Caller, []byte)

// partnerGuard authenticates, charges quota, and hands the handler a caller it
// can trust. Anything that moves seats or money requires a signature; read-only
// endpoints accept an API key.
func (s *Server) partnerGuard(requireSignature bool, h partnerHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			fail(w, 400, "bad_request", "Could not read the request body.")
			return
		}
		caller, err := s.prt.Authenticate(r.Context(), r, body, requireSignature)
		switch {
		case errors.Is(err, partner.ErrQuota):
			used, limit, _, _ := s.prt.Quota(r.Context(), "")
			w.Header().Set("X-RateLimit-Limit", itoa(limit))
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", tomorrowUnix())
			_ = used
			fail(w, 429, "quota_exhausted", "Your daily quota is used up. It resets at midnight Asia/Dhaka.")
			return
		case errors.Is(err, partner.ErrReplay):
			fail(w, 401, "replay_detected", "That nonce has already been used.")
			return
		case errors.Is(err, partner.ErrStale):
			fail(w, 401, "stale_request", "That request timestamp is outside the five-minute window.")
			return
		case errors.Is(err, partner.ErrNotAllowed):
			fail(w, 403, "ip_not_allowed", "This source address is not on your allow-list.")
			return
		case errors.Is(err, partner.ErrSuspended):
			fail(w, 403, "suspended", "This partner account is suspended.")
			return
		case err != nil:
			fail(w, 401, "unauthenticated", "We could not authenticate that request.")
			return
		}
		used, limit, _, _ := s.prt.Quota(r.Context(), caller.PartnerID)
		w.Header().Set("X-RateLimit-Limit", itoa(limit))
		w.Header().Set("X-RateLimit-Remaining", itoa(max0(limit-used)))
		w.Header().Set("X-Jatra-Tier", caller.Tier)
		h(w, r, caller, body)
	}
}

func (s *Server) pLocations(w http.ResponseWriter, r *http.Request, _ *partner.Caller, _ []byte) {
	locs, err := s.idx.Locations(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load locations.")
		return
	}
	writeJSON(w, 200, map[string]any{"locations": locs})
}

func (s *Server) pSearch(w http.ResponseWriter, r *http.Request, _ *partner.Caller, _ []byte) {
	q := r.URL.Query()
	fromID, _, err := s.idx.ResolveLocation(r.Context(), q.Get("from"))
	if err != nil {
		fail(w, 400, "unknown_origin", "We don't recognise that origin.")
		return
	}
	toID, _, err := s.idx.ResolveLocation(r.Context(), q.Get("to"))
	if err != nil {
		fail(w, 400, "unknown_destination", "We don't recognise that destination.")
		return
	}
	date := q.Get("date")
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	res, err := s.idx.Query(r.Context(), searchidx.Params{
		OriginID: fromID, DestID: toID, Date: date,
		Passengers: queryInt(r, "passengers", 1), Sort: q.Get("sort"),
	})
	if err != nil {
		fail(w, 500, "search_failed", "Search is temporarily unavailable.")
		return
	}
	writeJSON(w, 200, res)
}

func (s *Server) pAvailability(w http.ResponseWriter, r *http.Request, _ *partner.Caller, _ []byte) {
	// Straight to inventory-service — the authoritative answer, the same one the
	// website's seat map gets.
	seats, err := s.inv.SeatMap(r.Context(), r.PathValue("tripID"),
		queryInt(r, "board", 0), queryInt(r, "drop", 0))
	if err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	free := []string{}
	for _, st := range seats {
		if st.Available {
			free = append(free, st.SeatNo)
		}
	}
	writeJSON(w, 200, map[string]any{
		"trip_id": r.PathValue("tripID"), "available_seats": free, "total_seats": len(seats),
	})
}

func (s *Server) pHold(w http.ResponseWriter, r *http.Request, c *partner.Caller, body []byte) {
	var req struct {
		TripID   string   `json:"trip_id"`
		Seats    []string `json:"seats"`
		BoardSeq int      `json:"board_seq"`
		DropSeq  int      `json:"drop_seq"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	hold, err := s.inv.AcquireHold(r.Context(), inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "PARTNER", SessionRef: "partner:" + c.PartnerID,
		TTL: 10 * time.Minute,
	})
	if errors.Is(err, inventory.ErrSeatUnavailable) {
		fail(w, 409, "seat_unavailable", "One of those seats has just been taken.")
		return
	}
	if err != nil {
		fail(w, 400, "hold_failed", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{
		"hold_id": hold.HoldID, "seats": hold.Seats, "expires_at": hold.ExpiresAt,
	})
}

func (s *Server) pBooking(w http.ResponseWriter, r *http.Request, c *partner.Caller, body []byte) {
	var req struct {
		HoldID string `json:"hold_id"`
		Phone  string `json:"contact_phone"`
		Email  string `json:"contact_email"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	bookingID, pnr, total, err := s.bookFromHold(r, req.HoldID, "PARTNER")
	if err != nil {
		fail(w, 400, "booking_failed", err.Error())
		return
	}
	s.savePassengers(r.Context(), bookingID, nil, req.Phone, req.Email)
	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "total_poisha": total,
		"payment_required": true,
		"notice": "The booking is held pending payment. It confirms only on a verified payment webhook.",
	})
}

func (s *Server) pGetBooking(w http.ResponseWriter, r *http.Request, _ *partner.Caller, _ []byte) {
	var status string
	var total int64
	if err := s.pool.QueryRow(r.Context(),
		`SELECT status, total_poisha FROM commerce.bookings WHERE pnr = $1`,
		strings.ToUpper(r.PathValue("pnr"))).Scan(&status, &total); err != nil {
		fail(w, 404, "not_found", "No booking with that PNR.")
		return
	}
	writeJSON(w, 200, map[string]any{
		"pnr": strings.ToUpper(r.PathValue("pnr")), "status": status, "total_poisha": total,
	})
}

func (s *Server) pCancel(w http.ResponseWriter, r *http.Request, _ *partner.Caller, body []byte) {
	var req struct {
		PNR    string `json:"pnr"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	q, err := s.com.CancelBooking(r.Context(), strings.ToUpper(req.PNR), req.Reason)
	if err != nil {
		fail(w, 409, "cancel_failed", err.Error())
		return
	}
	writeJSON(w, 200, q)
}

func (s *Server) pDeliveries(w http.ResponseWriter, r *http.Request, c *partner.Caller, _ []byte) {
	list, err := s.prt.Deliveries(r.Context(), c.PartnerID, queryInt(r, "limit", 50))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your delivery log.")
		return
	}
	writeJSON(w, 200, map[string]any{"deliveries": list})
}

// handleSandboxSink verifies the signature the platform sent, using the same
// secret a real partner holds. A delivery that does not verify is recorded as
// such and rejected, which is what makes the outbound signing a proof.
func (s *Server) handleSandboxSink(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		fail(w, 400, "bad_request", "Could not read the body.")
		return
	}
	// A partner endpoint that is down is a normal condition, and the retry path
	// has to be exercised. ?fail= lets a test make this endpoint fail on demand.
	if code := r.URL.Query().Get("fail"); code != "" {
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		_, _ = s.pool.Exec(r.Context(), `
			INSERT INTO partner.sandbox_receipts (event_id, event_type, signature_ok, body)
			VALUES (NULLIF($1,'')::uuid, $2, false, $3)`,
			str(payload["event_id"]), str(payload["event_type"]), body)
		fail(w, 503, "sink_down", "This sandbox sink was asked to fail.")
		return
	}

	partnerID, ok := s.prt.VerifyInboundWebhook(r.Context(),
		r.Header.Get("X-Jatra-Timestamp"), r.Header.Get("X-Jatra-Signature"), body)

	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO partner.sandbox_receipts (partner_id, event_id, event_type, signature_ok, body)
		VALUES (NULLIF($1,'')::uuid, NULLIF($2,'')::uuid, $3, $4, $5)`,
		partnerID, str(payload["event_id"]), str(payload["event_type"]), ok, body); err != nil {
		s.log.Warn("sandbox receipt", "err", err)
	}
	if !ok {
		fail(w, 401, "bad_signature", "That webhook signature does not verify.")
		return
	}
	writeJSON(w, 200, map[string]any{"received": true})
}

// ------------------------------------------------------------- small helpers --

func (s *Server) thresholds() ops.Thresholds { return ops.DefaultThresholds() }

func promoContext(phone string, amount int64, operatorID, routeID, channel, provider string) promo.Context {
	if channel == "" {
		channel = "WEB"
	}
	return promo.Context{
		UserKey: phone, AmountPoisha: amount, OperatorID: operatorID,
		RouteID: routeID, Channel: channel, Provider: provider,
	}
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func itoa(n int) string {
	if n < 0 {
		n = 0
	}
	digits := ""
	if n == 0 {
		return "0"
	}
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

func tomorrowUnix() string {
	t := time.Now().AddDate(0, 0, 1).Truncate(24 * time.Hour)
	return itoa(int(t.Unix()))
}

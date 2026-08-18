package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/notify/notify"
	"github.com/busticket/platform/services/staff/staff"
)

// The consoles for everything added after the first six applications: the event
// backbone, the notification platform, the operations control centre,
// reconciliation, promotions, risk and partners.
//
// Every route is behind a permission string, and the permission is checked by
// the server on every request regardless of what the navigation showed.

func (s *Server) platformRoutes(m *http.ServeMux) {
	// ---- event backbone ----
	m.HandleFunc("GET /api/v1/admin/events", s.guard("events.read", s.handleEventLog))
	m.HandleFunc("GET /api/v1/admin/events/consumers", s.guard("events.read", s.handleConsumers))
	m.HandleFunc("GET /api/v1/admin/events/dead-letters", s.guard("events.read", s.handleDeadLetters))
	m.HandleFunc("POST /api/v1/admin/events/replay", s.guard("events.manage", s.handleReplayEvent))
	m.HandleFunc("POST /api/v1/admin/events/drain", s.guard("events.manage", s.handleDrain))

	// ---- notifications ----
	m.HandleFunc("GET /api/v1/admin/notifications", s.guard("notify.read", s.handleNotifications))
	m.HandleFunc("GET /api/v1/admin/notifications/providers", s.guard("notify.read", s.handleProviders))
	m.HandleFunc("GET /api/v1/admin/notifications/spend", s.guard("notify.read", s.handleSpend))
	m.HandleFunc("PATCH /api/v1/admin/notifications/providers/{provider}", s.guard("notify.manage", s.handleSetProvider))
	m.HandleFunc("PATCH /api/v1/admin/notifications/budget", s.guard("notify.manage", s.handleSetBudget))
	m.HandleFunc("POST /api/v1/admin/notifications/test", s.guard("notify.manage", s.handleTestNotification))

	// ---- operations control centre ----
	m.HandleFunc("GET /api/v1/ops/alerts", s.guard("ops.monitor", s.handleAlerts))
	m.HandleFunc("GET /api/v1/ops/live", s.guard("ops.monitor", s.handleLiveBuses))
	m.HandleFunc("POST /api/v1/ops/scan", s.guard("ops.monitor", s.handleScanAlerts))
	m.HandleFunc("POST /api/v1/ops/alerts/{alertID}/ack", s.guard("ops.manage", s.handleAckAlert))
	m.HandleFunc("POST /api/v1/ops/trips/{tripID}/replace-bus", s.guard("ops.manage", s.handleReplaceBus))
	m.HandleFunc("GET /api/v1/ops/trips/{tripID}/conflicts", s.guard("ops.manage", s.handleConflicts))
	m.HandleFunc("POST /api/v1/ops/trips/{tripID}/conflicts/resolve", s.guard("ops.manage", s.handleResolveConflict))

	// ---- reconciliation ----
	m.HandleFunc("GET /api/v1/finance/recon/runs", s.guard("recon.read", s.handleReconRuns))
	m.HandleFunc("GET /api/v1/finance/recon/exceptions", s.guard("recon.read", s.handleReconExceptions))
	m.HandleFunc("POST /api/v1/finance/recon/run", s.guard("recon.manage", s.handleReconRun))
	m.HandleFunc("POST /api/v1/finance/recon/import", s.guard("recon.manage", s.handleReconImport))
	m.HandleFunc("POST /api/v1/finance/recon/exceptions/{id}", s.guard("recon.manage", s.handleResolveException))

	// ---- promotions and referrals ----
	m.HandleFunc("GET /api/v1/admin/campaigns", s.guard("promo.read", s.handleCampaigns))
	m.HandleFunc("POST /api/v1/admin/campaigns", s.guard("promo.manage", s.handleCreateCampaign))
	m.HandleFunc("GET /api/v1/admin/referrals", s.guard("promo.read", s.handleAdminReferrals))

	// ---- risk ----
	m.HandleFunc("GET /api/v1/admin/risk/rules", s.guard("risk.read", s.handleRiskRules))
	m.HandleFunc("GET /api/v1/admin/risk/cases", s.guard("risk.read", s.handleRiskCases))
	m.HandleFunc("GET /api/v1/admin/risk/blocks", s.guard("risk.read", s.handleRiskBlocks))
	m.HandleFunc("GET /api/v1/admin/risk/stats", s.guard("risk.read", s.handleRiskStats))
	m.HandleFunc("PATCH /api/v1/admin/risk/rules/{code}", s.guard("risk.manage", s.handleRiskSetMode))
	m.HandleFunc("POST /api/v1/admin/risk/cases/{id}/close", s.guard("risk.manage", s.handleRiskCloseCase))
	m.HandleFunc("POST /api/v1/admin/risk/blocks/lift", s.guard("risk.manage", s.handleRiskLift))

	// ---- partners ----
	m.HandleFunc("GET /api/v1/admin/partners", s.guard("partner.read", s.handlePartners))
	m.HandleFunc("GET /api/v1/admin/partners/deliveries", s.guard("partner.read", s.handleDeliveries))
	m.HandleFunc("POST /api/v1/admin/partners/{id}/certify", s.guard("partner.manage", s.handleCertify))
	m.HandleFunc("POST /api/v1/admin/partners/deliveries/{id}/replay", s.guard("partner.manage", s.handleReplayDelivery))
	m.HandleFunc("POST /api/v1/admin/partners/dispatch", s.guard("partner.manage", s.handleDispatchWebhooks))

	// ---- analytics ----
	m.HandleFunc("GET /api/v1/analytics/live", s.guard("report.read", s.handleLiveMetrics))
	m.HandleFunc("GET /api/v1/analytics/daily", s.guard("report.read", s.handleAnalyticsDaily))
	m.HandleFunc("GET /api/v1/analytics/channels", s.guard("report.read", s.handleAnalyticsChannels))
	m.HandleFunc("GET /api/v1/analytics/routes", s.guard("report.read", s.handleAnalyticsRoutes))
	m.HandleFunc("GET /api/v1/analytics/hours", s.guard("report.read", s.handleAnalyticsHours))
	m.HandleFunc("GET /api/v1/analytics/integrity", s.guard("report.read", s.handleAnalyticsIntegrity))

	// ---- passenger-facing promotions ----
	m.HandleFunc("POST /api/v1/promotions/preview", s.handlePreviewPromo)
	m.HandleFunc("GET /api/v1/referrals/me", s.handleMyReferral)
	m.HandleFunc("POST /api/v1/referrals/accept", s.handleAcceptReferral)
}

// ---------------------------------------------------------- event backbone --

func (s *Server) handleEventLog(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT offset_id, event_id::text, topic, event_type, producer,
		       payload, occurred_at
		  FROM events.event_log
		 WHERE ($1 = '' OR topic = $1)
		 ORDER BY offset_id DESC LIMIT $2`,
		r.URL.Query().Get("topic"), queryInt(r, "limit", 100))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the event log.")
		return
	}
	defer rows.Close()
	type ev struct {
		Offset     int64     `json:"offset"`
		EventID    string    `json:"event_id"`
		Topic      string    `json:"topic"`
		EventType  string    `json:"event_type"`
		Producer   string    `json:"producer"`
		Payload    any       `json:"payload"`
		OccurredAt time.Time `json:"occurred_at"`
	}
	out := []ev{}
	for rows.Next() {
		var e ev
		if err := rows.Scan(&e.Offset, &e.EventID, &e.Topic, &e.EventType,
			&e.Producer, &e.Payload, &e.OccurredAt); err != nil {
			continue
		}
		out = append(out, e)
	}

	var total, rejected, unrelayed int
	_ = s.pool.QueryRow(r.Context(), `
		SELECT (SELECT count(*) FROM events.event_log),
		       (SELECT count(*) FROM events.rejected_events),
		       (SELECT (SELECT count(*) FROM inventory.outbox WHERE published_at IS NULL)
		             + (SELECT count(*) FROM commerce.outbox  WHERE published_at IS NULL)
		             + (SELECT count(*) FROM ops.outbox       WHERE published_at IS NULL)
		             + (SELECT count(*) FROM agent.outbox     WHERE published_at IS NULL))`).
		Scan(&total, &rejected, &unrelayed)

	writeJSON(w, 200, map[string]any{
		"events": out, "total": total,
		"rejected_by_registry": rejected, "unrelayed_outbox": unrelayed,
	})
}

func (s *Server) handleConsumers(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	lag, err := s.wire.Lag(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not read consumer positions.")
		return
	}
	writeJSON(w, 200, map[string]any{"consumers": lag})
}

func (s *Server) handleDeadLetters(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT dl_id, consumer, event_id::text, event_type, attempts,
		       COALESCE(last_error,''), created_at, resolved_at
		  FROM events.dead_letters ORDER BY (resolved_at IS NULL) DESC, created_at DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load dead letters.")
		return
	}
	defer rows.Close()
	type dl struct {
		ID         int64      `json:"dl_id"`
		Consumer   string     `json:"consumer"`
		EventID    string     `json:"event_id"`
		EventType  string     `json:"event_type"`
		Attempts   int        `json:"attempts"`
		LastError  string     `json:"last_error"`
		CreatedAt  time.Time  `json:"created_at"`
		ResolvedAt *time.Time `json:"resolved_at"`
	}
	out := []dl{}
	for rows.Next() {
		var d dl
		if rows.Scan(&d.ID, &d.Consumer, &d.EventID, &d.EventType, &d.Attempts,
			&d.LastError, &d.CreatedAt, &d.ResolvedAt) == nil {
			out = append(out, d)
		}
	}
	writeJSON(w, 200, map[string]any{"dead_letters": out})
}

func (s *Server) handleReplayEvent(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	var req struct {
		Consumer string `json:"consumer"`
		EventID  string `json:"event_id"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.bus.Replay(r.Context(), req.Consumer, req.EventID); err != nil {
		fail(w, 400, "replay_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"replayed": true})
}

// handleDrain relays and delivers everything pending, right now. The smoke
// suites use it so they never have to sleep and hope the ticker has run.
func (s *Server) handleDrain(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	if err := s.bus.Drain(r.Context(), 500); err != nil {
		fail(w, 500, "drain_failed", err.Error())
		return
	}
	lag, _ := s.wire.Lag(r.Context())
	writeJSON(w, 200, map[string]any{"drained": true, "consumers": lag})
}

// ----------------------------------------------------------- notifications --

func (s *Server) handleNotifications(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT n.notification_id::text, n.event_type, n.template_key, n.lang, n.event_class,
		       COALESCE(n.to_phone,''), COALESCE(n.to_email,''), n.status,
		       COALESCE(n.suppress_reason,''), n.created_at,
		       COALESCE((SELECT string_agg(a.channel || ':' || a.provider || ':' || a.status, ', '
		                                   ORDER BY a.attempt_id)
		                   FROM notify.attempts a WHERE a.notification_id = n.notification_id), ''),
		       COALESCE((SELECT sum(a.cost_poisha) FROM notify.attempts a
		                  WHERE a.notification_id = n.notification_id), 0),
		       COALESCE((SELECT a.rendered FROM notify.attempts a
		                  WHERE a.notification_id = n.notification_id ORDER BY a.attempt_id LIMIT 1), '')
		  FROM notify.notifications n
		 WHERE ($1 = '' OR n.status = $1)
		 ORDER BY n.created_at DESC LIMIT $2`,
		r.URL.Query().Get("status"), queryInt(r, "limit", 100))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load notifications.")
		return
	}
	defer rows.Close()
	type n struct {
		ID        string    `json:"notification_id"`
		EventType string    `json:"event_type"`
		Template  string    `json:"template_key"`
		Lang      string    `json:"lang"`
		Class     string    `json:"event_class"`
		Phone     string    `json:"to_phone"`
		Email     string    `json:"to_email"`
		Status    string    `json:"status"`
		Suppress  string    `json:"suppress_reason"`
		CreatedAt time.Time `json:"created_at"`
		Attempts  string    `json:"attempts"`
		Cost      int64     `json:"cost_poisha"`
		Rendered  string    `json:"rendered"`
	}
	out := []n{}
	for rows.Next() {
		var v n
		if rows.Scan(&v.ID, &v.EventType, &v.Template, &v.Lang, &v.Class, &v.Phone, &v.Email,
			&v.Status, &v.Suppress, &v.CreatedAt, &v.Attempts, &v.Cost, &v.Rendered) == nil {
			out = append(out, v)
		}
	}
	writeJSON(w, 200, map[string]any{"notifications": out})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.provider, p.channel, p.priority, p.cost_poisha, p.enabled, p.simulate_failure,
		       p.failure_streak, COALESCE(p.last_error,''), p.cooldown_until,
		       COALESCE((SELECT count(*) FROM notify.attempts a
		                  WHERE a.provider = p.provider AND a.status='SENT'), 0),
		       COALESCE((SELECT count(*) FROM notify.attempts a
		                  WHERE a.provider = p.provider AND a.status='FAILED'), 0)
		  FROM notify.providers p ORDER BY p.channel, p.priority`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load providers.")
		return
	}
	defer rows.Close()
	type p struct {
		Provider string     `json:"provider"`
		Channel  string     `json:"channel"`
		Priority int        `json:"priority"`
		Cost     int64      `json:"cost_poisha"`
		Enabled  bool       `json:"enabled"`
		Failing  bool       `json:"simulate_failure"`
		Streak   int        `json:"failure_streak"`
		LastErr  string     `json:"last_error"`
		Cooldown *time.Time `json:"cooldown_until"`
		Sent     int        `json:"sent"`
		Failed   int        `json:"failed"`
	}
	out := []p{}
	for rows.Next() {
		var v p
		if rows.Scan(&v.Provider, &v.Channel, &v.Priority, &v.Cost, &v.Enabled, &v.Failing,
			&v.Streak, &v.LastErr, &v.Cooldown, &v.Sent, &v.Failed) == nil {
			out = append(out, v)
		}
	}
	writeJSON(w, 200, map[string]any{"providers": out})
}

// handleSetProvider is how an operator takes an aggregator out of service — and
// how the test suite kills the primary SMS provider to prove failover.
func (s *Server) handleSetProvider(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	provider := r.PathValue("provider")
	var req struct {
		Enabled *bool `json:"enabled"`
		Failing *bool `json:"simulate_failure"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		UPDATE notify.providers
		   SET enabled = COALESCE($2, enabled),
		       simulate_failure = COALESCE($3, simulate_failure),
		       failure_streak = 0, cooldown_until = NULL, updated_at = now()
		 WHERE provider = $1`, provider, req.Enabled, req.Failing); err != nil {
		fail(w, 500, "update_failed", "Could not change that provider.")
		return
	}
	s.stf.Audit(r.Context(), id, "notify.provider.update", provider, req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleSetBudget(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		CapPoisha int64 `json:"cap_poisha"`
		Reset     bool  `json:"reset"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO notify.budgets (period, cap_poisha) VALUES (to_char(now(),'YYYY-MM'), $1)
		ON CONFLICT (period) DO UPDATE
		   SET cap_poisha = $1,
		       spent_poisha = CASE WHEN $2 THEN 0 ELSE notify.budgets.spent_poisha END,
		       tripped_at = CASE WHEN $2 THEN NULL ELSE notify.budgets.tripped_at END`,
		req.CapPoisha, req.Reset); err != nil {
		fail(w, 500, "update_failed", "Could not change the budget.")
		return
	}
	s.stf.Audit(r.Context(), id, "notify.budget.update", "budget", req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleTestNotification sends one message through the whole real path —
// routing, template, language, provider selection, failover, cost — to an
// address somebody names. Every notification console needs this, and it is how
// an operator checks an aggregator is alive without waiting for a passenger to
// book something.
func (s *Server) handleTestNotification(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		EventType string            `json:"event_type"`
		Phone     string            `json:"phone"`
		Email     string            `json:"email"`
		Lang      string            `json:"lang"`
		Vars      map[string]string `json:"vars"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if req.EventType == "" {
		req.EventType = "auth.otp"
	}
	if req.Vars == nil {
		req.Vars = map[string]string{"code": "000000"}
	}
	key := req.Phone
	if key == "" {
		key = req.Email
	}
	err := s.ntf.SendNow(r.Context(), req.EventType, notify.Audience{
		UserKey: "test:" + key, Phone: req.Phone, Email: req.Email,
		Lang: req.Lang, Vars: req.Vars,
	})
	if err != nil {
		fail(w, 502, "send_failed", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "notify.test", req.EventType, req)

	// Hand back the attempt trail so the caller can see which provider carried
	// it and which refused, rather than just "ok".
	var attempts, status string
	_ = s.pool.QueryRow(r.Context(), `
		SELECT n.status,
		       COALESCE((SELECT string_agg(a.channel || ':' || a.provider || ':' || a.status, ', '
		                                   ORDER BY a.attempt_id)
		                   FROM notify.attempts a WHERE a.notification_id = n.notification_id), '')
		  FROM notify.notifications n
		 WHERE n.event_type = $1 AND n.dedupe_key LIKE '%' || $2
		 ORDER BY n.created_at DESC LIMIT 1`, req.EventType, "test:"+key).Scan(&status, &attempts)
	writeJSON(w, 200, map[string]any{"sent": true, "status": status, "attempts": attempts})
}

func (s *Server) handleSpend(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	var cap_, spent int64
	var tripped *time.Time
	_ = s.pool.QueryRow(r.Context(), `
		SELECT cap_poisha, spent_poisha, tripped_at FROM notify.budgets
		 WHERE period = to_char(now(),'YYYY-MM')`).Scan(&cap_, &spent, &tripped)

	rows, err := s.pool.Query(r.Context(), `
		SELECT channel, provider, count(*) FILTER (WHERE status='SENT'),
		       count(*) FILTER (WHERE status='FAILED'), COALESCE(sum(cost_poisha),0)
		  FROM notify.attempts GROUP BY channel, provider ORDER BY 5 DESC`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load notification spend.")
		return
	}
	defer rows.Close()
	type line struct {
		Channel  string `json:"channel"`
		Provider string `json:"provider"`
		Sent     int    `json:"sent"`
		Failed   int    `json:"failed"`
		Cost     int64  `json:"cost_poisha"`
	}
	lines := []line{}
	for rows.Next() {
		var l line
		if rows.Scan(&l.Channel, &l.Provider, &l.Sent, &l.Failed, &l.Cost) == nil {
			lines = append(lines, l)
		}
	}
	writeJSON(w, 200, map[string]any{
		"cap_poisha": cap_, "spent_poisha": spent, "breaker_tripped_at": tripped, "by_provider": lines,
	})
}

// -------------------------------------------------- operations control room --

func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	alerts, err := s.occ.Alerts(r.Context(),
		scopeOperator(id, r.URL.Query().Get("operator_id")),
		r.URL.Query().Get("include_cleared") == "true")
	if err != nil {
		fail(w, 500, "query_failed", "Could not load alerts.")
		return
	}
	writeJSON(w, 200, map[string]any{"alerts": alerts})
}

func (s *Server) handleScanAlerts(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	open, err := s.occ.Scan(r.Context(), s.thresholds())
	if err != nil {
		fail(w, 500, "scan_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"open_alerts": open})
}

func (s *Server) handleAckAlert(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	if err := s.occ.Acknowledge(r.Context(), r.PathValue("alertID"), id.StaffID); err != nil {
		fail(w, 500, "ack_failed", "Could not acknowledge that alert.")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleLiveBuses(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT t.trip_id::text, o.brand, rt.name, b.registration, t.status, t.depart_at,
		       p.lat::float8, p.lng::float8, COALESCE(p.speed_kph,0)::float8, p.recorded_at, p.source,
		       (SELECT count(*) FROM ops.alerts a WHERE a.trip_id=t.trip_id AND a.cleared_at IS NULL),
		       (SELECT count(*) FROM commerce.bookings bk
		         WHERE bk.trip_id=t.trip_id AND bk.status IN ('CONFIRMED','TICKETED'))
		  FROM catalog.trips t
		  JOIN catalog.operators o ON o.operator_id=t.operator_id
		  JOIN catalog.routes rt   ON rt.route_id=t.route_id
		  JOIN catalog.buses b     ON b.bus_id=t.bus_id
		  LEFT JOIN LATERAL (
		      SELECT lat, lng, speed_kph, recorded_at, source FROM ops.bus_positions
		       WHERE trip_id=t.trip_id ORDER BY recorded_at DESC LIMIT 1) p ON true
		 WHERE t.service_date BETWEEN catalog.bd_today() - 1 AND catalog.bd_today() + 1
		   AND t.status IN ('SCHEDULED','OPEN','BOARDING','DEPARTED','IN_PROGRESS')
		   AND ($1 = '' OR t.operator_id::text = $1)
		 ORDER BY t.depart_at LIMIT 200`, scopeOperator(id, r.URL.Query().Get("operator_id")))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load live buses.")
		return
	}
	defer rows.Close()
	type bus struct {
		TripID     string     `json:"trip_id"`
		Brand      string     `json:"operator"`
		Route      string     `json:"route"`
		Reg        string     `json:"bus"`
		Status     string     `json:"status"`
		DepartAt   time.Time  `json:"depart_at"`
		Lat        *float64   `json:"lat"`
		Lng        *float64   `json:"lng"`
		Speed      *float64   `json:"speed_kph"`
		LastFix    *time.Time `json:"last_fix"`
		Source     *string    `json:"source"`
		OpenAlerts int        `json:"open_alerts"`
		Passengers int        `json:"passengers"`
	}
	out := []bus{}
	for rows.Next() {
		var b bus
		if rows.Scan(&b.TripID, &b.Brand, &b.Route, &b.Reg, &b.Status, &b.DepartAt,
			&b.Lat, &b.Lng, &b.Speed, &b.LastFix, &b.Source, &b.OpenAlerts, &b.Passengers) == nil {
			out = append(out, b)
		}
	}
	writeJSON(w, 200, map[string]any{"buses": out})
}

func (s *Server) handleReplaceBus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		BusID  string `json:"bus_id"`
		Reason string `json:"reason"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	res, err := s.occ.Replace(r.Context(), r.PathValue("tripID"), req.BusID, req.Reason, id.StaffID)
	if err != nil {
		fail(w, 400, "replace_failed", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "ops.bus.replace", r.PathValue("tripID"), res)
	writeJSON(w, 200, res)
}

func (s *Server) handleConflicts(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rowsOut, err := s.occ.Conflicts(r.Context(), r.PathValue("tripID"))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load conflicts.")
		return
	}
	free, err := s.inv.FreeSeats(r.Context(), r.PathValue("tripID"), 0, 1)
	if err != nil {
		free = []string{}
	}
	writeJSON(w, 200, map[string]any{"conflicts": rowsOut, "free_seats": free})
}

func (s *Server) handleResolveConflict(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		PNR     string `json:"pnr"`
		OldSeat string `json:"old_seat"`
		NewSeat string `json:"new_seat"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.occ.ResolveConflict(r.Context(), r.PathValue("tripID"),
		req.PNR, req.OldSeat, req.NewSeat, id.StaffID); err != nil {
		fail(w, 409, "resolve_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ------------------------------------------------------------ reconciliation --

func (s *Server) handleReconRuns(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	runs, err := s.recon.Runs(r.Context(), queryInt(r, "limit", 30))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load reconciliation runs.")
		return
	}
	writeJSON(w, 200, map[string]any{"runs": runs})
}

func (s *Server) handleReconExceptions(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	ex, err := s.recon.Exceptions(r.Context(), r.URL.Query().Get("status"), r.URL.Query().Get("date"))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load exceptions.")
		return
	}
	writeJSON(w, 200, map[string]any{"exceptions": ex})
}

func (s *Server) handleReconRun(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		BusinessDate string `json:"business_date"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if req.BusinessDate == "" {
		req.BusinessDate = time.Now().Format("2006-01-02")
	}
	res, err := s.recon.Run(r.Context(), req.BusinessDate)
	if err != nil {
		fail(w, 500, "recon_failed", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "finance.recon.run", req.BusinessDate, res)
	writeJSON(w, 200, res)
}

// handleReconImport takes a gateway settlement file and a bank statement. It
// can also generate both from the platform's own payments, with or without
// injected exceptions, so the three-way match can be exercised end to end
// without waiting for a real aggregator file.
func (s *Server) handleReconImport(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Provider       string `json:"provider"`
		BusinessDate   string `json:"business_date"`
		GatewayCSV     string `json:"gateway_csv"`
		BankCSV        string `json:"bank_csv"`
		Generate       bool   `json:"generate"`
		SeedExceptions bool   `json:"seed_exceptions"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if req.Provider == "" {
		req.Provider = "BKASH"
	}
	if req.BusinessDate == "" {
		req.BusinessDate = time.Now().Format("2006-01-02")
	}
	if req.Generate {
		g, b, err := s.recon.GenerateFiles(r.Context(), req.Provider, req.BusinessDate, req.SeedExceptions)
		if err != nil {
			fail(w, 500, "generate_failed", err.Error())
			return
		}
		req.GatewayCSV, req.BankCSV = g, b
	}

	out := map[string]any{}
	if req.GatewayCSV != "" {
		res, err := s.recon.ImportGatewayFile(r.Context(), req.Provider, req.BusinessDate,
			req.Provider+"-"+req.BusinessDate+".csv", strings.NewReader(req.GatewayCSV))
		if err != nil {
			fail(w, 400, "import_failed", err.Error())
			return
		}
		out["gateway"] = res
	}
	if req.BankCSV != "" {
		n, err := s.recon.ImportBankStatement(r.Context(), "PLATFORM-COLLECTION", strings.NewReader(req.BankCSV))
		if err != nil {
			fail(w, 400, "import_failed", err.Error())
			return
		}
		out["bank_lines"] = n
	}
	s.stf.Audit(r.Context(), id, "finance.recon.import", req.BusinessDate, out)
	writeJSON(w, 200, out)
}

func (s *Server) handleResolveException(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Status     string `json:"status"`
		Resolution string `json:"resolution"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.recon.Resolve(r.Context(), r.PathValue("id"), req.Status, req.Resolution, id.StaffID); err != nil {
		fail(w, 500, "resolve_failed", "Could not update that exception.")
		return
	}
	s.stf.Audit(r.Context(), id, "finance.recon.resolve", r.PathValue("id"), req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ------------------------------------------------------------- promotions --

func (s *Server) handleCampaigns(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	offers, err := s.promo.Offers(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load campaigns.")
		return
	}
	writeJSON(w, 200, map[string]any{"campaigns": offers})
}

func (s *Server) handleCreateCampaign(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Code  string `json:"code"`
		Title string `json:"title"`
		// Optional Bangla copy. A campaign created without it still shows,
		// in whatever language it was written in.
		TitleBn        string `json:"title_bn"`
		Kind           string `json:"kind"`
		DiscountPct    int    `json:"discount_pct"`
		MaxDiscount    int64  `json:"max_discount_poisha"`
		MinAmount      int64  `json:"min_amount_poisha"`
		MaxRedemptions *int   `json:"max_redemptions"`
		PerUserLimit   int    `json:"per_user_limit"`
		Days           int    `json:"days"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if req.PerUserLimit == 0 {
		req.PerUserLimit = 1
	}
	if req.Days == 0 {
		req.Days = 30
	}
	if req.Kind == "" {
		req.Kind = "COUPON"
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO promo.campaigns
			(code, title, title_bn, kind, discount_pct, max_discount_poisha, min_amount_poisha,
			 max_redemptions, per_user_limit, ends_at)
		VALUES (upper($1), $2, NULLIF($3,''), $4, $5, $6, $7, $8, $9, now() + make_interval(days => $10))`,
		req.Code, req.Title, req.TitleBn, req.Kind, req.DiscountPct, req.MaxDiscount, req.MinAmount,
		req.MaxRedemptions, req.PerUserLimit, req.Days); err != nil {
		fail(w, 400, "create_failed", "Could not create that campaign — is the code already in use?")
		return
	}
	s.stf.Audit(r.Context(), id, "promo.campaign.create", req.Code, req)
	writeJSON(w, 201, map[string]any{"ok": true})
}

func (s *Server) handleAdminReferrals(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	refs, err := s.promo.Referrals(r.Context(), "")
	if err != nil {
		fail(w, 500, "query_failed", "Could not load referrals.")
		return
	}
	writeJSON(w, 200, map[string]any{"referrals": refs})
}

func (s *Server) handlePreviewPromo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code         string `json:"code"`
		AmountPoisha int64  `json:"amount_poisha"`
		OperatorID   string `json:"operator_id"`
		Channel      string `json:"channel"`
		Provider     string `json:"provider"`
		Phone        string `json:"phone"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	q, err := s.promo.Preview(r.Context(), req.Code, promoContext(req.Phone, req.AmountPoisha,
		req.OperatorID, "", req.Channel, req.Provider))
	if err != nil {
		fail(w, 400, "promo_rejected", err.Error())
		return
	}
	writeJSON(w, 200, q)
}

func (s *Server) handleMyReferral(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	ref, err := s.promo.Invite(r.Context(), id.Phone)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your referral code.")
		return
	}
	history, _ := s.promo.Referrals(r.Context(), id.Phone)
	writeJSON(w, 200, map[string]any{"referral": ref, "history": history})
}

func (s *Server) handleAcceptReferral(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.promo.Accept(r.Context(), req.Code, id.Phone); err != nil {
		fail(w, 400, "referral_rejected", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ------------------------------------------------------------------- risk --

func (s *Server) handleRiskRules(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rules, err := s.risk.Rules(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load risk rules.")
		return
	}
	writeJSON(w, 200, map[string]any{"rules": rules})
}

func (s *Server) handleRiskCases(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	cases, err := s.risk.Cases(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load risk cases.")
		return
	}
	writeJSON(w, 200, map[string]any{"cases": cases})
}

func (s *Server) handleRiskBlocks(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	blocks, err := s.risk.Blocks(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load blocks.")
		return
	}
	writeJSON(w, 200, map[string]any{"blocks": blocks})
}

func (s *Server) handleRiskStats(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	stats, err := s.risk.Stats(r.Context(), queryInt(r, "hours", 24))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load risk statistics.")
		return
	}
	writeJSON(w, 200, map[string]any{"stats": stats})
}

func (s *Server) handleRiskSetMode(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Mode string `json:"mode"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.risk.SetMode(r.Context(), r.PathValue("code"), req.Mode); err != nil {
		fail(w, 400, "mode_refused", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "risk.rule.mode", r.PathValue("code"), req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleRiskCloseCase(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Verdict string `json:"verdict"`
		Note    string `json:"note"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.risk.CloseCase(r.Context(), r.PathValue("id"), req.Verdict, req.Note, id.StaffID); err != nil {
		fail(w, 400, "close_failed", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "risk.case.close", r.PathValue("id"), req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleRiskLift(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Kind    string `json:"subject_kind"`
		Subject string `json:"subject"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.risk.Lift(r.Context(), req.Kind, req.Subject, id.StaffID); err != nil {
		fail(w, 500, "lift_failed", "Could not lift that block.")
		return
	}
	s.stf.Audit(r.Context(), id, "risk.block.lift", req.Subject, req)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// --------------------------------------------------------------- partners --

func (s *Server) handlePartners(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	list, err := s.prt.Partners(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load partners.")
		return
	}
	writeJSON(w, 200, map[string]any{"partners": list})
}

func (s *Server) handleDeliveries(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	list, err := s.prt.Deliveries(r.Context(), r.URL.Query().Get("partner_id"), queryInt(r, "limit", 100))
	if err != nil {
		fail(w, 500, "query_failed", "Could not load deliveries.")
		return
	}
	writeJSON(w, 200, map[string]any{"deliveries": list})
}

func (s *Server) handleCertify(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	if err := s.prt.Certify(r.Context(), r.PathValue("id")); err != nil {
		fail(w, 400, "certify_refused", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "partner.certify", r.PathValue("id"), nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleReplayDelivery(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	if err := s.prt.Replay(r.Context(), r.PathValue("id")); err != nil {
		fail(w, 400, "replay_failed", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "partner.webhook.replay", r.PathValue("id"), nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleDispatchWebhooks(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	delivered, failed, dead, err := s.prt.Dispatch(r.Context(), 200)
	if err != nil {
		fail(w, 500, "dispatch_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"delivered": delivered, "retrying": failed, "dead": dead})
}

// -------------------------------------------------------------- analytics --

func (s *Server) handleLiveMetrics(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	if err := s.stats.Refresh(r.Context()); err != nil {
		s.log.Warn("live metrics refresh", "err", err)
	}
	metrics, err := s.stats.Live(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load live metrics.")
		return
	}
	writeJSON(w, 200, map[string]any{"metrics": metrics})
}

func (s *Server) handleAnalyticsDaily(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	from, to := dateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	rowsOut, err := s.stats.Daily(r.Context(), scopeOperator(id, r.URL.Query().Get("operator_id")), from, to)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the report.")
		return
	}
	writeJSON(w, 200, map[string]any{"days": rowsOut, "from": from, "to": to})
}

func (s *Server) handleAnalyticsChannels(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	from, to := dateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	rowsOut, err := s.stats.ByChannel(r.Context(), scopeOperator(id, r.URL.Query().Get("operator_id")), from, to)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the report.")
		return
	}
	writeJSON(w, 200, map[string]any{"channels": rowsOut})
}

func (s *Server) handleAnalyticsRoutes(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	from, to := dateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	rowsOut, err := s.stats.ByRoute(r.Context(), scopeOperator(id, r.URL.Query().Get("operator_id")), from, to)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the report.")
		return
	}
	writeJSON(w, 200, map[string]any{"routes": rowsOut})
}

func (s *Server) handleAnalyticsHours(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	from, to := dateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	rowsOut, err := s.stats.ByHour(r.Context(), scopeOperator(id, r.URL.Query().Get("operator_id")), from, to)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the report.")
		return
	}
	writeJSON(w, 200, map[string]any{"hours": rowsOut})
}

// handleAnalyticsIntegrity is the check the plan asks for: the reporting store
// counting the same bookings the transactional store has. A non-zero variance
// means the projection has drifted and the dashboards are lying.
func (s *Server) handleAnalyticsIntegrity(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	day := r.URL.Query().Get("day")
	if day == "" {
		day = time.Now().Format("2006-01-02")
	}
	v, err := s.stats.CheckIntegrity(r.Context(), day)
	if err != nil {
		fail(w, 500, "query_failed", "Could not run the integrity check.")
		return
	}
	writeJSON(w, 200, v)
}

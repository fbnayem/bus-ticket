package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/staff/staff"
)

// The admin console API — the cross-operator view, the books, and the
// settlement lifecycle.
//
// The two rules that shape this file:
//   - the ledger is append-only and its trial balance is published, not
//     computed on demand by whoever asks;
//   - a settlement cannot be approved by the person who reviewed it, and
//     cannot be approved at all while a reconciliation exception is open.

func (s *Server) adminRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/admin/overview", s.guard("operator.read", s.handleAdminOverview))
	m.HandleFunc("GET /api/v1/admin/operators", s.guard("operator.read", s.handleAdminOperators))
	m.HandleFunc("POST /api/v1/admin/operators/{operatorID}/status",
		s.guard("operator.write", s.handleOperatorStatus))
	m.HandleFunc("GET /api/v1/admin/bookings", s.guard("booking.read", s.handleAdminBookings))
	m.HandleFunc("GET /api/v1/admin/payments", s.guard("payment.read", s.handleAdminPayments))
	m.HandleFunc("GET /api/v1/admin/ledger", s.guard("ledger.read", s.handleLedger))
	m.HandleFunc("GET /api/v1/admin/trial-balance", s.guard("ledger.read", s.handleTrialBalance))
	m.HandleFunc("GET /api/v1/admin/audit", s.guard("audit.read", s.handleAudit))
	m.HandleFunc("GET /api/v1/admin/health", s.guard("system.health", s.handleSystemHealth))
	m.HandleFunc("GET /api/v1/admin/agents", s.guard("agent.read", s.handleAdminAgents))
	m.HandleFunc("GET /api/v1/admin/staff", s.guard("staff.read", s.handleAdminStaff))
	m.HandleFunc("GET /api/v1/admin/settlements", s.guard("settlement.read", s.handleAdminSettlements))
	m.HandleFunc("POST /api/v1/admin/settlements/calculate",
		s.guard("settlement.calculate", s.handleCalculateSettlement))
	m.HandleFunc("POST /api/v1/admin/settlements/{settlementID}/review",
		s.guard("settlement.calculate", s.handleReviewSettlement))
	m.HandleFunc("POST /api/v1/admin/settlements/{settlementID}/approve",
		s.guard("settlement.approve", s.handleApproveSettlement))
	m.HandleFunc("POST /api/v1/admin/settlements/{settlementID}/pay",
		s.guard("settlement.approve", s.handlePaySettlement))
	m.HandleFunc("GET /api/v1/admin/settlements/{settlementID}", s.guard("settlement.read", s.handleSettlementDetail))
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	ctx := r.Context()
	out := map[string]any{}

	var operators, trips, bookings, tickets, staffCount, agencies int
	var gmv, refunds int64
	_ = s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM catalog.operators WHERE status='ACTIVE'),
		       (SELECT count(*) FROM catalog.trips WHERE service_date >= catalog.bd_today()),
		       (SELECT count(*) FROM commerce.bookings),
		       (SELECT count(*) FROM commerce.tickets),
		       (SELECT count(*) FROM staff.staff_users WHERE status='ACTIVE'),
		       (SELECT count(*) FROM agent.agencies WHERE status='ACTIVE'),
		       (SELECT COALESCE(sum(total_poisha),0) FROM commerce.bookings
		         WHERE status IN ('TICKETED','CONFIRMED','COMPLETED')),
		       (SELECT COALESCE(sum(amount_poisha),0) FROM commerce.refunds WHERE status='SUCCESS')`).
		Scan(&operators, &trips, &bookings, &tickets, &staffCount, &agencies, &gmv, &refunds)

	out["operators"], out["upcoming_trips"] = operators, trips
	out["bookings"], out["tickets"] = bookings, tickets
	out["staff"], out["agencies"] = staffCount, agencies
	out["gmv_poisha"], out["refunds_poisha"] = gmv, refunds

	var variance float64
	_ = s.pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance)
	out["trial_balance_variance_poisha"] = variance

	rows, err := s.pool.Query(ctx, `
		SELECT channel, count(*), COALESCE(sum(total_poisha),0)
		  FROM commerce.bookings
		 WHERE status IN ('TICKETED','CONFIRMED','COMPLETED')
		 GROUP BY channel ORDER BY 3 DESC`)
	channels := []map[string]any{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var ch string
			var n int
			var amt int64
			if rows.Scan(&ch, &n, &amt) == nil {
				channels = append(channels, map[string]any{
					"channel": ch, "bookings": n, "revenue_poisha": amt})
			}
		}
	}
	out["by_channel"] = channels
	writeJSON(w, 200, out)
}

func (s *Server) handleAdminOperators(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT o.operator_id::text, o.brand, o.legal_name, o.status, o.created_at,
		       (SELECT count(*) FROM catalog.buses b WHERE b.operator_id=o.operator_id),
		       (SELECT count(*) FROM catalog.routes rt WHERE rt.operator_id=o.operator_id),
		       (SELECT count(*) FROM counter.counters c WHERE c.operator_id=o.operator_id),
		       (SELECT COALESCE(sum(bk.total_poisha),0) FROM commerce.bookings bk
		         WHERE bk.operator_id=o.operator_id
		           AND bk.status IN ('TICKETED','CONFIRMED','COMPLETED'))
		  FROM catalog.operators o ORDER BY o.brand`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load operators.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var oid, brand, legal, status string
		var created time.Time
		var buses, routes, counters int
		var gmv int64
		if rows.Scan(&oid, &brand, &legal, &status, &created, &buses, &routes, &counters, &gmv) != nil {
			continue
		}
		out = append(out, map[string]any{
			"operator_id": oid, "brand": brand, "legal_name": legal, "status": status,
			"created_at": created, "buses": buses, "routes": routes,
			"counters": counters, "gmv_poisha": gmv,
		})
	}
	writeJSON(w, 200, map[string]any{"operators": out})
}

type statusRequest struct {
	Status string `json:"status"`
}

func (s *Server) handleOperatorStatus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	operatorID := r.PathValue("operatorID")
	var req statusRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	switch req.Status {
	case "PENDING", "ACTIVE", "SUSPENDED", "BLOCKED", "TERMINATED":
	default:
		fail(w, 400, "bad_status", "That is not an operator status.")
		return
	}
	var before string
	_ = s.pool.QueryRow(r.Context(),
		`SELECT status FROM catalog.operators WHERE operator_id=$1::uuid`, operatorID).Scan(&before)
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE catalog.operators SET status=$2 WHERE operator_id=$1::uuid`, operatorID, req.Status); err != nil {
		fail(w, 500, "update_failed", "The status could not be changed.")
		return
	}
	s.stf.Audit(r.Context(), id, "operator.status", "operator:"+operatorID, before+" → "+req.Status)
	writeJSON(w, 200, map[string]any{"operator_id": operatorID, "from": before, "status": req.Status})
}

func (s *Server) handleAdminBookings(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.channel, b.total_poisha, b.created_at,
		       o.brand, COALESCE(bc.phone,''), t.depart_at
		  FROM commerce.bookings b
		  JOIN catalog.operators o ON o.operator_id=b.operator_id
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  LEFT JOIN commerce.booking_contacts bc ON bc.booking_id=b.booking_id
		 ORDER BY b.created_at DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load bookings.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, channel, brand, phone string
		var total int64
		var created, depart time.Time
		if rows.Scan(&pnr, &status, &channel, &total, &created, &brand, &phone, &depart) != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "channel": channel, "total_poisha": total,
			"created_at": created, "operator": brand, "phone": phone, "depart_at": depart,
		})
	}
	writeJSON(w, 200, map[string]any{"bookings": out})
}

func (s *Server) handleAdminPayments(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.provider, p.provider_txn_id, p.amount_poisha, p.currency, p.status,
		       p.created_at, b.pnr
		  FROM commerce.payments p
		  JOIN commerce.bookings b ON b.booking_id = p.booking_id
		 ORDER BY p.created_at DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load payments.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var provider, txn, currency, status, pnr string
		var amount int64
		var at time.Time
		if rows.Scan(&provider, &txn, &amount, &currency, &status, &at, &pnr) != nil {
			continue
		}
		out = append(out, map[string]any{
			"provider": provider, "provider_txn_id": txn, "amount_poisha": amount,
			"currency": currency, "status": status, "created_at": at, "pnr": pnr,
		})
	}

	// Webhook deliveries, including the rejected ones — the rejections are the
	// interesting rows, because they are the defence working.
	wrows, _ := s.pool.Query(r.Context(), `
		SELECT provider, provider_txn_id, signature_ok, accepted,
		       COALESCE(reject_reason,''), received_at
		  FROM commerce.payment_webhooks ORDER BY received_at DESC LIMIT 40`)
	hooks := []map[string]any{}
	if wrows != nil {
		defer wrows.Close()
		for wrows.Next() {
			var provider, txn, reason string
			var sigOK, accepted bool
			var at time.Time
			if wrows.Scan(&provider, &txn, &sigOK, &accepted, &reason, &at) == nil {
				hooks = append(hooks, map[string]any{
					"provider": provider, "provider_txn_id": txn, "signature_ok": sigOK,
					"accepted": accepted, "reject_reason": reason, "received_at": at,
				})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"payments": out, "webhooks": hooks})
}

func (s *Server) handleLedger(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	ctx := r.Context()

	// Balance per account, straight from the entries. Nothing is cached.
	arows, err := s.pool.Query(ctx, `
		SELECT a.account_code, a.name, a.normal_side,
		       COALESCE(sum(e.amount_poisha) FILTER (WHERE e.side='DR'),0),
		       COALESCE(sum(e.amount_poisha) FILTER (WHERE e.side='CR'),0)
		  FROM finance.ledger_accounts a
		  LEFT JOIN finance.ledger_entries e ON e.account_code = a.account_code
		 GROUP BY a.account_code, a.name, a.normal_side ORDER BY a.account_code`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the ledger.")
		return
	}
	defer arows.Close()
	accounts := []map[string]any{}
	for arows.Next() {
		var code, name, normal string
		var dr, cr int64
		if arows.Scan(&code, &name, &normal, &dr, &cr) != nil {
			continue
		}
		balance := dr - cr
		if normal == "CR" {
			balance = cr - dr
		}
		accounts = append(accounts, map[string]any{
			"account_code": code, "name": name, "normal_side": normal,
			"debit_poisha": dr, "credit_poisha": cr, "balance_poisha": balance,
		})
	}

	jrows, _ := s.pool.Query(ctx, `
		SELECT j.journal_id::text, j.description, j.occurred_at,
		       COALESCE(sum(e.amount_poisha) FILTER (WHERE e.side='DR'),0),
		       COALESCE(string_agg(e.account_code || ' ' || e.side || ' ' ||
		                (e.amount_poisha/100)::text, ' · ' ORDER BY e.side DESC, e.account_code), '')
		  FROM finance.journal_entries j
		  LEFT JOIN finance.ledger_entries e ON e.journal_id = j.journal_id
		 GROUP BY j.journal_id, j.description, j.occurred_at
		 ORDER BY j.occurred_at DESC LIMIT 40`)
	journals := []map[string]any{}
	if jrows != nil {
		defer jrows.Close()
		for jrows.Next() {
			var jid, desc, lines string
			var at time.Time
			var total int64
			if jrows.Scan(&jid, &desc, &at, &total, &lines) == nil {
				journals = append(journals, map[string]any{
					"journal_id": jid, "description": desc, "occurred_at": at,
					"total_poisha": total, "lines": lines,
				})
			}
		}
	}

	var variance float64
	_ = s.pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance)
	writeJSON(w, 200, map[string]any{
		"accounts": accounts, "journals": journals, "variance_poisha": variance,
	})
}

func (s *Server) handleTrialBalance(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	var variance float64
	if err := s.pool.QueryRow(r.Context(),
		`SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance); err != nil {
		fail(w, 500, "query_failed", "The trial balance could not be computed.")
		return
	}
	var dr, cr int64
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(sum(amount_poisha) FILTER (WHERE side='DR'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE side='CR'),0)
		  FROM finance.ledger_entries`).Scan(&dr, &cr)
	writeJSON(w, 200, map[string]any{
		"total_debit_poisha": dr, "total_credit_poisha": cr,
		"variance_poisha": variance, "balanced": variance == 0,
	})
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	// action narrows to one kind of event.
	//
	// The default view is the hundred most recent, which is the right thing to
	// land on and the wrong way to answer "was this ever recorded". A busy hour
	// of settlements pushes every sign-in off the end, and a caller looking for
	// one is told it never happened. The cap is a screenful, not an answer.
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	rows, err := s.pool.Query(r.Context(), `
		SELECT a.audit_id, COALESCE(u.full_name,'system'), COALESCE(a.actor_role,''),
		       a.action, COALESCE(a.resource,''), a.occurred_at,
		       COALESCE(a.after_val #>> '{}', '')
		  FROM audit.audit_log a
		  LEFT JOIN staff.staff_users u ON u.staff_id = a.actor_id
		 WHERE $1 = '' OR a.action = $1
		 ORDER BY a.audit_id DESC LIMIT 100`, action)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the audit log.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var auditID int64
		var actor, role, action, resource, after string
		var at time.Time
		if rows.Scan(&auditID, &actor, &role, &action, &resource, &at, &after) != nil {
			continue
		}
		out = append(out, map[string]any{
			"audit_id": auditID, "actor": actor, "role": role, "action": action,
			"resource": resource, "occurred_at": at, "detail": after,
		})
	}
	writeJSON(w, 200, map[string]any{"entries": out, "append_only": true})
}

func (s *Server) handleSystemHealth(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	ctx := r.Context()
	out := map[string]any{}

	dbUp := s.pool.Ping(ctx) == nil
	out["database"] = map[string]any{"up": dbUp}

	var held, expired, confirmed int
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status='HELD'),
		       count(*) FILTER (WHERE status='EXPIRED'),
		       count(*) FILTER (WHERE status='CONFIRMED')
		  FROM inventory.seat_holds`).Scan(&held, &expired, &confirmed)
	out["holds"] = map[string]any{"held": held, "expired": expired, "confirmed": confirmed}

	// The sweeper's health in one number: holds past their deadline that are
	// still HELD. Anything above a handful means the sweeper has stopped.
	var overdue int
	_ = s.pool.QueryRow(ctx,
		`SELECT count(*) FROM inventory.seat_holds WHERE status='HELD' AND expires_at < now()`).Scan(&overdue)
	out["overdue_holds"] = overdue

	// The event backbone. A rising unpublished count means the relay has
	// stopped; a rising rejected count means a producer changed shape and the
	// schema registry caught it before any consumer did.
	var unpublished, published, rejected, deadLetters, maxLag int
	_ = s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM inventory.outbox WHERE published_at IS NULL)
		     + (SELECT count(*) FROM commerce.outbox  WHERE published_at IS NULL)
		     + (SELECT count(*) FROM ops.outbox       WHERE published_at IS NULL)
		     + (SELECT count(*) FROM agent.outbox     WHERE published_at IS NULL),
		       (SELECT count(*) FROM events.event_log),
		       (SELECT count(*) FROM events.rejected_events),
		       (SELECT count(*) FROM events.dead_letters WHERE resolved_at IS NULL),
		       COALESCE((SELECT max(GREATEST(
		            COALESCE((SELECT max(offset_id) FROM events.event_log e
		                       WHERE e.topic = ANY(c.topics)), 0) - c.position, 0))
		          FROM events.consumers c), 0)`).
		Scan(&unpublished, &published, &rejected, &deadLetters, &maxLag)
	out["events"] = map[string]any{
		"unrelayed_outbox":     unpublished,
		"published":            published,
		"rejected_by_registry": rejected,
		"dead_letters":         deadLetters,
		"max_consumer_lag":     maxLag,
	}

	// Notification delivery and what it costs, because a booking nobody was
	// told about is not a booking a passenger can use.
	var sent, failedNotif, suppressed int
	var spent, cap_ int64
	_ = s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM notify.notifications WHERE status='SENT'),
		       (SELECT count(*) FROM notify.notifications WHERE status='FAILED'),
		       (SELECT count(*) FROM notify.notifications WHERE status='SUPPRESSED'),
		       COALESCE((SELECT spent_poisha FROM notify.budgets
		                  WHERE period = to_char(now(),'YYYY-MM')), 0),
		       COALESCE((SELECT cap_poisha FROM notify.budgets
		                  WHERE period = to_char(now(),'YYYY-MM')), 0)`).
		Scan(&sent, &failedNotif, &suppressed, &spent, &cap_)
	out["notifications"] = map[string]any{
		"sent": sent, "failed": failedNotif, "suppressed": suppressed,
		"spent_poisha": spent, "cap_poisha": cap_,
	}

	// Search reads a projection, so how stale that projection is belongs here.
	var indexLag int
	var legs int64
	_ = s.pool.QueryRow(ctx, `
		SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(indexed_at)))::int, 0), count(*)
		  FROM search.trip_legs`).Scan(&indexLag, &legs)
	out["search_index"] = map[string]any{"legs": legs, "seconds_behind": indexLag}

	var variance float64
	_ = s.pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance)
	out["ledger"] = map[string]any{"variance_poisha": variance, "balanced": variance == 0}

	var walletDrift int
	_ = s.pool.QueryRow(ctx, `
		SELECT count(*) FROM agent.wallets w
		 WHERE w.available_poisha <>
		       (SELECT COALESCE(sum(delta_poisha),0) FROM agent.wallet_transactions t
		         WHERE t.wallet_id = w.wallet_id)`).Scan(&walletDrift)
	out["wallets"] = map[string]any{"cache_drift": walletDrift}

	writeJSON(w, 200, out)
}

func (s *Server) handleAdminAgents(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT a.agency_id::text, a.name, COALESCE(p.name,''), a.kyc_status, a.status,
		       COALESCE(w.available_poisha,0), COALESCE(w.held_poisha,0),
		       COALESCE(w.credit_limit_poisha,0),
		       (SELECT count(*) FROM commerce.bookings b WHERE b.agency_id=a.agency_id),
		       (SELECT COALESCE(sum(c.amount_poisha),0) FROM agent.commissions c
		         WHERE c.agency_id=a.agency_id)
		  FROM agent.agencies a
		  LEFT JOIN agent.agencies p ON p.agency_id = a.parent_id
		  LEFT JOIN agent.wallets w ON w.agency_id = a.agency_id
		 ORDER BY a.name`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load agencies.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, name, parent, kyc, status string
		var available, held, credit, commission int64
		var bookings int
		if rows.Scan(&aid, &name, &parent, &kyc, &status, &available, &held,
			&credit, &bookings, &commission) != nil {
			continue
		}
		out = append(out, map[string]any{
			"agency_id": aid, "name": name, "parent": parent, "kyc_status": kyc,
			"status": status, "available_poisha": available, "held_poisha": held,
			"credit_limit_poisha": credit, "spendable_poisha": available + credit - held,
			"bookings": bookings, "commission_poisha": commission,
		})
	}
	writeJSON(w, 200, map[string]any{"agencies": out})
}

func (s *Server) handleAdminStaff(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT u.staff_id::text, u.full_name, u.email, u.status,
		       COALESCE(string_agg(DISTINCT r.role_key, ', '), ''),
		       COALESCE(o.brand,''), COALESCE(c.name,''), COALESCE(ag.name,''),
		       u.last_login_at,
		       (SELECT count(*) FROM catalog.role_permissions rp
		         WHERE rp.role_id IN (SELECT role_id FROM staff.user_roles WHERE staff_id=u.staff_id))
		  FROM staff.staff_users u
		  LEFT JOIN staff.user_roles ur ON ur.staff_id=u.staff_id
		  LEFT JOIN catalog.roles r ON r.role_id=ur.role_id
		  LEFT JOIN catalog.operators o ON o.operator_id=u.operator_id
		  LEFT JOIN counter.counters c ON c.counter_id=u.counter_id
		  LEFT JOIN agent.agencies ag ON ag.agency_id=u.agency_id
		 GROUP BY u.staff_id, o.brand, c.name, ag.name ORDER BY u.full_name`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load staff.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, name, email, status, roles, brand, counterName, agency string
		var last *time.Time
		var perms int
		if rows.Scan(&sid, &name, &email, &status, &roles, &brand,
			&counterName, &agency, &last, &perms) != nil {
			continue
		}
		out = append(out, map[string]any{
			"staff_id": sid, "full_name": name, "email": email, "status": status,
			"roles": roles, "operator": brand, "counter": counterName, "agency": agency,
			"last_login_at": last, "permission_count": perms,
		})
	}

	rrows, _ := s.pool.Query(r.Context(), `
		SELECT r.role_key, r.family, count(rp.permission)
		  FROM catalog.roles r
		  LEFT JOIN catalog.role_permissions rp ON rp.role_id = r.role_id
		 GROUP BY r.role_key, r.family ORDER BY r.family, r.role_key`)
	roles := []map[string]any{}
	if rrows != nil {
		defer rrows.Close()
		for rrows.Next() {
			var key, family string
			var n int
			if rrows.Scan(&key, &family, &n) == nil {
				roles = append(roles, map[string]any{"role_key": key, "family": family, "permissions": n})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"staff": out, "roles": roles})
}

// ------------------------------------------------------------- settlement --

func (s *Server) listSettlements(r *http.Request, operatorID string) []map[string]any {
	rows, err := s.pool.Query(r.Context(), `
		SELECT st.settlement_id::text, o.brand, st.operator_id::text,
		       st.period_start, st.period_end, st.status,
		       st.gross_poisha, st.commission_poisha, st.refund_poisha,
		       st.cash_collected_poisha, st.net_payable_poisha, st.booking_count,
		       COALESCE(rv.full_name,''), COALESCE(ap.full_name,''), st.paid_at,
		       COALESCE(st.reviewed_by::text,''), COALESCE(st.approved_by::text,'')
		  FROM finance.settlements st
		  JOIN catalog.operators o ON o.operator_id = st.operator_id
		  LEFT JOIN staff.staff_users rv ON rv.staff_id = st.reviewed_by
		  LEFT JOIN staff.staff_users ap ON ap.staff_id = st.approved_by
		 WHERE ($1='' OR st.operator_id = $1::uuid)
		 -- Most recently worked on first, then by period.
		 --
		 -- This used to order by period_end alone, which quietly broke the
		 -- screen once a database had accumulated a few hundred settlements:
		 -- pressing Calculate on an older period reported success and then
		 -- showed nothing, because the row it had just written sorted below a
		 -- LIMIT of newer periods. A worklist has to show the thing you just
		 -- did to it.
		 ORDER BY st.calculated_at DESC NULLS LAST, st.period_end DESC, o.brand
		 LIMIT 100`, operatorID)
	out := []map[string]any{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var sid, brand, oid, status, reviewer, approver, reviewerID, approverID string
		var start, end time.Time
		var paid *time.Time
		var gross, commission, refund, cash, net int64
		var n int
		if rows.Scan(&sid, &brand, &oid, &start, &end, &status, &gross, &commission,
			&refund, &cash, &net, &n, &reviewer, &approver, &paid, &reviewerID, &approverID) != nil {
			continue
		}
		out = append(out, map[string]any{
			"settlement_id": sid, "operator": brand, "operator_id": oid,
			"period_start": start.Format("2006-01-02"), "period_end": end.Format("2006-01-02"),
			"status": status, "gross_poisha": gross, "commission_poisha": commission,
			"refund_poisha": refund, "net_payable_poisha": net, "booking_count": n,
			// What the operator's own counters and conductors already took in
			// cash. Deducted from the payable, and shown rather than folded in:
			// a net that is smaller than gross minus commission needs to say why
			// on the same screen, or it looks like an error.
			"cash_collected_poisha": cash,
			"reviewed_by":           reviewer, "approved_by": approver, "paid_at": paid,
			// Ids as well as names, so the console can hide an approve button
			// the server would refuse rather than offering it and failing.
			"reviewed_by_id": reviewerID, "approved_by_id": approverID,
		})
	}
	return out
}

func (s *Server) handleAdminSettlements(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	writeJSON(w, 200, map[string]any{"settlements": s.listSettlements(r, op)})
}

type calcSettlementRequest struct {
	OperatorID string `json:"operator_id"`
	From       string `json:"from"`
	To         string `json:"to"`
}

func (s *Server) handleCalculateSettlement(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req calcSettlementRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.From, req.To = dateRange(req.From, req.To)
	op := scopeOperator(id, req.OperatorID)
	if op == "" {
		fail(w, 400, "operator_required", "Choose an operator.")
		return
	}
	sid, err := s.com.CalculateSettlement(r.Context(), op, req.From, req.To)
	if err != nil {
		s.log.Error("calculate settlement", "err", err)
		fail(w, 500, "calculate_failed", "The settlement could not be calculated.")
		return
	}
	s.stf.Audit(r.Context(), id, "settlement.calculate", "settlement:"+sid, nil)
	writeJSON(w, 200, map[string]any{"settlement_id": sid})
}

func (s *Server) handleReviewSettlement(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	sid := r.PathValue("settlementID")
	if err := s.com.ReviewSettlement(r.Context(), sid, id.StaffID); err != nil {
		fail(w, 409, "review_refused", "Only a calculated settlement can be marked reviewed.")
		return
	}
	s.stf.Audit(r.Context(), id, "settlement.review", "settlement:"+sid, nil)
	writeJSON(w, 200, map[string]any{"settlement_id": sid, "status": "REVIEWED"})
}

func (s *Server) handleApproveSettlement(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	sid := r.PathValue("settlementID")
	err := s.com.ApproveSettlement(r.Context(), sid, id.StaffID)
	switch {
	case errors.Is(err, commerce.ErrOpenException):
		fail(w, 409, "open_exceptions",
			"There are unresolved reconciliation exceptions in this period. Clear them first — "+
				"a settlement cannot be approved over a discrepancy.")
		return
	case errors.Is(err, commerce.ErrNotReviewed):
		fail(w, 409, "not_reviewed", "This settlement has to be reviewed before it can be approved.")
		return
	case errors.Is(err, commerce.ErrSelfApproval):
		fail(w, 409, "self_approval",
			"A settlement must be approved by someone other than the person who reviewed it.")
		return
	case err != nil:
		fail(w, 500, "approve_failed", "The settlement could not be approved.")
		return
	}
	s.stf.Audit(r.Context(), id, "settlement.approve", "settlement:"+sid, nil)
	writeJSON(w, 200, map[string]any{"settlement_id": sid, "status": "APPROVED"})
}

type payRequest struct {
	Reference string `json:"reference"`
}

func (s *Server) handlePaySettlement(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	sid := r.PathValue("settlementID")
	var req payRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if err := s.com.MarkSettlementPaid(r.Context(), sid, req.Reference); err != nil {
		fail(w, 409, "pay_refused", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "settlement.pay", "settlement:"+sid, req.Reference)
	writeJSON(w, 200, map[string]any{"settlement_id": sid, "status": "PAID"})
}

func (s *Server) handleSettlementDetail(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	sid := r.PathValue("settlementID")
	ctx := r.Context()

	// An operator may read only their OWN settlement statement; platform staff
	// (no operator scope) may read any. Without this an operator accountant, who
	// holds settlement.read, could pull a competitor's per-booking revenue book
	// by settlement id — the same IDOR class the manifest read had.
	var settleOp string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM finance.settlements WHERE settlement_id=$1::uuid`, sid).
		Scan(&settleOp); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 404, "not_found", "No settlement with that reference.")
			return
		}
		fail(w, 500, "query_failed", "Could not load the statement.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != settleOp {
		fail(w, 404, "not_found", "No settlement with that reference.")
		return
	}

	exceptions, _ := s.com.SettlementExceptions(ctx, sid)

	rows, err := s.pool.Query(ctx, `
		SELECT b.pnr, b.channel, b.status, i.gross_poisha, i.commission_poisha,
		       i.refund_poisha, i.cash_collected_poisha, i.net_poisha, b.created_at
		  FROM finance.settlement_items i
		  JOIN commerce.bookings b ON b.booking_id = i.booking_id
		 WHERE i.settlement_id = $1::uuid
		 ORDER BY b.created_at DESC LIMIT 200`, sid)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the statement.")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var pnr, channel, status string
		var gross, commission, refund, cash, net int64
		var at time.Time
		if rows.Scan(&pnr, &channel, &status, &gross, &commission, &refund, &cash, &net, &at) != nil {
			continue
		}
		items = append(items, map[string]any{
			"pnr": pnr, "channel": channel, "status": status,
			"gross_poisha": gross, "commission_poisha": commission,
			"refund_poisha": refund, "cash_collected_poisha": cash,
			"net_poisha": net, "created_at": at,
		})
	}
	writeJSON(w, 200, map[string]any{
		"settlement_id": sid, "items": items, "open_exceptions": exceptions,
	})
}

package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/busticket/platform/services/staff/staff"
)

// The support console API.
//
// One search box that accepts a PNR, a phone number, an email or a ticket
// number, and one timeline per booking assembled from the tables that
// actually recorded what happened — booking history, payments, webhook
// deliveries, inventory events, tickets, boarding scans, cancellations and
// refunds. Support should never need an engineer to answer "where is my
// refund?", and they should never be shown a story the database cannot
// support.

func (s *Server) helpdeskRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/helpdesk/search", s.guard("support.read", s.handleHelpdeskSearch))
	m.HandleFunc("GET /api/v1/helpdesk/timeline/{pnr}", s.guard("support.read", s.handleTimeline))
	m.HandleFunc("GET /api/v1/helpdesk/cases", s.guard("support.read", s.handleListCases))
	m.HandleFunc("POST /api/v1/helpdesk/cases", s.guard("support.write", s.handleCreateCase))
	m.HandleFunc("POST /api/v1/helpdesk/cases/{caseID}/notes", s.guard("support.write", s.handleAddNote))
	m.HandleFunc("POST /api/v1/helpdesk/cases/{caseID}/status", s.guard("support.write", s.handleCaseStatus))
}

func (s *Server) handleHelpdeskSearch(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	q := r.URL.Query().Get("q")
	if len(q) < 3 {
		fail(w, 400, "query_too_short", "Type at least three characters — a PNR, phone number or email.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.channel, b.total_poisha, b.created_at,
		       o.brand, t.depart_at, COALESCE(bc.phone,''), COALESCE(bc.email,''),
		       COALESCE((SELECT full_name FROM commerce.booking_passengers p
		                  WHERE p.booking_id=b.booking_id LIMIT 1),''),
		       (SELECT string_agg(seat_no, ',' ORDER BY seat_no)
		          FROM commerce.booking_seats bs WHERE bs.booking_id=b.booking_id)
		  FROM commerce.bookings b
		  JOIN catalog.operators o ON o.operator_id=b.operator_id
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  LEFT JOIN commerce.booking_contacts bc ON bc.booking_id=b.booking_id
		 WHERE b.pnr = upper($1)
		    OR bc.phone LIKE '%' || $1 || '%'
		    OR lower(bc.email) LIKE '%' || lower($1) || '%'
		    OR EXISTS (SELECT 1 FROM commerce.booking_passengers p
		                WHERE p.booking_id=b.booking_id AND lower(p.full_name) LIKE '%' || lower($1) || '%')
		    OR EXISTS (SELECT 1 FROM commerce.payments p
		                WHERE p.booking_id=b.booking_id AND p.provider_txn_id = $1)
		 ORDER BY b.created_at DESC LIMIT 25`, q)
	if err != nil {
		fail(w, 500, "query_failed", "The search could not be run.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, channel, brand, phone, email, passenger string
		var seats *string
		var total int64
		var created, depart time.Time
		if rows.Scan(&pnr, &status, &channel, &total, &created, &brand, &depart,
			&phone, &email, &passenger, &seats) != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "channel": channel, "total_poisha": total,
			"created_at": created, "operator": brand, "depart_at": depart,
			"phone": phone, "email": email, "passenger": passenger, "seats": deref(seats),
		})
	}
	writeJSON(w, 200, map[string]any{"query": q, "results": out})
}

type timelineEvent struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"`
	Title  string    `json:"title"`
	Detail string    `json:"detail,omitempty"`
	Source string    `json:"source"`
}

// handleTimeline assembles the whole life of a booking from the records that
// made it. Every entry names the table it came from, so an agent reading it
// can tell a passenger something they can stand behind.
func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	pnr := r.PathValue("pnr")
	ctx := r.Context()

	var bookingID, status, channel, brand, holdID string
	var total int64
	var created, depart time.Time
	var phone, email *string
	if err := s.pool.QueryRow(ctx, `
		SELECT b.booking_id::text, b.status, b.channel, b.total_poisha, b.created_at,
		       o.brand, t.depart_at, bc.phone, bc.email, b.hold_id::text
		  FROM commerce.bookings b
		  JOIN catalog.operators o ON o.operator_id=b.operator_id
		  JOIN catalog.trips t ON t.trip_id=b.trip_id
		  LEFT JOIN commerce.booking_contacts bc ON bc.booking_id=b.booking_id
		 WHERE b.pnr = upper($1)`, pnr).
		Scan(&bookingID, &status, &channel, &total, &created, &brand, &depart, &phone, &email, &holdID); err != nil {
		fail(w, 404, "not_found", "No booking with that reference.")
		return
	}

	events := []timelineEvent{}
	add := func(at time.Time, kind, title, detail, source string) {
		events = append(events, timelineEvent{At: at, Kind: kind, Title: title, Detail: detail, Source: source})
	}

	// Seat holds and releases, from the append-only inventory event log.
	if irows, err := s.pool.Query(ctx, `
		SELECT event_type, seat_no, occurred_at FROM inventory.inventory_events
		 WHERE hold_id = $1::uuid ORDER BY occurred_at`, holdID); err == nil {
		seatsBy := map[string][]string{}
		firstAt := map[string]time.Time{}
		for irows.Next() {
			var et, seat string
			var at time.Time
			if irows.Scan(&et, &seat, &at) == nil {
				seatsBy[et] = append(seatsBy[et], seat)
				if _, ok := firstAt[et]; !ok {
					firstAt[et] = at
				}
			}
		}
		irows.Close()
		labels := map[string]string{
			"SEAT_HELD": "Seats held", "SEAT_BOOKED": "Seats confirmed",
			"SEAT_RELEASED": "Seats released", "HOLD_EXPIRED": "Hold expired",
		}
		for et, seats := range seatsBy {
			label := labels[et]
			if label == "" {
				label = et
			}
			add(firstAt[et], "inventory", label, fmt.Sprintf("%v", seats), "inventory.inventory_events")
		}
	}

	if hrows, err := s.pool.Query(ctx, `
		SELECT COALESCE(from_status,'—'), to_status, COALESCE(reason,''), occurred_at
		  FROM commerce.booking_status_history WHERE booking_id=$1::uuid ORDER BY occurred_at`,
		bookingID); err == nil {
		for hrows.Next() {
			var from, to, reason string
			var at time.Time
			if hrows.Scan(&from, &to, &reason, &at) == nil {
				add(at, "booking", from+" → "+to, reason, "commerce.booking_status_history")
			}
		}
		hrows.Close()
	}

	if prows, err := s.pool.Query(ctx, `
		SELECT provider, provider_txn_id, amount_poisha, status, created_at
		  FROM commerce.payments WHERE booking_id=$1::uuid ORDER BY created_at`, bookingID); err == nil {
		for prows.Next() {
			var provider, txn, pstatus string
			var amount int64
			var at time.Time
			if prows.Scan(&provider, &txn, &amount, &pstatus, &at) == nil {
				add(at, "payment", "Payment "+pstatus+" via "+provider,
					fmt.Sprintf("৳%d · txn %s", amount/100, txn), "commerce.payments")
			}
		}
		prows.Close()
	}

	// Webhook deliveries, including the rejected ones. When a passenger says
	// "I paid", this row is the answer either way.
	if wrows, err := s.pool.Query(ctx, `
		SELECT provider, signature_ok, accepted, COALESCE(reject_reason,''), received_at
		  FROM commerce.payment_webhooks
		 WHERE raw->>'booking_id' = $1 ORDER BY received_at`, bookingID); err == nil {
		for wrows.Next() {
			var provider, reason string
			var sigOK, accepted bool
			var at time.Time
			if wrows.Scan(&provider, &sigOK, &accepted, &reason, &at) == nil {
				title := "Provider notification accepted"
				if !accepted {
					title = "Provider notification rejected"
				}
				detail := provider
				if reason != "" {
					detail += " · " + reason
				}
				add(at, "webhook", title, detail, "commerce.payment_webhooks")
			}
		}
		wrows.Close()
	}

	if trows, err := s.pool.Query(ctx, `
		SELECT seat_no, status, issued_at, boarded_at FROM commerce.tickets
		 WHERE booking_id=$1::uuid ORDER BY seat_no`, bookingID); err == nil {
		for trows.Next() {
			var seat, tstatus string
			var issued time.Time
			var boarded *time.Time
			if trows.Scan(&seat, &tstatus, &issued, &boarded) == nil {
				add(issued, "ticket", "Ticket issued — seat "+seat, "", "commerce.tickets")
				if boarded != nil {
					add(*boarded, "boarding", "Boarded — seat "+seat, "", "commerce.tickets")
				}
			}
		}
		trows.Close()
	}

	if srows, err := s.pool.Query(ctx, `
		SELECT COALESCE(seat_no,''), result, scanned_at, COALESCE(u.full_name,'')
		  FROM ops.boarding_scans sc LEFT JOIN staff.staff_users u ON u.staff_id=sc.scanned_by
		 WHERE sc.pnr = upper($1) ORDER BY scanned_at`, pnr); err == nil {
		for srows.Next() {
			var seat, result, by string
			var at time.Time
			if srows.Scan(&seat, &result, &at, &by) == nil && result != "BOARDED" {
				add(at, "boarding", "Scan: "+result, "seat "+seat+" · "+by, "ops.boarding_scans")
			}
		}
		srows.Close()
	}

	if crows, err := s.pool.Query(ctx, `
		SELECT refund_pct, refund_poisha, COALESCE(reason,''), created_at
		  FROM commerce.cancellations WHERE booking_id=$1::uuid ORDER BY created_at`, bookingID); err == nil {
		for crows.Next() {
			var pct int
			var amount int64
			var reason string
			var at time.Time
			if crows.Scan(&pct, &amount, &reason, &at) == nil {
				add(at, "cancellation", "Cancelled",
					fmt.Sprintf("%d%% refundable · ৳%d · %s", pct, amount/100, reason),
					"commerce.cancellations")
			}
		}
		crows.Close()
	}

	if rrows, err := s.pool.Query(ctx, `
		SELECT amount_poisha, status, created_at, updated_at
		  FROM commerce.refunds WHERE booking_id=$1::uuid ORDER BY created_at`, bookingID); err == nil {
		for rrows.Next() {
			var amount int64
			var rstatus string
			var at, updated time.Time
			if rrows.Scan(&amount, &rstatus, &at, &updated) == nil {
				add(at, "refund", "Refund requested", fmt.Sprintf("৳%d", amount/100), "commerce.refunds")
				if rstatus != "REQUESTED" {
					add(updated, "refund", "Refund "+rstatus, fmt.Sprintf("৳%d", amount/100), "commerce.refunds")
				}
			}
		}
		rrows.Close()
	}

	// What the passenger was actually told, and on which channel by which
	// aggregator. "I never got the SMS" is the single most common support call,
	// and until now this console had no answer to it.
	if nrows, err := s.pool.Query(ctx, `
		SELECT n.event_type, n.status, n.lang, n.created_at,
		       COALESCE(n.suppress_reason,''),
		       COALESCE((SELECT string_agg(a.channel || ' via ' || a.provider || ' (' || a.status || ')', ', '
		                                   ORDER BY a.attempt_id)
		                   FROM notify.attempts a WHERE a.notification_id = n.notification_id), 'no attempt')
		  FROM notify.notifications n
		 WHERE n.booking_id = $1::uuid ORDER BY n.created_at`, bookingID); err == nil {
		for nrows.Next() {
			var etype, nstatus, lang, suppressed, attempts string
			var at time.Time
			if nrows.Scan(&etype, &nstatus, &lang, &at, &suppressed, &attempts) == nil {
				detail := attempts
				if suppressed != "" {
					detail = suppressed
				}
				add(at, "notification", "Notified: "+etype+" ("+nstatus+")",
					lang+" · "+detail, "notify.notifications")
			}
		}
		nrows.Close()
	}

	sort.Slice(events, func(i, j int) bool { return events[i].At.Before(events[j].At) })

	// The remaining honest gaps, now that notifications are recorded.
	gaps := []string{
		"There is no mobile app, so no push token exists and PUSH deliveries are skipped rather than sent.",
		"Provider deliveries are simulated: an SMS is recorded and costed but no handset receives it.",
	}

	writeJSON(w, 200, map[string]any{
		"booking": map[string]any{
			"pnr": pnr, "booking_id": bookingID, "status": status, "channel": channel,
			"total_poisha": total, "created_at": created, "operator": brand,
			"depart_at": depart, "phone": deref(phone), "email": deref(email),
		},
		"timeline": events,
		// Support is told what is NOT here, so nobody promises a passenger
		// something the platform never did.
		"gaps": gaps,
	})
}

type caseRequest struct {
	PNR      string `json:"pnr"`
	Phone    string `json:"phone"`
	Subject  string `json:"subject"`
	Category string `json:"category"`
	Priority string `json:"priority"`
	Note     string `json:"note"`
}

func (s *Server) handleCreateCase(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req caseRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.Subject == "" {
		fail(w, 400, "subject_required", "Give the case a one-line subject.")
		return
	}
	if req.Category == "" {
		req.Category = "OTHER"
	}
	if req.Priority == "" {
		req.Priority = "NORMAL"
	}
	reference := "CASE-" + randomID()[:6]
	var caseID string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO support.cases (reference, pnr, phone, subject, category, priority, opened_by, assigned_to)
		VALUES ($1, NULLIF(upper($2),''), NULLIF($3,''), $4, $5, $6, $7::uuid, $7::uuid)
		RETURNING case_id::text`,
		reference, req.PNR, req.Phone, req.Subject, req.Category, req.Priority, id.StaffID).
		Scan(&caseID); err != nil {
		s.log.Error("create case", "err", err)
		fail(w, 500, "case_failed", "The case could not be opened.")
		return
	}
	if req.Note != "" {
		_, _ = s.pool.Exec(r.Context(),
			`INSERT INTO support.case_notes (case_id, author_id, body) VALUES ($1::uuid,$2::uuid,$3)`,
			caseID, id.StaffID, req.Note)
	}
	s.stf.Audit(r.Context(), id, "support.case.open", "case:"+reference, req.Subject)
	writeJSON(w, 201, map[string]any{"case_id": caseID, "reference": reference})
}

func (s *Server) handleListCases(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.case_id::text, c.reference, COALESCE(c.pnr,''), c.subject, c.category,
		       c.priority, c.status, c.created_at, COALESCE(u.full_name,''),
		       (SELECT count(*) FROM support.case_notes n WHERE n.case_id = c.case_id)
		  FROM support.cases c
		  LEFT JOIN staff.staff_users u ON u.staff_id = c.assigned_to
		 ORDER BY (c.status IN ('RESOLVED','CLOSED')), c.created_at DESC LIMIT 60`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load cases.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, ref, pnr, subject, category, priority, status, assignee string
		var at time.Time
		var notes int
		if rows.Scan(&cid, &ref, &pnr, &subject, &category, &priority,
			&status, &at, &assignee, &notes) != nil {
			continue
		}
		out = append(out, map[string]any{
			"case_id": cid, "reference": ref, "pnr": pnr, "subject": subject,
			"category": category, "priority": priority, "status": status,
			"created_at": at, "assigned_to": assignee, "notes": notes,
		})
	}
	writeJSON(w, 200, map[string]any{"cases": out})
}

type noteRequest struct {
	Body string `json:"body"`
}

func (s *Server) handleAddNote(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req noteRequest
	if err := decode(r, &req); err != nil || req.Body == "" {
		fail(w, 400, "bad_request", "Write a note before saving.")
		return
	}
	caseID := r.PathValue("caseID")
	if _, err := s.pool.Exec(r.Context(),
		`INSERT INTO support.case_notes (case_id, author_id, body) VALUES ($1::uuid,$2::uuid,$3)`,
		caseID, id.StaffID, req.Body); err != nil {
		fail(w, 500, "note_failed", "The note could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "support.case.note", "case:"+caseID, nil)
	writeJSON(w, 201, map[string]any{"case_id": caseID})
}

func (s *Server) handleCaseStatus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req statusRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	caseID := r.PathValue("caseID")
	if _, err := s.pool.Exec(r.Context(), `
		UPDATE support.cases
		   SET status = $2,
		       resolved_at = CASE WHEN $2 IN ('RESOLVED','CLOSED') THEN now() ELSE NULL END
		 WHERE case_id = $1::uuid`, caseID, req.Status); err != nil {
		fail(w, 500, "update_failed", "The case could not be updated.")
		return
	}
	s.stf.Audit(r.Context(), id, "support.case.status", "case:"+caseID, req.Status)
	writeJSON(w, 200, map[string]any{"case_id": caseID, "status": req.Status})
}

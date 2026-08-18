package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/busticket/platform/services/staff/staff"
)

// Crash reports from the apps.
//
// A Flutter exception on a conductor's phone used to produce a red screen on
// that phone and nothing anywhere else. The conductor force-quit and carried on
// selling on paper, and the office learned about it — if at all — as a rumour.
//
// Reporting is unauthenticated on purpose. The crash a passenger hits on the
// sign-in screen is exactly the one nobody can report through an authenticated
// endpoint, and it is usually the worst one. That decision is what the limits
// below exist to pay for.

func (s *Server) clientErrorRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/client-errors", s.handleReportClientError)
	m.HandleFunc("GET /api/v1/admin/client-errors", s.guard("ops.errors.read", s.handleListClientErrors))
	m.HandleFunc("POST /api/v1/admin/client-errors/{errorID}/resolve",
		s.guard("ops.errors.read", s.handleResolveClientError))
}

type clientErrorReport struct {
	App         string `json:"app"`
	AppVersion  string `json:"app_version"`
	Platform    string `json:"platform"`
	Screen      string `json:"screen"`
	Kind        string `json:"kind"`
	Message     string `json:"message"`
	Stack       string `json:"stack"`
	Fingerprint string `json:"fingerprint"`
}

// clip bounds a field a broken client could send unbounded. A crash loop that
// posts a megabyte of stack a thousand times is a denial of service written by
// our own app, and the tail of a stack trace is the part nobody reads anyway.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (s *Server) handleReportClientError(w http.ResponseWriter, r *http.Request) {
	var req clientErrorReport
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That report could not be read.")
		return
	}
	switch req.App {
	case "passenger", "crew", "web":
	default:
		fail(w, 400, "bad_app", "Unknown app.")
		return
	}
	if strings.TrimSpace(req.Message) == "" || strings.TrimSpace(req.Fingerprint) == "" {
		fail(w, 400, "bad_report", "A report needs a message and a fingerprint.")
		return
	}

	// The staff id is taken from the token when there is one, and never from the
	// body. A report that could name anybody it liked would be worth less than
	// no report at all.
	var staffID string
	if id, err := s.stf.Authenticate(r.Context(), bearer(r)); err == nil && id != nil {
		staffID = id.StaffID
	}

	// Same fault, same row, higher count. Two hundred reports of one bug in a
	// morning is one problem, and a list that shows it two hundred times hides
	// the other two.
	//
	// A resolved error that happens again reopens: it was either not fixed or
	// it came back, and both mean somebody should look.
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO ops.client_errors
			(app, app_version, platform, screen, kind, message, stack, staff_id, fingerprint)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::uuid,$9)
		ON CONFLICT (app, fingerprint) DO UPDATE
		   SET occurrences = ops.client_errors.occurrences + 1,
		       last_seen   = now(),
		       app_version = EXCLUDED.app_version,
		       platform    = EXCLUDED.platform,
		       screen      = EXCLUDED.screen,
		       message     = EXCLUDED.message,
		       stack       = EXCLUDED.stack,
		       resolved_at = NULL`,
		req.App, clip(req.AppVersion, 40), clip(req.Platform, 60), clip(req.Screen, 80),
		clip(req.Kind, 120), clip(req.Message, 2000), clip(req.Stack, 8000),
		staffID, clip(req.Fingerprint, 80)); err != nil {
		s.log.Error("client error report", "err", err)
		// Deliberately still a 202. A client that cannot report a crash must not
		// then have to handle a failure to report it — that is the loop this
		// endpoint exists to break.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) handleListClientErrors(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	includeResolved := r.URL.Query().Get("resolved") == "true"
	rows, err := s.pool.Query(r.Context(), `
		SELECT e.error_id::text, e.app, e.app_version, e.platform, e.screen,
		       e.kind, e.message, e.stack, e.fingerprint, e.occurrences,
		       e.first_seen, e.last_seen, e.resolved_at, COALESCE(u.full_name,'')
		  FROM ops.client_errors e
		  LEFT JOIN staff.staff_users u ON u.staff_id = e.staff_id
		 WHERE ($1 OR e.resolved_at IS NULL)
		 ORDER BY e.resolved_at IS NOT NULL, e.last_seen DESC
		 LIMIT 200`, includeResolved)
	if err != nil {
		s.log.Error("client errors", "err", err)
		fail(w, 500, "query_failed", "Could not load the error log.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var open, total int
	for rows.Next() {
		var eid, app, version, platform, screen, kind, message, stack, fp, who string
		var occurrences int
		var first, last time.Time
		var resolved *time.Time
		if rows.Scan(&eid, &app, &version, &platform, &screen, &kind, &message,
			&stack, &fp, &occurrences, &first, &last, &resolved, &who) != nil {
			continue
		}
		total += occurrences
		if resolved == nil {
			open++
		}
		out = append(out, map[string]any{
			"error_id": eid, "app": app, "app_version": version, "platform": platform,
			"screen": screen, "kind": kind, "message": message, "stack": stack,
			"fingerprint": fp, "occurrences": occurrences,
			"first_seen": first, "last_seen": last, "resolved_at": resolved,
			"reported_by": who,
		})
	}
	writeJSON(w, 200, map[string]any{
		"errors": out, "open": open, "occurrences": total,
	})
}

func (s *Server) handleResolveClientError(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	eid := r.PathValue("errorID")
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE ops.client_errors SET resolved_at = now() WHERE error_id = $1::uuid`, eid); err != nil {
		fail(w, 500, "update_failed", "That could not be marked resolved.")
		return
	}
	s.stf.Audit(r.Context(), id, "ops.error.resolve", "client_error:"+eid, nil)
	writeJSON(w, 200, map[string]any{"error_id": eid, "resolved": true})
}

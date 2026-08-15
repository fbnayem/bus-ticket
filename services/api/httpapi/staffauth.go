package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/busticket/platform/services/staff/staff"
)

func (s *Server) staffRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/staff/login", s.handleStaffLogin)
	m.HandleFunc("POST /api/v1/staff/logout", s.guard("", s.handleStaffLogout))
	m.HandleFunc("GET /api/v1/staff/me", s.guard("", s.handleStaffMe))
	m.HandleFunc("POST /api/v1/staff/mfa/setup", s.guard("", s.handleMFASetup))
	m.HandleFunc("POST /api/v1/staff/mfa/enable", s.guard("", s.handleMFAEnable))
	m.HandleFunc("POST /api/v1/staff/mfa/disable", s.guard("", s.handleMFADisable))
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// The six digits from an authenticator app, for accounts that have one.
	TOTP string `json:"totp"`
}

func (s *Server) handleStaffLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	token, id, err := s.stf.LoginWithCode(r.Context(), req.Email, req.Password, req.TOTP,
		clientIP(r), r.UserAgent())
	switch {
	case errors.Is(err, staff.ErrBadCredentials):
		// Deliberately the same message whether the email exists or not.
		fail(w, 401, "bad_credentials", "That email and password do not match.")
		return
	case errors.Is(err, staff.ErrMFARequired):
		// A distinct code, because the person got their password right and needs
		// to be asked for the second factor rather than told they failed.
		fail(w, 401, "mfa_required", "Enter the six-digit code from your authenticator app.")
		return
	case errors.Is(err, staff.ErrMFAInvalid):
		fail(w, 401, "mfa_invalid", "That code is not right. Try the next one.")
		return
	case errors.Is(err, staff.ErrMFAReplayed):
		fail(w, 401, "mfa_replayed", "That code has already been used. Wait for the next one.")
		return
	case errors.Is(err, staff.ErrSuspended):
		fail(w, 403, "account_locked", "This account is locked. Ask an administrator to unlock it.")
		return
	case err != nil:
		s.log.Error("staff login", "err", err)
		fail(w, 500, "login_failed", "Sign-in is unavailable right now.")
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "identity": id, "home": homeFor(id)})
}

func (s *Server) handleStaffLogout(w http.ResponseWriter, r *http.Request, _ *staff.Identity) {
	_ = s.stf.Logout(r.Context(), bearer(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStaffMe(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	extra := map[string]any{}
	if id.CounterID != "" {
		var name, operator string
		if err := s.pool.QueryRow(r.Context(), `
			SELECT c.name, o.brand FROM counter.counters c
			  JOIN catalog.operators o ON o.operator_id = c.operator_id
			 WHERE c.counter_id = $1::uuid`, id.CounterID).Scan(&name, &operator); err == nil {
			extra["counter_name"] = name
			extra["operator_brand"] = operator
		}
	}
	if id.AgencyID != "" {
		var name string
		if err := s.pool.QueryRow(r.Context(),
			`SELECT name FROM agent.agencies WHERE agency_id = $1::uuid`, id.AgencyID).Scan(&name); err == nil {
			extra["agency_name"] = name
		}
	}
	if id.OperatorID != "" {
		var brand string
		if err := s.pool.QueryRow(r.Context(),
			`SELECT brand FROM catalog.operators WHERE operator_id = $1::uuid`, id.OperatorID).Scan(&brand); err == nil {
			extra["operator_brand"] = brand
		}
	}
	mfa, _ := s.stf.MFAStatus(r.Context(), id.StaffID)
	extra["mfa_enabled"] = mfa
	writeJSON(w, 200, map[string]any{
		"identity": id, "home": homeFor(id), "context": extra, "mfa_enabled": mfa,
	})
}

// ------------------------------------------------------------------- MFA ----

func (s *Server) handleMFASetup(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	secret, uri, err := s.stf.BeginMFASetup(r.Context(), id.StaffID, id.Email)
	if err != nil {
		fail(w, 400, "mfa_setup_failed", err.Error())
		return
	}
	// The secret is returned exactly once, at enrolment, and never again.
	writeJSON(w, 200, map[string]any{"secret": secret, "otpauth_uri": uri})
}

func (s *Server) handleMFAEnable(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Code string `json:"code"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if err := s.stf.EnableMFA(r.Context(), id, req.Code); err != nil {
		fail(w, 400, "mfa_invalid", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"mfa_enabled": true})
}

func (s *Server) handleMFADisable(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	var req struct {
		Code string `json:"code"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if err := s.stf.DisableMFA(r.Context(), id, req.Code); err != nil {
		fail(w, 400, "mfa_invalid", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"mfa_enabled": false})
}

// homeFor decides which of the six workplaces this person is sent to after
// signing in. It is derived from permissions, not from a role name, so a
// custom role built tomorrow lands somewhere sensible without a code change.
func homeFor(id *staff.Identity) string {
	// Ordered from most specific workplace to least. Platform-wide rights are
	// checked first: a Super Admin holds every permission by construction, so
	// testing counter.sell before platform.admin would send them to a till.
	switch {
	case id.Can("platform.admin"):
		return "/admin"
	case id.Can("ledger.read") && id.IsPlatform():
		return "/admin"
	case id.Can("support.read") && id.IsPlatform():
		return "/helpdesk"
	case id.Can("counter.sell"):
		return "/counter"
	case id.Can("wallet.sell"):
		return "/agent"
	case id.Can("driver.trip"):
		return "/driver"
	case id.Can("trip.read"):
		return "/operator"
	default:
		return "/staff"
	}
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

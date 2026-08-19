package httpapi

import (
	"errors"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/busticket/platform/services/identity/identity"
	"github.com/busticket/platform/services/risk/risk"
)

// Passenger authentication.
//
// Guest checkout stays. Most people buying a bus ticket in this market are not
// going to make an account first, and forcing them to is how a booking funnel
// loses half its traffic. What changes is that a guest is now a real row with a
// real owner, and signing in later claims those bookings rather than leaving
// them stranded behind a phone number.

func (s *Server) authRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/auth/otp/request", s.handleOTPRequest)
	m.HandleFunc("POST /api/v1/auth/otp/verify", s.handleOTPVerify)
	m.HandleFunc("POST /api/v1/auth/password/login", s.handlePasswordLogin)
	m.HandleFunc("POST /api/v1/auth/password/set", s.handleSetPassword)
	m.HandleFunc("POST /api/v1/auth/refresh", s.handleRefresh)
	m.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	m.HandleFunc("GET /api/v1/auth/me", s.handleMe)
	m.HandleFunc("GET /api/v1/auth/sessions", s.handleSessions)
	m.HandleFunc("POST /api/v1/auth/sessions/revoke-all", s.handleRevokeAll)
	m.HandleFunc("PATCH /api/v1/auth/profile", s.handleUpdateProfile)
}

// passenger resolves the caller, or nil for an anonymous visitor. It never
// fails a request: most passenger endpoints work signed out.
func (s *Server) passenger(r *http.Request) *identity.Identity {
	if s.ident == nil {
		return nil
	}
	id, err := s.ident.Authenticate(r.Context(), bearer(r))
	if err != nil {
		return nil
	}
	return id
}

// requirePassenger is for the endpoints that genuinely need an account.
func (s *Server) requirePassenger(w http.ResponseWriter, r *http.Request) *identity.Identity {
	id := s.passenger(r)
	if id == nil {
		fail(w, 401, "unauthenticated", "Please sign in to see this.")
		return nil
	}
	return id
}

// showOTP reveals the code in the API response. It exists so the browser test
// and a local developer can sign in without an SMS gateway. It is off unless
// SHOW_OTP is explicitly true AND the environment is not production — the reveal
// must never be one env flag away in production, where it would return live OTPs
// for any phone number over the wire and defeat the "store only the hash" design.
func showOTP() bool { return notProduction() && strings.EqualFold(os.Getenv("SHOW_OTP"), "true") }

// notProduction mirrors the boot-time secret guard's fail-closed rule: only the
// well-known non-production names count as non-production, so an unrecognised
// APP_ENV (prod, Production, staging, …) is treated as production and refuses to
// reveal anything. An unset APP_ENV stays development so the stack runs locally
// with no configuration, matching the boot default.
func notProduction() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("APP_ENV"))) {
	case "", "development", "dev", "test", "local", "ci":
		return true
	default:
		return false
	}
}

func (s *Server) handleOTPRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Lang  string `json:"lang"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	ip := clientAddr(r)

	// The risk engine sees OTP requests before the rate limiter does, because
	// one address creating accounts across many numbers is a different problem
	// from one number asking for too many codes.
	if s.risk != nil {
		d := s.risk.Evaluate(r.Context(), "otp", risk.Subject{IP: ip, Phone: identity.NormalisePhone(req.Phone)}, 0)
		if !d.Allowed() {
			fail(w, 429, "rate_limited", "Too many attempts from this connection. Please try again shortly.")
			return
		}
		s.risk.Observe(r.Context(), "otp", risk.Subject{IP: ip, Phone: identity.NormalisePhone(req.Phone)})
	}

	code, err := s.ident.RequestOTP(r.Context(), req.Phone, ip, req.Lang, showOTP())
	if errors.Is(err, identity.ErrRateLimited) {
		fail(w, 429, "rate_limited", "That number has been sent several codes already. Please wait a few minutes.")
		return
	}
	if err != nil {
		s.log.Warn("otp request", "err", err)
		fail(w, 400, "otp_failed", "We could not send a code to that number.")
		return
	}
	out := map[string]any{"sent": true, "expires_in_seconds": 300}
	if code != "" {
		out["debug_code"] = code
		out["notice"] = "SHOW_OTP is on: this code is returned for local testing only."
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleOTPVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone  string `json:"phone"`
		Code   string `json:"code"`
		Device string `json:"device"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	tokens, err := s.ident.VerifyOTP(r.Context(), req.Phone, req.Code, req.Device, clientAddr(r))
	if errors.Is(err, identity.ErrBadCode) {
		fail(w, 401, "bad_code", "That code is wrong or has expired. Ask for a new one.")
		return
	}
	if err != nil {
		s.log.Error("otp verify", "err", err)
		fail(w, 500, "verify_failed", "We could not sign you in just now.")
		return
	}

	// Claim any bookings made as a guest on this number, and qualify a referral
	// if this sign-in completes one.
	moved, err := s.ident.Promote(r.Context(), tokens.Identity.UserID, tokens.Identity.Phone)
	if err != nil {
		s.log.Warn("guest promotion", "err", err)
	}
	writeJSON(w, 200, map[string]any{
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
		"expires_at":    tokens.ExpiresAt,
		"identity":      tokens.Identity,
		"bookings_claimed": moved,
	})
}

func (s *Server) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Login    string `json:"login"`
		Password string `json:"password"`
		Device   string `json:"device"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	tokens, err := s.ident.LoginPassword(r.Context(), req.Login, req.Password, req.Device, clientAddr(r))
	if err != nil {
		// One message for both "no such account" and "wrong password", so the
		// response cannot be used to find out which numbers have accounts.
		fail(w, 401, "bad_credentials", "That phone number or password is not right.")
		return
	}
	writeJSON(w, 200, map[string]any{
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
		"expires_at":    tokens.ExpiresAt,
		"identity":      tokens.Identity,
	})
}

func (s *Server) handleSetPassword(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.ident.SetPassword(r.Context(), id.UserID, req.Password); err != nil {
		fail(w, 400, "weak_password", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
		Device       string `json:"device"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	tokens, err := s.ident.Refresh(r.Context(), req.RefreshToken, req.Device, clientAddr(r))
	if errors.Is(err, identity.ErrTokenReplayed) {
		// The token had already been used, so somebody else has a copy. Every
		// session from that original sign-in is now revoked.
		fail(w, 401, "token_reuse",
			"For your safety we signed out every device from that sign-in. Please sign in again.")
		return
	}
	if err != nil {
		fail(w, 401, "unauthenticated", "Please sign in again.")
		return
	}
	writeJSON(w, 200, map[string]any{
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
		"expires_at":    tokens.ExpiresAt,
		"identity":      tokens.Identity,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.ident.Logout(r.Context(), bearer(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	id := s.passenger(r)
	if id == nil {
		writeJSON(w, 200, map[string]any{"signed_in": false})
		return
	}
	writeJSON(w, 200, map[string]any{
		"signed_in":    true,
		"identity":     id,
		"has_password": s.ident.HasPassword(r.Context(), id.UserID),
	})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	sessions, err := s.ident.Sessions(r.Context(), id.UserID, id.SessionID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load your devices.")
		return
	}
	writeJSON(w, 200, map[string]any{"sessions": sessions})
}

func (s *Server) handleRevokeAll(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	if err := s.ident.SignOutEverywhere(r.Context(), id.UserID); err != nil {
		fail(w, 500, "revoke_failed", "Could not sign out your other devices.")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id := s.requirePassenger(w, r)
	if id == nil {
		return
	}
	var req struct {
		Name  string `json:"display_name"`
		Email string `json:"email"`
		Lang  string `json:"lang"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "We could not read that request.")
		return
	}
	if err := s.ident.UpdateProfile(r.Context(), id.UserID, req.Name, req.Email); err != nil {
		fail(w, 500, "update_failed", "Could not save your details.")
		return
	}
	if req.Lang == "bn" || req.Lang == "en" {
		if _, err := s.pool.Exec(r.Context(), `
			INSERT INTO notify.preferences (user_key, lang) VALUES ($1, $2)
			ON CONFLICT (user_key) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`,
			id.Phone, req.Lang); err != nil {
			s.log.Warn("language preference", "err", err)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// clientAddr extracts a bare IP. net.SplitHostPort rather than a string split,
// because a local IPv6 caller arrives as "[::1]:54321" and cutting on the first
// colon yields "[" — which PostgreSQL rejects as an inet, taking the whole OTP
// endpoint down with it.
func clientAddr(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		ip, _, _ := strings.Cut(v, ",")
		return strings.TrimSpace(ip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

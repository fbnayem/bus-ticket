package httpapi

import (
	"net/http"
	"strings"
)

// Device registration for push.
//
// The notify service has had a PUSH channel since the beginning — providers,
// preferences, templates, a delivery log — and no address to send anything to.
// This is the address.
//
// Both apps register the same way and the same endpoint serves both, because a
// device belongs to whoever is signed in on it and that is the only thing that
// differs between a passenger's phone and a conductor's.

func (s *Server) deviceRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/devices", s.handleRegisterDevice)
	m.HandleFunc("POST /api/v1/devices/revoke", s.handleRevokeDevice)
}

type deviceRequest struct {
	Token     string `json:"token"`
	App       string `json:"app"`
	Platform  string `json:"platform"`
	DeviceRef string `json:"device_ref"`
}

// handleRegisterDevice records where to reach this phone.
//
// Authenticated, and the owner comes from the token rather than the body: a
// registration that could name anybody would let one person redirect another
// person's tickets to their own phone.
func (s *Server) handleRegisterDevice(w http.ResponseWriter, r *http.Request) {
	var req deviceRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		fail(w, 400, "no_token", "A device registration needs a token.")
		return
	}
	if req.App != "passenger" && req.App != "crew" {
		fail(w, 400, "bad_app", "Unknown app.")
		return
	}
	switch req.Platform {
	case "", "android", "ios", "web":
	default:
		fail(w, 400, "bad_platform", "Unknown platform.")
		return
	}

	ctx := r.Context()
	var userID, staffID, userKey string

	// A staff member first, because a conductor signed into the crew app is the
	// case with the narrower token.
	if id, err := s.stf.Authenticate(ctx, bearer(r)); err == nil && id != nil {
		staffID = id.StaffID
		userKey = "staff:" + id.StaffID
	} else if p := s.passenger(r); p != nil {
		userID = p.UserID
		// The same key notify.preferences is stored against, so a device
		// inherits the choices its owner has already made about being contacted
		// rather than starting from a default that ignores them.
		userKey = p.Phone
	} else {
		fail(w, 401, "unauthenticated", "Sign in before registering this device.")
		return
	}

	// The token is the key, not the person. The same token arriving for a
	// different account means the phone changed hands, and the row must move
	// with it — otherwise the new owner starts receiving the old owner's
	// tickets, which is the one failure this table must not have.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO notify.devices (token, app, platform, user_id, staff_id, user_key, device_ref)
		VALUES ($1,$2,$3,NULLIF($4,'')::uuid,NULLIF($5,'')::uuid,$6,$7)
		ON CONFLICT (token) DO UPDATE
		   SET app          = EXCLUDED.app,
		       platform     = EXCLUDED.platform,
		       user_id      = EXCLUDED.user_id,
		       staff_id     = EXCLUDED.staff_id,
		       user_key     = EXCLUDED.user_key,
		       device_ref   = EXCLUDED.device_ref,
		       last_seen_at = now(),
		       revoked_at   = NULL`,
		req.Token, req.App, req.Platform, userID, staffID, userKey, req.DeviceRef); err != nil {
		s.log.Error("device register", "err", err)
		fail(w, 500, "register_failed", "This device could not be registered.")
		return
	}
	writeJSON(w, 200, map[string]any{"registered": true})
}

// handleRevokeDevice stops a signed-out phone receiving anything further.
//
// Deliberately not authenticated the same way: a person signing out has usually
// already had their session cleared by the time this runs, and a phone that
// cannot say "stop" keeps receiving somebody else's tickets. The token itself is
// the secret — knowing it is what a caller must demonstrate — and the worst a
// wrong one can do is silence a device that then re-registers on next sign-in.
func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	var req deviceRequest
	if err := decode(r, &req); err != nil || strings.TrimSpace(req.Token) == "" {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE notify.devices SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL`,
		strings.TrimSpace(req.Token)); err != nil {
		fail(w, 500, "revoke_failed", "This device could not be revoked.")
		return
	}
	writeJSON(w, 200, map[string]any{"revoked": true})
}

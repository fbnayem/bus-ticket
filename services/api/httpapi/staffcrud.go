package httpapi

import (
	"net/http"
	"strings"

	"github.com/busticket/platform/services/staff/staff"
)

// Staff accounts and crew rostering — the write side of who works for an
// operator, and who is on which bus.
//
// The load-bearing rule here is that an operator provisions only their OWN
// people and only OPERATOR-family roles. A tenant that could mint a PLATFORM
// account, or grant SUPER_ADMIN to one of their drivers, would have escalated
// straight out of their tenancy — so every role a caller assigns is checked to
// be an operator role before it is granted, on create and on edit alike.

func (s *Server) staffCrudRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/operator/roles", s.guard("staff.read", s.handleAssignableRoles))
	m.HandleFunc("POST /api/v1/operator/staff", s.guard("staff.write", s.handleCreateStaff))
	m.HandleFunc("PATCH /api/v1/operator/staff/{staffID}", s.guard("staff.write", s.handleUpdateStaff))

	m.HandleFunc("GET /api/v1/operator/trips/{tripID}/crew", s.guard("schedule.read", s.handleTripCrew))
	m.HandleFunc("POST /api/v1/operator/trips/{tripID}/crew", s.guard("schedule.write", s.handleAssignCrew))
	m.HandleFunc("DELETE /api/v1/operator/trips/{tripID}/crew/{staffID}", s.guard("schedule.write", s.handleUnassignCrew))
}

var crewRoles = map[string]bool{"DRIVER": true, "HELPER": true, "SUPERVISOR": true}

type staffCreateRequest struct {
	Email    string   `json:"email"`
	FullName string   `json:"full_name"`
	Phone    string   `json:"phone"`
	Password string   `json:"password"`
	Roles    []string `json:"roles"` // role_key values, OPERATOR family only
}

type staffUpdateRequest struct {
	FullName string   `json:"full_name"`
	Phone    string   `json:"phone"`
	Status   string   `json:"status"`
	Roles    []string `json:"roles"` // if present, replaces the role set
}

type crewAssignRequest struct {
	StaffID  string `json:"staff_id"`
	CrewRole string `json:"crew_role"`
}

func (s *Server) handleAssignableRoles(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(),
		`SELECT role_id::text, role_key FROM catalog.roles WHERE family='OPERATOR' ORDER BY role_key`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load roles.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, key string
		if rows.Scan(&rid, &key) != nil {
			continue
		}
		out = append(out, map[string]any{"role_id": rid, "role_key": key})
	}
	writeJSON(w, 200, map[string]any{"roles": out})
}

// resolveOperatorRoles turns requested role keys into role ids, but ONLY for
// OPERATOR-family roles. If any requested key is unknown or belongs to another
// family, it returns ok=false — the caller then refuses the whole request
// rather than silently granting the subset that happened to be allowed.
func (s *Server) resolveOperatorRoles(r *http.Request, keys []string) (ids []string, ok bool) {
	if len(keys) == 0 {
		return nil, false
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT role_id::text FROM catalog.roles WHERE family='OPERATOR' AND role_key = ANY($1)`, keys)
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	for rows.Next() {
		var rid string
		if rows.Scan(&rid) == nil {
			ids = append(ids, rid)
		}
	}
	// Every requested key must have resolved to an operator role. A short count
	// means at least one key was unknown or from a forbidden family.
	seen := map[string]bool{}
	for _, k := range keys {
		seen[k] = true
	}
	return ids, len(ids) == len(seen)
}

func (s *Server) handleCreateStaff(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A staff account must belong to an operator.")
		return
	}
	var req staffCreateRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.FullName = strings.TrimSpace(req.FullName)
	if req.Email == "" || !strings.Contains(req.Email, "@") {
		fail(w, 400, "bad_email", "Enter a valid email address.")
		return
	}
	if req.FullName == "" {
		fail(w, 400, "bad_name", "Enter the person's name.")
		return
	}
	if len(req.Password) < 8 {
		fail(w, 400, "weak_password", "Give them a password of at least 8 characters.")
		return
	}
	roleIDs, ok := s.resolveOperatorRoles(r, req.Roles)
	if !ok {
		fail(w, 403, "bad_roles", "You can only assign operator roles, and every role must be a real one.")
		return
	}

	salt, hash, iter, err := staff.NewPassword(req.Password)
	if err != nil {
		fail(w, 500, "staff_failed", "The account could not be created.")
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "staff_failed", "The account could not be created.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck

	var staffID string
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO staff.staff_users (email, full_name, phone, password_hash, password_salt, password_iter, operator_id)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7::uuid) RETURNING staff_id::text`,
		req.Email, req.FullName, strings.TrimSpace(req.Phone), hash, salt, iter, op).Scan(&staffID); err != nil {
		if strings.Contains(err.Error(), "staff_users_email_key") {
			fail(w, 409, "email_taken", "Someone already signs in with that email.")
			return
		}
		s.log.Error("create staff", "err", err)
		fail(w, 500, "staff_failed", "The account could not be created.")
		return
	}
	for _, rid := range roleIDs {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO staff.user_roles (staff_id, role_id) VALUES ($1::uuid,$2::uuid)`, staffID, rid); err != nil {
			fail(w, 500, "staff_failed", "The roles could not be assigned.")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "staff_failed", "The account could not be created.")
		return
	}
	s.stf.Audit(r.Context(), id, "staff.create", "staff:"+staffID, req.Email)
	writeJSON(w, 201, map[string]any{"staff_id": staffID, "email": req.Email})
}

func (s *Server) handleUpdateStaff(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	staffID := r.PathValue("staffID")
	var req staffUpdateRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}

	// The account must be this operator's own. Platform staff (operator_id NULL)
	// never match an operator's id, so they are out of reach here.
	var owner *string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM staff.staff_users WHERE staff_id=$1::uuid`, staffID).Scan(&owner); err != nil {
		fail(w, 404, "staff_not_found", "That account does not exist.")
		return
	}
	if id.OperatorID != "" && (owner == nil || *owner != id.OperatorID) {
		fail(w, 403, "forbidden", "That account belongs to another operator.")
		return
	}
	if req.Status != "" && req.Status != "ACTIVE" && req.Status != "SUSPENDED" {
		fail(w, 400, "bad_status", "An account can be ACTIVE or SUSPENDED.")
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "staff_failed", "The account could not be updated.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck

	if _, err := tx.Exec(r.Context(), `
		UPDATE staff.staff_users SET
		   full_name = COALESCE(NULLIF($2,''), full_name),
		   phone     = COALESCE(NULLIF($3,''), phone),
		   status    = COALESCE(NULLIF($4,''), status)
		 WHERE staff_id=$1::uuid`, staffID, strings.TrimSpace(req.FullName), strings.TrimSpace(req.Phone), req.Status); err != nil {
		fail(w, 500, "staff_failed", "The account could not be updated.")
		return
	}

	// Roles are replaced only when the field is present; the same operator-only
	// gate applies as on create, so an edit can't be a back door to a platform role.
	if req.Roles != nil {
		roleIDs, ok := s.resolveOperatorRoles(r, req.Roles)
		if !ok {
			fail(w, 403, "bad_roles", "You can only assign operator roles, and every role must be a real one.")
			return
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM staff.user_roles WHERE staff_id=$1::uuid`, staffID); err != nil {
			fail(w, 500, "staff_failed", "The roles could not be updated.")
			return
		}
		for _, rid := range roleIDs {
			if _, err := tx.Exec(r.Context(),
				`INSERT INTO staff.user_roles (staff_id, role_id) VALUES ($1::uuid,$2::uuid)`, staffID, rid); err != nil {
				fail(w, 500, "staff_failed", "The roles could not be updated.")
				return
			}
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "staff_failed", "The account could not be updated.")
		return
	}
	s.stf.Audit(r.Context(), id, "staff.update", "staff:"+staffID, req.Status)
	writeJSON(w, 200, map[string]any{"staff_id": staffID})
}

// ------------------------------------------------------------ crew rostering --

func (s *Server) handleTripCrew(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	if _, ok := s.tripOwnerOK(r, id, tripID); !ok {
		fail(w, 403, "forbidden", "That trip belongs to another operator.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT tc.staff_id::text, u.full_name, tc.crew_role
		  FROM ops.trip_crew tc JOIN staff.staff_users u ON u.staff_id = tc.staff_id
		 WHERE tc.trip_id=$1::uuid ORDER BY tc.crew_role, u.full_name`, tripID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the crew.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, name, role string
		if rows.Scan(&sid, &name, &role) != nil {
			continue
		}
		out = append(out, map[string]any{"staff_id": sid, "full_name": name, "crew_role": role})
	}
	writeJSON(w, 200, map[string]any{"crew": out})
}

func (s *Server) handleAssignCrew(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	op, ok := s.tripOwnerOK(r, id, tripID)
	if !ok {
		fail(w, 403, "forbidden", "That trip belongs to another operator.")
		return
	}
	var req crewAssignRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if !crewRoles[req.CrewRole] {
		fail(w, 400, "bad_role", "A crew role is DRIVER, HELPER or SUPERVISOR.")
		return
	}
	// The person being rostered must be this operator's own staff — a bus cannot
	// be crewed by another company's driver.
	var staffOp *string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM staff.staff_users WHERE staff_id=$1::uuid`, req.StaffID).Scan(&staffOp); err != nil {
		fail(w, 404, "staff_not_found", "That person is not on your staff.")
		return
	}
	if staffOp == nil || *staffOp != op {
		fail(w, 403, "forbidden", "That person is not on your staff.")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO ops.trip_crew (trip_id, staff_id, crew_role)
		VALUES ($1::uuid,$2::uuid,$3)
		ON CONFLICT (trip_id, staff_id) DO UPDATE SET crew_role = EXCLUDED.crew_role`,
		tripID, req.StaffID, req.CrewRole); err != nil {
		fail(w, 500, "roster_failed", "The crew could not be assigned.")
		return
	}
	s.stf.Audit(r.Context(), id, "crew.assign", "trip:"+tripID, req.StaffID+":"+req.CrewRole)
	writeJSON(w, 200, map[string]any{"trip_id": tripID, "staff_id": req.StaffID, "crew_role": req.CrewRole})
}

func (s *Server) handleUnassignCrew(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	tripID := r.PathValue("tripID")
	staffID := r.PathValue("staffID")
	if _, ok := s.tripOwnerOK(r, id, tripID); !ok {
		fail(w, 403, "forbidden", "That trip belongs to another operator.")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM ops.trip_crew WHERE trip_id=$1::uuid AND staff_id=$2::uuid`, tripID, staffID); err != nil {
		fail(w, 500, "roster_failed", "The crew member could not be removed.")
		return
	}
	s.stf.Audit(r.Context(), id, "crew.unassign", "trip:"+tripID, staffID)
	writeJSON(w, 200, map[string]any{"trip_id": tripID, "staff_id": staffID, "removed": true})
}

// tripOwnerOK returns the trip's operator and whether the caller may act on it.
func (s *Server) tripOwnerOK(r *http.Request, id *staff.Identity, tripID string) (string, bool) {
	var op string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, tripID).Scan(&op); err != nil {
		return "", false
	}
	if id.OperatorID != "" && id.OperatorID != op {
		return op, false
	}
	return op, true
}

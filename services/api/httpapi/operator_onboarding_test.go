package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

// Onboarding a new operator is a PLATFORM action, and it must leave behind a
// tenant that can actually be used: the operator record AND a first owner login,
// wired together. This proves both halves.
//
//   - Platform-only: an operator owner calling the endpoint is refused (403).
//     Remove the id.OperatorID guard and one operator could mint another.
//   - Provisioning: a platform call creates a PENDING operator plus an
//     OPERATOR_OWNER login that genuinely signs in — proven by logging in as that
//     owner and finding the identity scoped to the new operator with the owner's
//     permissions. If the password hash, the operator binding or the role
//     assignment were wrong, the login would fail or land in the wrong tenant.
func TestCreateOperatorIsPlatformOnlyAndProvisionsOwner(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	ctx := context.Background()

	// A unique owner email so repeated runs never collide.
	var suffix string
	if err := testPool.QueryRow(ctx, `SELECT substr(gen_random_uuid()::text,1,8)`).Scan(&suffix); err != nil {
		t.Fatal(err)
	}
	email := "owner-" + suffix + "@onboard.test"
	const password = "Onboard#2026"

	create := func(caller *staff.Identity) *httptest.ResponseRecorder {
		body, _ := json.Marshal(createOperatorRequest{
			LegalName: "Onboard Test Lines Ltd", Brand: "Onboard " + suffix,
			VATBIN: "000999888-0101", VATRateBP: 1500,
			Owner: struct {
				Email    string `json:"email"`
				FullName string `json:"full_name"`
				Phone    string `json:"phone"`
				Password string `json:"password"`
			}{Email: email, FullName: "Test Owner", Phone: "01700000000", Password: password},
		})
		rec := httptest.NewRecorder()
		s.handleCreateOperator(rec, httptest.NewRequest("POST", "/api/v1/admin/operators", bytes.NewReader(body)), caller)
		return rec
	}

	// An operator owner (Green Line) is refused outright — the security guard.
	if rec := create(ownerID()); rec.Code != 403 {
		t.Fatalf("an operator owner creating an operator returned %d, want 403: %s", rec.Code, rec.Body.String())
	}

	// Platform staff (no operator scope) may onboard.
	rec := create(&staff.Identity{StaffID: greenLineOwner})
	if rec.Code != 201 {
		t.Fatalf("platform onboarding an operator returned %d, want 201: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OperatorID   string `json:"operator_id"`
		Status       string `json:"status"`
		OwnerStaffID string `json:"owner_staff_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// Clean up the whole tenant on the way out.
	defer func() {
		testPool.Exec(ctx, `DELETE FROM staff.user_roles WHERE staff_id=$1::uuid`, out.OwnerStaffID)
		testPool.Exec(ctx, `DELETE FROM staff.staff_users WHERE staff_id=$1::uuid`, out.OwnerStaffID)
		testPool.Exec(ctx, `DELETE FROM catalog.operators WHERE operator_id=$1::uuid`, out.OperatorID)
	}()

	// A fresh operator is PENDING — onboarded, but not yet cleared to sell.
	if out.Status != "PENDING" {
		t.Fatalf("a new operator should start PENDING, got %q", out.Status)
	}

	// The owner login is real: sign in with the password just set and land inside
	// the new tenant with the owner's permissions.
	_, ident, err := s.stf.Login(ctx, email, password, "127.0.0.1", "test")
	if err != nil {
		t.Fatalf("the provisioned owner could not sign in: %v", err)
	}
	if ident.OperatorID != out.OperatorID {
		t.Fatalf("owner identity is scoped to %q, want the new operator %q", ident.OperatorID, out.OperatorID)
	}
	// OPERATOR_OWNER holds route.write; if the role binding failed, this is false.
	if !ident.Can("route.write") {
		t.Fatalf("the provisioned owner lacks OPERATOR_OWNER permissions (route.write)")
	}
}

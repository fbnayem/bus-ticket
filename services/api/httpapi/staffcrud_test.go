package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

const (
	greenLineDriver = "f0000000-0000-0000-0000-000000000016"
	shohaghOwner    = "f0000000-0000-0000-0000-000000000018"
)

func randSuffix(t *testing.T) string {
	t.Helper()
	var s string
	if err := testPool.QueryRow(context.Background(),
		`SELECT substr(gen_random_uuid()::text,1,8)`).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func postStaff(s *Server, id *staff.Identity, email string, roles []string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(staffCreateRequest{
		Email: email, FullName: "Flow Tester", Phone: "+8801711111111",
		Password: "correct horse battery", Roles: roles,
	})
	rec := httptest.NewRecorder()
	s.handleCreateStaff(rec, httptest.NewRequest("POST", "/api/v1/operator/staff", bytes.NewReader(body)), id)
	return rec
}

// An operator provisions their own people and only operator roles. Granting a
// PLATFORM role to one of their staff would escalate straight out of the
// tenancy, so it must be refused — this is the guard that proves it.
func TestOperatorCannotGrantPlatformRole(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()
	id := ownerID()

	// A normal operator role is fine.
	okEmail := "flowstaff-" + randSuffix(t) + "@greenline.test"
	if rec := postStaff(s, id, okEmail, []string{"DRIVER"}); rec.Code != 201 {
		t.Fatalf("creating a driver should succeed, got %d: %s", rec.Code, rec.Body.String())
	}

	// A platform role is not. Remove the resolveOperatorRoles gate and this
	// returns 201 (with no role granted, because the SQL family filter is a
	// second line of defence) — the 403 is the contract the UI relies on.
	badEmail := "flowstaff-" + randSuffix(t) + "@greenline.test"
	rec := postStaff(s, id, badEmail, []string{"SUPER_ADMIN"})
	if rec.Code != 403 {
		t.Fatalf("granting a PLATFORM role should be forbidden (403), got %d: %s", rec.Code, rec.Body.String())
	}

	// Belt and braces: nobody was ever given SUPER_ADMIN by this operator.
	var escalated int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM staff.user_roles ur
		  JOIN catalog.roles r ON r.role_id = ur.role_id
		  JOIN staff.staff_users u ON u.staff_id = ur.staff_id
		 WHERE r.family <> 'OPERATOR' AND u.operator_id = $1::uuid`, greenLineOperator).Scan(&escalated); err != nil {
		t.Fatal(err)
	}
	if escalated != 0 {
		t.Fatalf("%d Green Line staff hold a non-operator role — escalation happened", escalated)
	}

	_, _ = testPool.Exec(ctx, `DELETE FROM staff.staff_users WHERE email LIKE 'flowstaff-%@greenline.test'`)
}

// A bus is crewed only by its own operator's people. Rostering another
// company's staff onto a trip must be refused.
func TestCrewRosterIsOperatorScoped(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()
	id := ownerID()

	// A Green Line trip on a throwaway route.
	routeID := createRoute(t, s, id, "Crew Route Test")
	busID := greenLineBus(t)
	var tripID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO catalog.trips (operator_id, route_id, bus_id, service_date, depart_at, segment_count, layout_id)
		VALUES ($1::uuid,$2::uuid,$3::uuid, catalog.bd_today(), now() + interval '4 hours', 1,
		        (SELECT layout_id FROM catalog.buses WHERE bus_id=$3::uuid))
		RETURNING trip_id::text`, greenLineOperator, routeID, busID).Scan(&tripID); err != nil {
		t.Fatal(err)
	}

	assign := func(staffID string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(crewAssignRequest{StaffID: staffID, CrewRole: "DRIVER"})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/v1/operator/trips/"+tripID+"/crew", bytes.NewReader(body))
		req.SetPathValue("tripID", tripID)
		s.handleAssignCrew(rec, req, id)
		return rec
	}

	// Green Line's own driver rosters fine.
	if rec := assign(greenLineDriver); rec.Code != 200 {
		t.Fatalf("rostering own driver should succeed, got %d: %s", rec.Code, rec.Body.String())
	}
	// Shohagh's owner does not — remove the staffOp check and this becomes 200.
	if rec := assign(shohaghOwner); rec.Code != 403 {
		t.Fatalf("rostering another operator's staff should be forbidden (403), got %d: %s", rec.Code, rec.Body.String())
	}

	_, _ = testPool.Exec(ctx, `DELETE FROM ops.trip_crew WHERE trip_id=$1::uuid`, tripID)
	_, _ = testPool.Exec(ctx, `DELETE FROM catalog.trips WHERE trip_id=$1::uuid`, tripID)
	_, _ = testPool.Exec(ctx, `DELETE FROM catalog.routes WHERE route_id=$1::uuid`, routeID)
}

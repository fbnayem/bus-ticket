package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/busticket/platform/services/staff/staff"
)

func createDoc(s *Server, id *staff.Identity, req documentRequest) *httptest.ResponseRecorder {
	body, _ := json.Marshal(req)
	rec := httptest.NewRecorder()
	s.handleCreateDocument(rec, httptest.NewRequest("POST", "/api/v1/operator/documents", bytes.NewReader(body)), id)
	return rec
}

func threeExpiryDates(t *testing.T) (past, soon, far string) {
	t.Helper()
	if err := testPool.QueryRow(context.Background(),
		`SELECT (catalog.bd_today()-1)::text, (catalog.bd_today()+10)::text, (catalog.bd_today()+200)::text`).
		Scan(&past, &soon, &far); err != nil {
		t.Fatal(err)
	}
	return
}

// The status of a document is derived from its expiry against Dhaka today, never
// stored — so a document lapses on its own the day it should. This proves the
// three states land on the right side of the two boundaries.
func TestDocumentStatusTracksExpiry(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()
	id := ownerID()
	bus := greenLineBus(t)
	past, soon, far := threeExpiryDates(t)

	cases := []struct {
		num, expires, want string
	}{
		{"DOCTEST-EXPIRED", past, "EXPIRED"},
		{"DOCTEST-EXPIRING", soon, "EXPIRING"},
		{"DOCTEST-VALID", far, "VALID"},
	}
	for _, c := range cases {
		rec := createDoc(s, id, documentRequest{
			BusID: bus, DocType: "FITNESS", DocNumber: c.num, ExpiresOn: c.expires,
		})
		if rec.Code != 201 {
			t.Fatalf("create %s answered %d: %s", c.num, rec.Code, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	s.handleDocuments(rec, httptest.NewRequest("GET", "/api/v1/operator/documents", nil), id)
	var out struct {
		Documents []map[string]any `json:"documents"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	got := map[string]string{}
	for _, d := range out.Documents {
		if num, ok := d["doc_number"].(string); ok {
			if st, ok := d["status"].(string); ok {
				got[num] = st
			}
		}
	}
	for _, c := range cases {
		if got[c.num] != c.want {
			t.Errorf("%s: status %q, want %q", c.num, got[c.num], c.want)
		}
	}

	_, _ = testPool.Exec(ctx, `DELETE FROM compliance.documents WHERE doc_number LIKE 'DOCTEST-%'`)
}

// A vehicle document may only be filed against this operator's own bus.
func TestDocumentRejectsAnotherOperatorsBus(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	s := ownerServer()

	var foreignBus string
	if err := testPool.QueryRow(ctx,
		`SELECT bus_id::text FROM catalog.buses WHERE operator_id=$1::uuid LIMIT 1`, shohaghOperator).
		Scan(&foreignBus); err != nil {
		t.Skipf("no Shohagh bus to test against: %v", err)
	}
	_, soon, _ := threeExpiryDates(t)
	rec := createDoc(s, ownerID(), documentRequest{
		BusID: foreignBus, DocType: "FITNESS", DocNumber: "DOCTEST-HACK", ExpiresOn: soon,
	})
	if rec.Code != 403 {
		t.Fatalf("a document on another operator's bus should be forbidden (403), got %d: %s",
			rec.Code, rec.Body.String())
	}
	_, _ = testPool.Exec(ctx, `DELETE FROM compliance.documents WHERE doc_number LIKE 'DOCTEST-%'`)
}

// A vehicle document names a bus, not a person — filing a fitness certificate
// against a driver is a data error the server must refuse.
func TestVehicleDocNeedsABusNotAPerson(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	_, soon, _ := threeExpiryDates(t)
	rec := createDoc(s, ownerID(), documentRequest{
		StaffID: greenLineDriver, DocType: "FITNESS", DocNumber: "DOCTEST-MISFILED", ExpiresOn: soon,
	})
	if rec.Code != 400 {
		t.Fatalf("a vehicle document against a person should be rejected (400), got %d: %s",
			rec.Code, rec.Body.String())
	}
}

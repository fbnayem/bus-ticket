package httpapi

import (
	"net/http"
	"strings"

	"github.com/busticket/platform/services/staff/staff"
)

// Compliance documents — the papers a bus and its driver must carry, and the
// dates they lapse.
//
// The status of a document is never stored; it is derived from its expiry date
// against Dhaka today every time it is read, so a document that lapses overnight
// is EXPIRED the next morning without anyone touching a row. VALID, EXPIRING
// (within a month) and EXPIRED are the three states the whole feature turns on.

func (s *Server) documentRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/operator/documents", s.guard("compliance.read", s.handleDocuments))
	m.HandleFunc("GET /api/v1/operator/documents/alerts", s.guard("compliance.read", s.handleDocumentAlerts))
	m.HandleFunc("POST /api/v1/operator/documents", s.guard("compliance.write", s.handleCreateDocument))
	m.HandleFunc("PATCH /api/v1/operator/documents/{documentID}", s.guard("compliance.write", s.handleUpdateDocument))
	m.HandleFunc("DELETE /api/v1/operator/documents/{documentID}", s.guard("compliance.write", s.handleDeleteDocument))
}

var vehicleDocTypes = map[string]bool{
	"REGISTRATION": true, "FITNESS": true, "TAX_TOKEN": true,
	"ROUTE_PERMIT": true, "INSURANCE": true,
}
var driverDocTypes = map[string]bool{"DRIVING_LICENSE": true}

type documentRequest struct {
	BusID     string `json:"bus_id"`
	StaffID   string `json:"staff_id"`
	DocType   string `json:"doc_type"`
	DocNumber string `json:"doc_number"`
	IssuedOn  string `json:"issued_on"`
	ExpiresOn string `json:"expires_on"`
	Note      string `json:"note"`
}

// documentSelect is the shared projection: it resolves the subject's readable
// name and derives the status and days-left against Dhaka today.
const documentSelect = `
	SELECT d.document_id::text, d.doc_type, COALESCE(d.doc_number,''),
	       d.issued_on::text, d.expires_on::text,
	       (d.expires_on - catalog.bd_today()) AS days_left,
	       CASE WHEN d.expires_on < catalog.bd_today() THEN 'EXPIRED'
	            WHEN d.expires_on <= catalog.bd_today() + 30 THEN 'EXPIRING'
	            ELSE 'VALID' END AS status,
	       CASE WHEN d.bus_id IS NOT NULL THEN 'BUS' ELSE 'DRIVER' END AS subject_kind,
	       COALESCE(b.registration, u.full_name, '') AS subject,
	       COALESCE(d.note,'')
	  FROM compliance.documents d
	  LEFT JOIN catalog.buses b       ON b.bus_id = d.bus_id
	  LEFT JOIN staff.staff_users u   ON u.staff_id = d.staff_id`

func (s *Server) scanDocuments(rows interface {
	Next() bool
	Scan(...any) error
}) []map[string]any {
	out := []map[string]any{}
	for rows.Next() {
		var docID, docType, docNumber, status, kind, subject, note string
		var issued *string
		var expires string
		var daysLeft int
		if rows.Scan(&docID, &docType, &docNumber, &issued, &expires, &daysLeft,
			&status, &kind, &subject, &note) != nil {
			continue
		}
		out = append(out, map[string]any{
			"document_id": docID, "doc_type": docType, "doc_number": docNumber,
			"issued_on": issued, "expires_on": expires, "days_left": daysLeft,
			"status": status, "subject_kind": kind, "subject": subject, "note": note,
		})
	}
	return out
}

func (s *Server) handleDocuments(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	rows, err := s.pool.Query(r.Context(), documentSelect+`
		 WHERE ($1='' OR d.operator_id=$1::uuid)
		 ORDER BY d.expires_on`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load documents.")
		return
	}
	defer rows.Close()
	writeJSON(w, 200, map[string]any{"documents": s.scanDocuments(rows)})
}

func (s *Server) handleDocumentAlerts(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	// The lapsing and lapsed, soonest first — the list an operator opens on a
	// Monday morning to see what to chase.
	rows, err := s.pool.Query(r.Context(), documentSelect+`
		 WHERE ($1='' OR d.operator_id=$1::uuid)
		   AND d.expires_on <= catalog.bd_today() + 30
		 ORDER BY d.expires_on`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load alerts.")
		return
	}
	defer rows.Close()
	items := s.scanDocuments(rows)
	expired, expiring := 0, 0
	for _, it := range items {
		if it["status"] == "EXPIRED" {
			expired++
		} else {
			expiring++
		}
	}
	writeJSON(w, 200, map[string]any{
		"expired": expired, "expiring": expiring, "items": items,
	})
}

func (s *Server) handleCreateDocument(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A document must belong to an operator.")
		return
	}
	var req documentRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.BusID = strings.TrimSpace(req.BusID)
	req.StaffID = strings.TrimSpace(req.StaffID)
	if req.ExpiresOn == "" {
		fail(w, 400, "bad_expiry", "Enter the date this document expires.")
		return
	}

	// The document type decides its subject: a fitness certificate is a bus's, a
	// licence a driver's. Enforcing that here keeps a route permit from being
	// filed against a person.
	switch {
	case vehicleDocTypes[req.DocType]:
		if req.BusID == "" || req.StaffID != "" {
			fail(w, 400, "bad_subject", "A vehicle document must name a bus and not a person.")
			return
		}
		if !s.ownsBus(r, op, req.BusID) {
			fail(w, 403, "forbidden", "That bus belongs to another operator.")
			return
		}
	case driverDocTypes[req.DocType]:
		if req.StaffID == "" || req.BusID != "" {
			fail(w, 400, "bad_subject", "A driver document must name a person and not a bus.")
			return
		}
		if !s.ownsStaff(r, op, req.StaffID) {
			fail(w, 403, "forbidden", "That person is not on your staff.")
			return
		}
	default:
		fail(w, 400, "bad_type", "That is not a document type this platform tracks.")
		return
	}

	var docID string
	if err := s.pool.QueryRow(r.Context(), `
		INSERT INTO compliance.documents
			(operator_id, bus_id, staff_id, doc_type, doc_number, issued_on, expires_on, note)
		VALUES ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, NULLIF($5,''),
		        NULLIF($6,'')::date, $7::date, NULLIF($8,''))
		RETURNING document_id::text`,
		op, req.BusID, req.StaffID, req.DocType, req.DocNumber, req.IssuedOn, req.ExpiresOn, req.Note).
		Scan(&docID); err != nil {
		s.log.Error("create document", "err", err)
		fail(w, 500, "document_failed", "The document could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "document.create", "document:"+docID, req.DocType)
	writeJSON(w, 201, map[string]any{"document_id": docID})
}

func (s *Server) handleUpdateDocument(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	documentID := r.PathValue("documentID")
	var req documentRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM compliance.documents WHERE document_id=$1::uuid`, documentID).Scan(&owner); err != nil {
		fail(w, 404, "document_not_found", "That document does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That document belongs to another operator.")
		return
	}
	// A renewal updates the papers-in-hand, not the subject: the number, the
	// issue date, the new expiry, the note. The bus or driver it is about never
	// changes — that would be a different document.
	if _, err := s.pool.Exec(r.Context(), `
		UPDATE compliance.documents SET
		   doc_number = COALESCE(NULLIF($2,''), doc_number),
		   issued_on  = COALESCE(NULLIF($3,'')::date, issued_on),
		   expires_on = COALESCE(NULLIF($4,'')::date, expires_on),
		   note       = COALESCE(NULLIF($5,''), note),
		   updated_at = now()
		 WHERE document_id=$1::uuid`,
		documentID, req.DocNumber, req.IssuedOn, req.ExpiresOn, req.Note); err != nil {
		fail(w, 500, "document_failed", "The document could not be updated.")
		return
	}
	s.stf.Audit(r.Context(), id, "document.update", "document:"+documentID, req.ExpiresOn)
	writeJSON(w, 200, map[string]any{"document_id": documentID})
}

func (s *Server) handleDeleteDocument(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	documentID := r.PathValue("documentID")
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM compliance.documents WHERE document_id=$1::uuid`, documentID).Scan(&owner); err != nil {
		fail(w, 404, "document_not_found", "That document does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That document belongs to another operator.")
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM compliance.documents WHERE document_id=$1::uuid`, documentID); err != nil {
		fail(w, 500, "document_failed", "The document could not be removed.")
		return
	}
	s.stf.Audit(r.Context(), id, "document.delete", "document:"+documentID, "")
	writeJSON(w, 200, map[string]any{"document_id": documentID, "deleted": true})
}

func (s *Server) ownsBus(r *http.Request, op, busID string) bool {
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.buses WHERE bus_id=$1::uuid`, busID).Scan(&owner); err != nil {
		return false
	}
	return owner == op
}

func (s *Server) ownsStaff(r *http.Request, op, staffID string) bool {
	var owner *string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM staff.staff_users WHERE staff_id=$1::uuid`, staffID).Scan(&owner); err != nil {
		return false
	}
	return owner != nil && *owner == op
}

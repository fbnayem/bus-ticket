package httpapi

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/staff/staff"
)

// Fleet and seat-layout management — the write side of the catalog an operator
// needs before they can run a single bus of their own.
//
// A seat layout is versioned and becomes immutable the moment a real trip is
// sold against a bus that uses it: a historical ticket must always be readable
// against the seat map that was live when it was bought. So the geometry can be
// shaped freely right up until the first passenger, and never after — to change
// it then, an operator saves a new version and leaves the old one to interpret
// the tickets already sold under it.

func (s *Server) fleetRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/operator/bus-types", s.guard("fleet.read", s.handleBusTypes))
	m.HandleFunc("GET /api/v1/operator/layouts", s.guard("fleet.read", s.handleLayouts))
	m.HandleFunc("GET /api/v1/operator/layouts/{layoutID}", s.guard("fleet.read", s.handleLayout))
	m.HandleFunc("POST /api/v1/operator/layouts", s.guard("fleet.write", s.handleCreateLayout))
	m.HandleFunc("PUT /api/v1/operator/layouts/{layoutID}", s.guard("fleet.write", s.handleUpdateLayout))
	m.HandleFunc("POST /api/v1/operator/buses", s.guard("fleet.write", s.handleCreateBus))
	m.HandleFunc("PATCH /api/v1/operator/buses/{busID}", s.guard("fleet.write", s.handleUpdateBus))
}

// seatTypes is the CHECK on catalog.seat_layout_items, mirrored here so a bad
// value is a clean 400 naming the field rather than a 500 from the database.
var seatTypes = map[string]bool{
	"NORMAL": true, "BUSINESS": true, "SLEEPER": true, "PREMIUM": true,
	"FEMALE_RESERVED": true, "ACCESSIBLE": true, "BLOCKED": true, "CREW": true,
}

var busStatuses = map[string]bool{
	"ACTIVE": true, "MAINTENANCE": true, "OUT_OF_SERVICE": true,
	"RESERVED": true, "DECOMMISSIONED": true,
}

type layoutItem struct {
	SeatNo    string `json:"seat_no"`
	Deck      int    `json:"deck"`
	Row       int    `json:"row_idx"`
	Col       int    `json:"col_idx"`
	SeatType  string `json:"seat_type"`
	FareClass string `json:"fare_class"`
}

type layoutRequest struct {
	Name  string       `json:"name"`
	Decks int          `json:"decks"`
	Seats []layoutItem `json:"seats"`
}

type busRequest struct {
	Registration string `json:"registration"`
	BusTypeID    string `json:"bus_type_id"`
	LayoutID     string `json:"layout_id"`
	Status       string `json:"status"`
}

func (s *Server) handleBusTypes(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rows, err := s.pool.Query(r.Context(),
		`SELECT bus_type_id::text, name, is_ac, class FROM catalog.bus_types ORDER BY name`)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load bus types.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var bid, name, class string
		var isAC bool
		if rows.Scan(&bid, &name, &isAC, &class) != nil {
			continue
		}
		out = append(out, map[string]any{"bus_type_id": bid, "name": name, "is_ac": isAC, "class": class})
	}
	writeJSON(w, 200, map[string]any{"bus_types": out})
}

func (s *Server) handleLayouts(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, r.URL.Query().Get("operator_id"))
	// in_use is the immutability gate: a layout with any trip behind it can no
	// longer be reshaped. It is surfaced so the UI can show a lock rather than
	// offer an edit that the server will refuse.
	rows, err := s.pool.Query(r.Context(), `
		SELECT sl.layout_id::text, sl.name, sl.version, sl.decks, sl.frozen,
		       (SELECT count(*) FROM catalog.seat_layout_items i WHERE i.layout_id = sl.layout_id),
		       (SELECT count(*) FROM catalog.buses b WHERE b.layout_id = sl.layout_id),
		       EXISTS (SELECT 1 FROM catalog.trips t
		                JOIN catalog.buses b ON b.bus_id = t.bus_id
		               WHERE b.layout_id = sl.layout_id)
		  FROM catalog.seat_layouts sl
		 WHERE ($1='' OR sl.operator_id=$1::uuid)
		 ORDER BY sl.name, sl.version`, op)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load layouts.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var lid, name string
		var version, decks, seats, buses int
		var frozen, inUse bool
		if rows.Scan(&lid, &name, &version, &decks, &frozen, &seats, &buses, &inUse) != nil {
			continue
		}
		out = append(out, map[string]any{
			"layout_id": lid, "name": name, "version": version, "decks": decks,
			"seats": seats, "buses": buses, "editable": !frozen && !inUse,
		})
	}
	writeJSON(w, 200, map[string]any{"layouts": out})
}

func (s *Server) handleLayout(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	layoutID := r.PathValue("layoutID")
	var name string
	var version, decks int
	var frozen, inUse bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT sl.name, sl.version, sl.decks, sl.frozen,
		       EXISTS (SELECT 1 FROM catalog.trips t
		                JOIN catalog.buses b ON b.bus_id = t.bus_id
		               WHERE b.layout_id = sl.layout_id)
		  FROM catalog.seat_layouts sl
		 WHERE sl.layout_id=$1::uuid AND ($2='' OR sl.operator_id=$2::uuid)`,
		layoutID, scopeOperator(id, "")).Scan(&name, &version, &decks, &frozen, &inUse); err != nil {
		fail(w, 404, "layout_not_found", "That layout does not exist.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT seat_no, deck, row_idx, col_idx, seat_type, fare_class
		  FROM catalog.seat_layout_items WHERE layout_id=$1::uuid
		 ORDER BY deck, row_idx, col_idx`, layoutID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the seats.")
		return
	}
	defer rows.Close()
	seats := []layoutItem{}
	for rows.Next() {
		var it layoutItem
		if rows.Scan(&it.SeatNo, &it.Deck, &it.Row, &it.Col, &it.SeatType, &it.FareClass) != nil {
			continue
		}
		seats = append(seats, it)
	}
	writeJSON(w, 200, map[string]any{
		"layout_id": layoutID, "name": name, "version": version, "decks": decks,
		"editable": !frozen && !inUse, "seats": seats,
	})
}

// validateSeats checks a proposed seat set and returns a clean message on the
// first problem, so the builder never posts a shape the database will reject.
func validateSeats(req *layoutRequest) string {
	if strings.TrimSpace(req.Name) == "" {
		return "Give the layout a name."
	}
	if len(req.Seats) == 0 {
		return "A layout needs at least one seat."
	}
	if req.Decks < 1 {
		req.Decks = 1
	}
	seen := map[string]bool{}
	for i := range req.Seats {
		it := &req.Seats[i]
		it.SeatNo = strings.TrimSpace(it.SeatNo)
		if it.SeatNo == "" {
			return "Every seat needs a number."
		}
		if seen[it.SeatNo] {
			return "Seat " + it.SeatNo + " appears twice — seat numbers must be unique."
		}
		seen[it.SeatNo] = true
		if it.Deck < 1 {
			it.Deck = 1
		}
		if it.SeatType == "" {
			it.SeatType = "NORMAL"
		}
		if !seatTypes[it.SeatType] {
			return "Unknown seat type " + it.SeatType + " on seat " + it.SeatNo + "."
		}
		if it.FareClass == "" {
			it.FareClass = "BASE"
		}
	}
	return ""
}

func (s *Server) handleCreateLayout(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A layout must belong to an operator.")
		return
	}
	var req layoutRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if msg := validateSeats(&req); msg != "" {
		fail(w, 400, "bad_layout", msg)
		return
	}

	// A new name starts at version 1; reusing a name makes the next version, so
	// the UNIQUE(operator, name, version) constraint is never fought.
	var version int
	_ = s.pool.QueryRow(r.Context(),
		`SELECT COALESCE(max(version),0)+1 FROM catalog.seat_layouts WHERE operator_id=$1::uuid AND name=$2`,
		op, req.Name).Scan(&version)

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck

	var layoutID string
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO catalog.seat_layouts (operator_id, name, version, decks)
		VALUES ($1::uuid,$2,$3,$4) RETURNING layout_id::text`,
		op, req.Name, version, req.Decks).Scan(&layoutID); err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	if err := insertSeats(r, tx, layoutID, req.Seats); err != nil {
		fail(w, 500, "layout_failed", "The seats could not be saved.")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "layout.create", "layout:"+layoutID, req.Name)
	writeJSON(w, 201, map[string]any{"layout_id": layoutID, "name": req.Name, "version": version, "seats": len(req.Seats)})
}

func (s *Server) handleUpdateLayout(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	layoutID := r.PathValue("layoutID")
	var req layoutRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if msg := validateSeats(&req); msg != "" {
		fail(w, 400, "bad_layout", msg)
		return
	}

	// Ownership and the immutability gate in one read: the layout must be this
	// operator's, and it must not yet carry a sold trip.
	var owner string
	var frozen, inUse bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT operator_id::text, frozen,
		       EXISTS (SELECT 1 FROM catalog.trips t
		                JOIN catalog.buses b ON b.bus_id = t.bus_id
		               WHERE b.layout_id = $1::uuid)
		  FROM catalog.seat_layouts WHERE layout_id=$1::uuid`, layoutID).
		Scan(&owner, &frozen, &inUse); err != nil {
		fail(w, 404, "layout_not_found", "That layout does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That layout belongs to another operator.")
		return
	}
	if frozen || inUse {
		fail(w, 409, "layout_locked",
			"This layout has already carried passengers, so its seats can't be changed. Save it as a new layout instead.")
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if _, err := tx.Exec(r.Context(),
		`UPDATE catalog.seat_layouts SET name=$2, decks=$3 WHERE layout_id=$1::uuid`,
		layoutID, req.Name, req.Decks); err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM catalog.seat_layout_items WHERE layout_id=$1::uuid`, layoutID); err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	if err := insertSeats(r, tx, layoutID, req.Seats); err != nil {
		fail(w, 500, "layout_failed", "The seats could not be saved.")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, 500, "layout_failed", "The layout could not be saved.")
		return
	}
	s.stf.Audit(r.Context(), id, "layout.update", "layout:"+layoutID, req.Name)
	writeJSON(w, 200, map[string]any{"layout_id": layoutID, "name": req.Name, "seats": len(req.Seats)})
}

// insertSeats bulk-loads a layout's seats inside the caller's transaction.
func insertSeats(r *http.Request, tx pgx.Tx, layoutID string, seats []layoutItem) error {
	for _, it := range seats {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO catalog.seat_layout_items
				(layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
			VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
			layoutID, it.SeatNo, it.Deck, it.Row, it.Col, it.SeatType, it.FareClass); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleCreateBus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	op := scopeOperator(id, "")
	if op == "" {
		fail(w, 400, "operator_required", "A bus must belong to an operator.")
		return
	}
	var req busRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	req.Registration = strings.TrimSpace(req.Registration)
	if req.Registration == "" {
		fail(w, 400, "bad_registration", "Enter the bus registration.")
		return
	}
	if req.Status == "" {
		req.Status = "ACTIVE"
	}
	if !busStatuses[req.Status] {
		fail(w, 400, "bad_status", "That is not a valid bus status.")
		return
	}
	// The layout must be this operator's own — a tenant may not pin a bus to
	// another operator's seat map. The bus type is a shared catalog, so it is
	// only checked to exist.
	var layoutOwner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.seat_layouts WHERE layout_id=$1::uuid`, req.LayoutID).
		Scan(&layoutOwner); err != nil {
		fail(w, 400, "layout_not_found", "Choose a seat layout for this bus.")
		return
	}
	if layoutOwner != op {
		fail(w, 403, "forbidden", "That seat layout belongs to another operator.")
		return
	}

	var busID string
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO catalog.buses (operator_id, registration, bus_type_id, layout_id, status)
		VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5) RETURNING bus_id::text`,
		op, req.Registration, req.BusTypeID, req.LayoutID, req.Status).Scan(&busID)
	if err != nil {
		if strings.Contains(err.Error(), "buses_operator_id_registration_key") {
			fail(w, 409, "duplicate_registration", "A bus with that registration already exists.")
			return
		}
		if strings.Contains(err.Error(), "bus_type_id") {
			fail(w, 400, "bus_type_not_found", "Choose a bus type.")
			return
		}
		s.log.Error("create bus", "err", err)
		fail(w, 500, "bus_failed", "The bus could not be added.")
		return
	}
	s.stf.Audit(r.Context(), id, "bus.create", "bus:"+busID, req.Registration)
	writeJSON(w, 201, map[string]any{"bus_id": busID, "registration": req.Registration, "status": req.Status})
}

func (s *Server) handleUpdateBus(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	busID := r.PathValue("busID")
	var req busRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	var owner string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT operator_id::text FROM catalog.buses WHERE bus_id=$1::uuid`, busID).Scan(&owner); err != nil {
		fail(w, 404, "bus_not_found", "That bus does not exist.")
		return
	}
	if id.OperatorID != "" && id.OperatorID != owner {
		fail(w, 403, "forbidden", "That bus belongs to another operator.")
		return
	}
	if req.Status != "" && !busStatuses[req.Status] {
		fail(w, 400, "bad_status", "That is not a valid bus status.")
		return
	}
	// A layout change may only point at one of this operator's layouts, and only
	// affects trips generated from now on; trips already sold keep the seat map
	// they were opened with.
	if req.LayoutID != "" {
		var layoutOwner string
		if err := s.pool.QueryRow(r.Context(),
			`SELECT operator_id::text FROM catalog.seat_layouts WHERE layout_id=$1::uuid`, req.LayoutID).
			Scan(&layoutOwner); err != nil || layoutOwner != owner {
			fail(w, 403, "forbidden", "That seat layout belongs to another operator.")
			return
		}
	}
	if _, err := s.pool.Exec(r.Context(), `
		UPDATE catalog.buses SET
		   registration = COALESCE(NULLIF($2,''), registration),
		   bus_type_id  = COALESCE(NULLIF($3,'')::uuid, bus_type_id),
		   layout_id    = COALESCE(NULLIF($4,'')::uuid, layout_id),
		   status       = COALESCE(NULLIF($5,''), status)
		 WHERE bus_id=$1::uuid`,
		busID, strings.TrimSpace(req.Registration), req.BusTypeID, req.LayoutID, req.Status); err != nil {
		if strings.Contains(err.Error(), "buses_operator_id_registration_key") {
			fail(w, 409, "duplicate_registration", "A bus with that registration already exists.")
			return
		}
		fail(w, 500, "bus_failed", "The bus could not be updated.")
		return
	}
	s.stf.Audit(r.Context(), id, "bus.update", "bus:"+busID, req.Status)
	writeJSON(w, 200, map[string]any{"bus_id": busID})
}

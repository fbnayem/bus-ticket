package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/searchidx/searchidx"
)

// Discovery endpoints: locations, search, trip detail, seat map, offers.
//
// Search no longer reads the transactional tables. It goes to the projection
// maintained by the search indexer from the event stream, fronted by the Redis
// result cache — the plan's trips -> events -> index -> cache -> customer
// pipeline (workstream P1-G), with a PostgreSQL projection standing in for
// OpenSearch. Search may be stale, and says how stale in every response; the
// seat map and every hold still go to inventory-service, which may not be.

type locationDTO struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	NameBn string `json:"name_bn"`
	Kind   string `json:"kind"`
	Parent string `json:"parent"`
	Served bool   `json:"served"`
}

// GET /api/v1/locations?q=&limit=
//
// The suggestion source behind every place field in the product. It answers
// with the name in both languages and the district above it, because the
// client should never have to guess how to label a place, and never has to
// hold a copy of the gazetteer to do it.
func (s *Server) handleLocations(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	locs, err := s.idx.Suggest(r.Context(), r.URL.Query().Get("q"), limit)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load locations.")
		return
	}
	out := make([]locationDTO, 0, len(locs))
	for _, l := range locs {
		out = append(out, locationDTO{
			ID: l.ID, Name: l.Name, NameBn: l.NameBn,
			Kind: l.Kind, Parent: l.Parent, Served: l.Served,
		})
	}
	writeJSON(w, 200, map[string]any{"locations": out})
}

// resolveLocation turns whatever the passenger typed into a canonical id, out
// of the locations index rather than a LIKE scan of the catalog.
func (s *Server) resolveLocation(r *http.Request, input string) (string, string, error) {
	return s.idx.ResolveLocation(r.Context(), input)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fromID, _, err := s.resolveLocation(r, q.Get("from"))
	if err != nil {
		fail(w, 400, "unknown_origin", "We don't recognise that departure city.")
		return
	}
	toID, _, err := s.resolveLocation(r, q.Get("to"))
	if err != nil {
		fail(w, 400, "unknown_destination", "We don't recognise that destination city.")
		return
	}
	if fromID == toID {
		fail(w, 400, "same_city", "Departure and destination must be different.")
		return
	}
	dateStr := q.Get("date")
	if dateStr == "" {
		dateStr = dhakaToday()
	}
	if _, err := time.Parse("2006-01-02", dateStr); err != nil {
		fail(w, 400, "bad_date", "Travel date must look like 2026-08-20.")
		return
	}

	res, err := s.idx.Query(r.Context(), searchidx.Params{
		OriginID:      fromID,
		DestID:        toID,
		Date:          dateStr,
		Operator:      q.Get("operator"),
		ACOnly:        q.Get("ac") == "true",
		MaxFarePoisha: int64(queryInt(r, "max_fare_poisha", 0)),
		DepartFrom:    q.Get("depart_from"),
		DepartTo:      q.Get("depart_to"),
		Sort:          q.Get("sort"),
		Passengers:    queryInt(r, "passengers", 1),
	})
	if err != nil {
		s.log.Error("search failed", "err", err)
		fail(w, 500, "search_failed", "Search is temporarily unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{
		"origin": res.Origin, "destination": res.Destination, "date": res.Date,
		"count": res.Count, "results": res.Results,
		// Stated rather than hidden: how old the projection was, and whether
		// this page came out of the cache.
		"index_age_seconds": res.IndexAgeSec, "cached": res.Cached,
	})
}

type stopDTO struct {
	Seq  int       `json:"seq"`
	Name string    `json:"name"`
	At   time.Time `json:"at"`
}

// arrivalAt is the wall-clock time the bus reaches stop `seq`, given the origin
// departure and the per-segment running minutes (offsets[k] spans stop k -> k+1,
// indexed by from_stop_seq). This is the single source of truth for "when does
// THIS passenger's bus reach THEIR stop" — an intercity bus that leaves Dhaka at
// 22:00 does not reach Feni until hours later, and a mid-route passenger must be
// told their own boarding time, never the origin's.
func arrivalAt(depart time.Time, offsets map[int]int, seq int) time.Time {
	var m int
	for i := 0; i < seq; i++ {
		m += offsets[i]
	}
	return depart.Add(time.Duration(m) * time.Minute)
}

func (s *Server) handleTrip(w http.ResponseWriter, r *http.Request) {
	tripID := r.PathValue("tripID")
	board := queryInt(r, "board", 0)
	drop := queryInt(r, "drop", 0)

	var out struct {
		TripID      string    `json:"trip_id"`
		Brand       string    `json:"brand"`
		OperatorID  string    `json:"operator_id"`
		BusType     string    `json:"bus_type"`
		IsAC        bool      `json:"is_ac"`
		Class       string    `json:"class"`
		Registration string   `json:"registration"`
		RouteName   string    `json:"route_name"`
		DepartAt    time.Time `json:"depart_at"`
		SegmentCount int      `json:"segment_count"`
		Amenities   []string  `json:"amenities"`
		Stops       []stopDTO `json:"stops"`
		FarePoisha  int64     `json:"fare_poisha"`
		BoardSeq    int       `json:"board_seq"`
		DropSeq     int       `json:"drop_seq"`
		DurationMin int       `json:"duration_min"`
	}
	var routeID string
	err := s.pool.QueryRow(r.Context(), `
		SELECT t.trip_id::text, o.brand, o.operator_id::text, bt.name, bt.is_ac, bt.class,
		       b.registration, rt.name, t.depart_at, t.segment_count, t.route_id::text,
		       COALESCE((SELECT array_agg(am.amenity ORDER BY am.amenity)
		                   FROM catalog.bus_amenities am WHERE am.bus_id = t.bus_id), '{}')
		  FROM catalog.trips t
		  JOIN catalog.operators o  ON o.operator_id = t.operator_id
		  JOIN catalog.buses b      ON b.bus_id = t.bus_id
		  JOIN catalog.bus_types bt ON bt.bus_type_id = b.bus_type_id
		  JOIN catalog.routes rt    ON rt.route_id = t.route_id
		 WHERE t.trip_id = $1::uuid`, tripID).
		Scan(&out.TripID, &out.Brand, &out.OperatorID, &out.BusType, &out.IsAC, &out.Class,
			&out.Registration, &out.RouteName, &out.DepartAt, &out.SegmentCount, &routeID, &out.Amenities)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "trip_not_found", "That trip no longer exists.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the trip.")
		return
	}
	if drop == 0 {
		drop = out.SegmentCount
	}
	out.BoardSeq, out.DropSeq = board, drop

	rows, err := s.pool.Query(r.Context(), `
		SELECT rs.stop_seq, l.name,
		       COALESCE((SELECT sum(m.minutes) FROM catalog.route_segment_minutes m
		                  WHERE m.route_id = rs.route_id AND m.from_stop_seq < rs.stop_seq), 0)
		  FROM catalog.route_stops rs
		  JOIN catalog.locations l ON l.location_id = rs.location_id
		 WHERE rs.route_id = $1::uuid ORDER BY rs.stop_seq`, routeID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var st stopDTO
			var offset int
			if err := rows.Scan(&st.Seq, &st.Name, &offset); err == nil {
				st.At = out.DepartAt.Add(time.Duration(offset) * time.Minute)
				out.Stops = append(out.Stops, st)
			}
		}
	}

	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(amount_poisha,0) FROM catalog.route_fares
		 WHERE route_id=$1::uuid AND from_stop_seq=$2 AND to_stop_seq=$3
		 ORDER BY version DESC LIMIT 1`,
		routeID, board, drop).Scan(&out.FarePoisha)
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(sum(minutes),0) FROM catalog.route_segment_minutes
		 WHERE route_id=$1::uuid AND from_stop_seq>=$2 AND from_stop_seq<$3`,
		routeID, board, drop).Scan(&out.DurationMin)

	writeJSON(w, 200, out)
}

type seatDTO struct {
	SeatNo    string `json:"seat_no"`
	Type      string `json:"seat_type"`
	Deck      int    `json:"deck"`
	Row       int    `json:"row"`
	Col       int    `json:"col"`
	Available bool   `json:"available"`
	Sold      bool   `json:"sold"`
	Held      bool   `json:"held"`
	Blocked   bool   `json:"blocked"`
}

func (s *Server) handleSeatMap(w http.ResponseWriter, r *http.Request) {
	tripID := r.PathValue("tripID")
	board := queryInt(r, "board", 0)
	drop := queryInt(r, "drop", 0)

	var segCount int
	if err := s.pool.QueryRow(r.Context(),
		`SELECT segment_count FROM inventory.trip_inventory WHERE trip_id=$1::uuid`, tripID).
		Scan(&segCount); err != nil {
		fail(w, 404, "trip_not_found", "That trip no longer exists.")
		return
	}
	if drop == 0 {
		drop = segCount
	}
	mask, err := inventoryMask(board, drop)
	if err != nil {
		fail(w, 400, "bad_segments", "That boarding and dropping combination is not valid.")
		return
	}

	rows, err := s.pool.Query(r.Context(), `
		SELECT seat_no, seat_type, deck, row_idx, col_idx,
		       (segment_sold_mask & $2) <> 0,
		       (segment_hold_mask & $2) <> 0,
		       (blocked_mask      & $2) <> 0
		  FROM inventory.trip_seats
		 WHERE trip_id = $1::uuid
		 ORDER BY deck, row_idx, col_idx`, tripID, mask)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the seat map.")
		return
	}
	defer rows.Close()

	seats := []seatDTO{}
	for rows.Next() {
		var d seatDTO
		if err := rows.Scan(&d.SeatNo, &d.Type, &d.Deck, &d.Row, &d.Col, &d.Sold, &d.Held, &d.Blocked); err != nil {
			fail(w, 500, "scan_failed", "Could not load the seat map.")
			return
		}
		d.Available = !d.Sold && !d.Held && !d.Blocked
		seats = append(seats, d)
	}
	writeJSON(w, 200, map[string]any{
		"trip_id": tripID, "segment_count": segCount,
		"board_seq": board, "drop_seq": drop, "seats": seats,
	})
}

func (s *Server) handleOffers(w http.ResponseWriter, r *http.Request) {
	offers, err := s.promo.Offers(r.Context())
	if err != nil {
		fail(w, 500, "query_failed", "Could not load offers.")
		return
	}
	writeJSON(w, 200, map[string]any{"offers": offers})
}

// Package searchidx is the search pipeline (plan workstream P1-G): an indexer
// that maintains a denormalised read model from the event stream, and a query
// side that reads that read model and nothing else.
//
// The plan's target is trips -> Kafka -> OpenSearch -> Redis. OpenSearch is not
// running in this build, so the same denormalised document lives in
// search.trip_legs, fed by the same events. The property worth having either
// way is the one enforced here: Query touches search.trip_legs and the Redis
// cache, and no other table in the platform. Killing the projection degrades
// search; it cannot corrupt a booking. Search may be stale. Inventory may not —
// which is why the seat map and every hold still go to inventory-service.
package searchidx

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Cache is the Redis result cache. A nil Cache means every search is a database
// query, which is slower and equally correct.
type Cache interface {
	Get(ctx context.Context, key string) (string, bool)
	Set(ctx context.Context, key, value string, ttl time.Duration)
	DelPrefix(ctx context.Context, prefix string) int
}

type Indexer struct {
	pool  *pgxpool.Pool
	cache Cache
}

func New(pool *pgxpool.Pool, cache Cache) *Indexer { return &Indexer{pool: pool, cache: cache} }

const cachePrefix = "search:"

// The projection query. It is the only place in the search pipeline that reads
// catalog and inventory tables, and it runs on the write side — an indexer, not
// a request.
const projectSQL = `
WITH cum AS (
    SELECT rs.route_id, rs.stop_seq,
           COALESCE((SELECT sum(m.minutes) FROM catalog.route_segment_minutes m
                      WHERE m.route_id = rs.route_id AND m.from_stop_seq < rs.stop_seq), 0)::int AS off_min
      FROM catalog.route_stops rs
)
INSERT INTO search.trip_legs (
    trip_id, board_seq, drop_seq, origin_id, dest_id, origin_name, dest_name,
    service_date, depart_at, arrive_at, duration_min,
    operator_id, operator_brand, route_id, route_name,
    bus_type, class, registration, is_ac, amenities,
    fare_poisha, seats_total, seats_free, status, indexed_at)
SELECT t.trip_id, f.stop_seq, d.stop_seq, f.location_id, d.location_id, lf.name, ld.name,
       t.service_date,
       t.depart_at + make_interval(mins => cf.off_min),
       t.depart_at + make_interval(mins => cd.off_min),
       cd.off_min - cf.off_min,
       t.operator_id, o.brand, t.route_id, rt.name,
       bt.name, bt.class, b.registration, bt.is_ac,
       COALESCE((SELECT array_agg(am.amenity ORDER BY am.amenity)
                   FROM catalog.bus_amenities am WHERE am.bus_id = t.bus_id), '{}'),
       COALESCE(fare.amount_poisha, 0),
       inv.seat_count,
       (SELECT count(*) FROM inventory.trip_seats ts
         WHERE ts.trip_id = t.trip_id
           AND ((ts.segment_sold_mask | ts.segment_hold_mask | ts.blocked_mask)
                & ((1::bigint << d.stop_seq) - (1::bigint << f.stop_seq))) = 0),
       t.status, now()
  FROM catalog.trips t
  JOIN catalog.route_stops f  ON f.route_id = t.route_id AND f.is_boarding
  JOIN catalog.route_stops d  ON d.route_id = t.route_id AND d.is_dropping AND d.stop_seq > f.stop_seq
  JOIN cum cf ON cf.route_id = t.route_id AND cf.stop_seq = f.stop_seq
  JOIN cum cd ON cd.route_id = t.route_id AND cd.stop_seq = d.stop_seq
  JOIN catalog.locations lf   ON lf.location_id = f.location_id
  JOIN catalog.locations ld   ON ld.location_id = d.location_id
  JOIN catalog.operators o    ON o.operator_id = t.operator_id
  JOIN catalog.routes rt      ON rt.route_id = t.route_id
  JOIN catalog.buses b        ON b.bus_id = t.bus_id
  JOIN catalog.bus_types bt   ON bt.bus_type_id = b.bus_type_id
  JOIN inventory.trip_inventory inv ON inv.trip_id = t.trip_id
  LEFT JOIN catalog.route_fares fare ON fare.route_id = t.route_id
        AND fare.from_stop_seq = f.stop_seq AND fare.to_stop_seq = d.stop_seq
 WHERE ($1::uuid IS NULL OR t.trip_id = $1::uuid)
   AND ($1::uuid IS NOT NULL OR t.service_date BETWEEN catalog.bd_today() AND catalog.bd_today() + $2::int)
ON CONFLICT (trip_id, board_seq, drop_seq) DO UPDATE SET
    depart_at   = EXCLUDED.depart_at,
    arrive_at   = EXCLUDED.arrive_at,
    fare_poisha = EXCLUDED.fare_poisha,
    seats_total = EXCLUDED.seats_total,
    seats_free  = EXCLUDED.seats_free,
    status      = EXCLUDED.status,
    amenities   = EXCLUDED.amenities,
    indexed_at  = now()`

// Reindex rebuilds the projection for every trip inside the horizon. It runs at
// startup and after trip generation; steady state is event-driven.
func (ix *Indexer) Reindex(ctx context.Context, horizonDays int) (int64, error) {
	ct, err := ix.pool.Exec(ctx, projectSQL, nil, horizonDays)
	if err != nil {
		return 0, err
	}
	if err := ix.reindexLocations(ctx); err != nil {
		return 0, err
	}
	_, _ = ix.pool.Exec(ctx, `
		UPDATE search.index_state
		   SET last_full_at = now(), legs_indexed = (SELECT count(*) FROM search.trip_legs)
		 WHERE id = 1`)
	ix.invalidate(ctx)
	return ct.RowsAffected(), nil
}

// IndexTrip refreshes one trip. This is what a trip.* event triggers.
func (ix *Indexer) IndexTrip(ctx context.Context, tripID string) error {
	if _, err := ix.pool.Exec(ctx, projectSQL, tripID, 0); err != nil {
		return err
	}
	_, _ = ix.pool.Exec(ctx, `UPDATE search.index_state SET last_event_at = now() WHERE id = 1`)
	ix.invalidate(ctx)
	return nil
}

// TouchAvailability recomputes only the free-seat counts for one trip. Seat
// events fire constantly, and re-running the whole projection for each one
// would be wasteful — the expensive joins have not changed, only the counts.
func (ix *Indexer) TouchAvailability(ctx context.Context, tripID string) error {
	if _, err := ix.pool.Exec(ctx, `
		UPDATE search.trip_legs l
		   SET seats_free = (
		         SELECT count(*) FROM inventory.trip_seats ts
		          WHERE ts.trip_id = l.trip_id
		            AND ((ts.segment_sold_mask | ts.segment_hold_mask | ts.blocked_mask)
		                 & ((1::bigint << l.drop_seq) - (1::bigint << l.board_seq))) = 0),
		       indexed_at = now()
		 WHERE l.trip_id = $1::uuid`, tripID); err != nil {
		return err
	}
	_, _ = ix.pool.Exec(ctx, `UPDATE search.index_state SET last_event_at = now() WHERE id = 1`)
	ix.invalidate(ctx)
	return nil
}

// SetTripStatus mirrors a trip lifecycle change into the projection so a
// cancelled trip stops appearing in results immediately.
func (ix *Indexer) SetTripStatus(ctx context.Context, tripID, status string) error {
	_, err := ix.pool.Exec(ctx,
		`UPDATE search.trip_legs SET status = $2, indexed_at = now() WHERE trip_id = $1::uuid`,
		tripID, status)
	ix.invalidate(ctx)
	return err
}

// invalidate drops the cached result pages. It is deliberately blunt: a trip
// changing could affect any search that might have included it, and serving a
// stale seat count is worse than recomputing a page.
func (ix *Indexer) invalidate(ctx context.Context) {
	if ix.cache != nil {
		ix.cache.DelPrefix(ctx, cachePrefix)
	}
}

func (ix *Indexer) reindexLocations(ctx context.Context) error {
	if _, err := ix.pool.Exec(ctx, `
		INSERT INTO search.location_index (location_id, name, kind, aliases, search_blob, indexed_at)
		SELECT l.location_id, l.name, l.kind,
		       COALESCE(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}'),
		       lower(l.name || ' ' || COALESCE(string_agg(a.alias, ' '), '')),
		       now()
		  FROM catalog.locations l
		  LEFT JOIN catalog.location_aliases a ON a.location_id = l.location_id
		 WHERE l.kind IN ('CITY','TERMINAL')
		 GROUP BY l.location_id, l.name, l.kind
		ON CONFLICT (location_id) DO UPDATE
		   SET aliases = EXCLUDED.aliases, search_blob = EXCLUDED.search_blob, indexed_at = now()`); err != nil {
		return err
	}
	_, err := ix.pool.Exec(ctx, `
		UPDATE search.location_index li
		   SET trips_from = COALESCE((SELECT count(DISTINCT trip_id) FROM search.trip_legs
		                               WHERE origin_id = li.location_id
		                                 AND service_date >= catalog.bd_today()), 0)`)
	return err
}

// ------------------------------------------------------------------- query --

type Params struct {
	OriginID, DestID string
	Date             string
	Operator         string
	ACOnly           bool
	MaxFarePoisha    int64
	DepartFrom       string // "HH:MM"
	DepartTo         string
	Sort             string // recommended | price | departure | duration | availability
	Passengers       int
}

type Result struct {
	TripID       string    `json:"trip_id"`
	OperatorID   string    `json:"operator_id"`
	Brand        string    `json:"brand"`
	BusType      string    `json:"bus_type"`
	IsAC         bool      `json:"is_ac"`
	Class        string    `json:"class"`
	Registration string    `json:"registration"`
	DepartAt     time.Time `json:"depart_at"`
	ArriveAt     time.Time `json:"arrive_at"`
	DurationMin  int       `json:"duration_min"`
	BoardSeq     int       `json:"board_seq"`
	DropSeq      int       `json:"drop_seq"`
	Origin       string    `json:"origin"`
	Destination  string    `json:"destination"`
	FarePoisha   int64     `json:"fare_poisha"`
	Available    int       `json:"available_seats"`
	TotalSeats   int       `json:"total_seats"`
	Amenities    []string  `json:"amenities"`
}

type Response struct {
	Origin      string   `json:"origin"`
	Destination string   `json:"destination"`
	Date        string   `json:"date"`
	Count       int      `json:"count"`
	Results     []Result `json:"results"`
	// Honest metadata rather than a claim: how old the projection is, and
	// whether this page came out of Redis.
	IndexAgeSec int  `json:"index_age_seconds"`
	Cached      bool `json:"cached"`
}

func (p Params) cacheKey() string {
	return fmt.Sprintf("%s%s|%s|%s|%s|%t|%d|%s|%s|%s|%d",
		cachePrefix, p.OriginID, p.DestID, p.Date, p.Operator, p.ACOnly,
		p.MaxFarePoisha, p.DepartFrom, p.DepartTo, p.Sort, p.Passengers)
}

// Query answers a search from the projection. Nothing else is consulted.
func (ix *Indexer) Query(ctx context.Context, p Params) (*Response, error) {
	key := p.cacheKey()
	if ix.cache != nil {
		if blob, ok := ix.cache.Get(ctx, key); ok {
			var cached Response
			if json.Unmarshal([]byte(blob), &cached) == nil {
				cached.Cached = true
				return &cached, nil
			}
		}
	}

	order := "l.depart_at"
	switch p.Sort {
	case "price":
		order = "l.fare_poisha, l.depart_at"
	case "duration":
		order = "l.duration_min, l.depart_at"
	case "availability":
		order = "l.seats_free DESC, l.depart_at"
	case "recommended":
		// Cheap and full beats cheap and nearly sold out.
		order = "(l.fare_poisha - l.seats_free * 500), l.depart_at"
	}

	need := p.Passengers
	if need < 1 {
		need = 1
	}

	q := `
		SELECT l.trip_id::text, l.operator_id::text, l.operator_brand, l.bus_type, l.is_ac,
		       l.class, l.registration, l.depart_at, l.arrive_at, l.duration_min,
		       l.board_seq, l.drop_seq, l.origin_name, l.dest_name,
		       l.fare_poisha, l.seats_free, l.seats_total, l.amenities,
		       EXTRACT(EPOCH FROM (now() - l.indexed_at))::int
		  FROM search.trip_legs l
		 WHERE l.origin_id = $1::uuid AND l.dest_id = $2::uuid
		   AND l.service_date = $3::date
		   AND l.status IN ('SCHEDULED','OPEN','BOARDING')
		   AND l.seats_free >= $4
		   AND ($5 = '' OR l.operator_id::text = $5)
		   AND (NOT $6 OR l.is_ac)
		   AND ($7::bigint = 0 OR l.fare_poisha <= $7)
		   AND ($8 = '' OR to_char(l.depart_at AT TIME ZONE 'Asia/Dhaka','HH24:MI') >= $8)
		   AND ($9 = '' OR to_char(l.depart_at AT TIME ZONE 'Asia/Dhaka','HH24:MI') <= $9)
		 ORDER BY ` + order + `
		 LIMIT 100`

	rows, err := ix.pool.Query(ctx, q, p.OriginID, p.DestID, p.Date, need,
		p.Operator, p.ACOnly, p.MaxFarePoisha, p.DepartFrom, p.DepartTo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := Response{Date: p.Date, Results: []Result{}}
	maxAge := 0
	for rows.Next() {
		var r Result
		var age int
		if err := rows.Scan(&r.TripID, &r.OperatorID, &r.Brand, &r.BusType, &r.IsAC,
			&r.Class, &r.Registration, &r.DepartAt, &r.ArriveAt, &r.DurationMin,
			&r.BoardSeq, &r.DropSeq, &r.Origin, &r.Destination,
			&r.FarePoisha, &r.Available, &r.TotalSeats, &r.Amenities, &age); err != nil {
			return nil, err
		}
		if age > maxAge {
			maxAge = age
		}
		out.Origin, out.Destination = r.Origin, r.Destination
		out.Results = append(out.Results, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.Count = len(out.Results)
	out.IndexAgeSec = maxAge

	if ix.cache != nil {
		if blob, err := json.Marshal(out); err == nil {
			// Short TTL as a floor. Event-driven invalidation is what normally
			// clears this; the TTL only bounds how wrong a search can be if the
			// indexer itself has stopped.
			ix.cache.Set(ctx, key, string(blob), 30*time.Second)
		}
	}
	return &out, nil
}

// ResolveLocation canonicalises whatever the passenger typed, out of the
// locations index. "CTG", "Chittagong" and "chattogram" all land on one id.
func (ix *Indexer) ResolveLocation(ctx context.Context, input string) (id, name string, err error) {
	n := strings.ToLower(strings.TrimSpace(input))
	err = ix.pool.QueryRow(ctx, `
		SELECT location_id::text, name FROM search.location_index
		 WHERE lower(name) = $1 OR $1 = ANY(aliases) OR location_id::text = $1
		 ORDER BY (lower(name) = $1) DESC LIMIT 1`, n).Scan(&id, &name)
	return id, name, err
}

type Location struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func (ix *Indexer) Locations(ctx context.Context, q string) ([]Location, error) {
	n := strings.ToLower(strings.TrimSpace(q))
	rows, err := ix.pool.Query(ctx, `
		SELECT location_id::text, name, kind FROM search.location_index
		 WHERE $1 = '' OR search_blob LIKE '%'||$1||'%'
		 ORDER BY trips_from DESC, name LIMIT 25`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Location{}
	for rows.Next() {
		var l Location
		if err := rows.Scan(&l.ID, &l.Name, &l.Kind); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

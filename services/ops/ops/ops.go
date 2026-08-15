// Package ops is the operations control centre (plan workstream P2-J): the
// seven alert types, and the replacement-bus flow with its seat remap.
//
// The detector is deliberately a scanner rather than a stream processor. Six of
// the seven alerts are about something that did NOT happen — a bus that did not
// depart, a fix that did not arrive, a stop that did not end — and absence does
// not produce an event. A periodic pass over live trips is the honest shape for
// that; the two alerts that ARE events (a cancellation, a breakdown) are raised
// from the event stream instead.
package ops

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SeatMover is the seam to inventory-service. The control centre decides which
// seat a displaced passenger should get; it is never allowed to decide whether
// taking that seat is safe.
type SeatMover interface {
	Reassign(ctx context.Context, holdID, oldSeat, newSeat string) error
	WithdrawSeat(ctx context.Context, tripID, seatNo string) error
	AddSeats(ctx context.Context, tripID string, seats []SeatSpec) (int, error)
	FreeSeats(ctx context.Context, tripID string, boardSeq, dropSeq int) ([]string, error)
	SeatsFromLayout(ctx context.Context, layoutID string) ([]SeatSpec, error)
}

// SeatSpec mirrors inventory.SeatSpec across the interface boundary.
type SeatSpec struct {
	SeatNo    string
	SeatType  string
	FareClass string
	Deck      int
	Row       int
	Col       int
}

type Service struct {
	pool *pgxpool.Pool
	inv  SeatMover
}

func New(pool *pgxpool.Pool, inv SeatMover) *Service { return &Service{pool: pool, inv: inv} }

// ------------------------------------------------------------ the detector --

// Thresholds are fields rather than constants so an operator can be given
// different tolerances later without a code change.
type Thresholds struct {
	LateDepartureMin int
	GPSSilenceMin    int
	LongStopMin      int
	DeviationMetres  float64
	StoppedSpeedKph  float64
}

func DefaultThresholds() Thresholds {
	return Thresholds{
		LateDepartureMin: 15,
		GPSSilenceMin:    3,
		LongStopMin:      20,
		DeviationMetres:  5000,
		StoppedSpeedKph:  3,
	}
}

// Scan raises and clears alerts for every live trip. Returns how many alerts
// are currently open.
func (s *Service) Scan(ctx context.Context, th Thresholds) (int, error) {
	if err := s.scanLateDeparture(ctx, th); err != nil {
		return 0, err
	}
	if err := s.scanGPSOffline(ctx, th); err != nil {
		return 0, err
	}
	if err := s.scanStops(ctx, th); err != nil {
		return 0, err
	}
	if err := s.scanDeviation(ctx, th); err != nil {
		return 0, err
	}
	var open int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM ops.alerts WHERE cleared_at IS NULL`).Scan(&open)
	return open, err
}

// raise is idempotent per (trip, kind) while the alert is open. The partial
// unique index does the work — a second detection thirty seconds later updates
// the row instead of racing another insert against it.
func (s *Service) raise(ctx context.Context, tripID, operatorID, kind, severity, detail string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ops.alerts (trip_id, operator_id, kind, severity, detail)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		ON CONFLICT (trip_id, kind) WHERE cleared_at IS NULL
		DO UPDATE SET detail = EXCLUDED.detail, severity = EXCLUDED.severity`,
		tripID, operatorID, kind, severity, detail)
	return err
}

func (s *Service) clear(ctx context.Context, tripID, kind string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ops.alerts SET cleared_at = now()
		 WHERE trip_id = $1::uuid AND kind = $2 AND cleared_at IS NULL`, tripID, kind)
	return err
}

// A trip past its departure time that the crew has not marked DEPARTED.
func (s *Service) scanLateDeparture(ctx context.Context, th Thresholds) error {
	rows, err := s.pool.Query(ctx, `
		SELECT t.trip_id::text, t.operator_id::text, rt.name,
		       EXTRACT(EPOCH FROM (now() - t.depart_at))/60,
		       t.status
		  FROM catalog.trips t
		  JOIN catalog.routes rt ON rt.route_id = t.route_id
		 WHERE t.service_date BETWEEN catalog.bd_today() - 1 AND catalog.bd_today() + 1
		   AND t.status IN ('SCHEDULED','OPEN','BOARDING','DEPARTED','IN_PROGRESS')
		   AND t.depart_at < now() + interval '1 hour'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var trip, operator, route, status string
		var lateMin float64
		if err := rows.Scan(&trip, &operator, &route, &lateMin, &status); err != nil {
			return err
		}
		departed := status == "DEPARTED" || status == "IN_PROGRESS"
		if !departed && lateMin >= float64(th.LateDepartureMin) {
			sev := "MEDIUM"
			if lateMin >= 45 {
				sev = "HIGH"
			}
			if err := s.raise(ctx, trip, operator, "LATE_DEPARTURE", sev,
				fmt.Sprintf("%s is %.0f minutes past its departure time and is still %s",
					route, lateMin, status)); err != nil {
				return err
			}
		} else if departed {
			if err := s.clear(ctx, trip, "LATE_DEPARTURE"); err != nil {
				return err
			}
		}
	}
	return rows.Err()
}

// A bus in motion that has stopped reporting its position.
func (s *Service) scanGPSOffline(ctx context.Context, th Thresholds) error {
	rows, err := s.pool.Query(ctx, `
		SELECT t.trip_id::text, t.operator_id::text, b.registration,
		       COALESCE(EXTRACT(EPOCH FROM (now() - p.last_fix))/60, 9999)
		  FROM catalog.trips t
		  JOIN catalog.buses b ON b.bus_id = t.bus_id
		  LEFT JOIN (SELECT trip_id, max(recorded_at) AS last_fix
		               FROM ops.bus_positions GROUP BY trip_id) p ON p.trip_id = t.trip_id
		 WHERE t.status IN ('DEPARTED','IN_PROGRESS')`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var trip, operator, reg string
		var silentMin float64
		if err := rows.Scan(&trip, &operator, &reg, &silentMin); err != nil {
			return err
		}
		if silentMin >= float64(th.GPSSilenceMin) {
			detail := fmt.Sprintf("bus %s has not reported a position for %.0f minutes", reg, silentMin)
			if silentMin > 9000 {
				detail = fmt.Sprintf("bus %s has never reported a position on this trip", reg)
			}
			if err := s.raise(ctx, trip, operator, "GPS_OFFLINE", "HIGH", detail); err != nil {
				return err
			}
		} else if err := s.clear(ctx, trip, "GPS_OFFLINE"); err != nil {
			return err
		}
	}
	return rows.Err()
}

// A bus that has been stationary for a long time, away from a scheduled stop.
func (s *Service) scanStops(ctx context.Context, th Thresholds) error {
	rows, err := s.pool.Query(ctx, `
		WITH latest AS (
		    SELECT DISTINCT ON (trip_id) trip_id, lat, lng, speed_kph, recorded_at
		      FROM ops.bus_positions
		     WHERE recorded_at > now() - interval '2 hours'
		     ORDER BY trip_id, recorded_at DESC
		), stalled AS (
		    SELECT l.trip_id, l.lat, l.lng,
		           (SELECT min(p.recorded_at) FROM ops.bus_positions p
		             WHERE p.trip_id = l.trip_id
		               AND p.recorded_at > now() - interval '2 hours'
		               AND COALESCE(p.speed_kph, 0) <= $1
		               AND p.recorded_at >= (
		                   SELECT COALESCE(max(q.recorded_at), '-infinity'::timestamptz)
		                     FROM ops.bus_positions q
		                    WHERE q.trip_id = l.trip_id AND COALESCE(q.speed_kph,0) > $1)) AS since
		      FROM latest l
		     WHERE COALESCE(l.speed_kph, 0) <= $1
		)
		SELECT s.trip_id::text, t.operator_id::text, s.lat::float8, s.lng::float8,
		       EXTRACT(EPOCH FROM (now() - s.since))/60
		  FROM stalled s
		  JOIN catalog.trips t ON t.trip_id = s.trip_id
		 WHERE s.since IS NOT NULL AND t.status IN ('DEPARTED','IN_PROGRESS')`, th.StoppedSpeedKph)
	if err != nil {
		return err
	}
	defer rows.Close()

	type stall struct {
		trip, operator string
		lat, lng       float64
		mins           float64
	}
	var stalls []stall
	for rows.Next() {
		var v stall
		if err := rows.Scan(&v.trip, &v.operator, &v.lat, &v.lng, &v.mins); err != nil {
			return err
		}
		stalls = append(stalls, v)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, v := range stalls {
		if v.mins < float64(th.LongStopMin) {
			_ = s.clear(ctx, v.trip, "LONG_STOP")
			_ = s.clear(ctx, v.trip, "UNEXPECTED_STOP")
			continue
		}
		// Near a scheduled stop it is a long stop; away from one it is an
		// unexpected stop, which is the more worrying of the two.
		var nearStop bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (
			  SELECT 1 FROM catalog.trips t
			    JOIN catalog.route_stops rs ON rs.route_id = t.route_id
			    JOIN catalog.locations l ON l.location_id = rs.location_id
			   WHERE t.trip_id = $1::uuid AND l.lat IS NOT NULL
			     AND abs(l.lat::float8 - $2) < 0.05 AND abs(l.lng::float8 - $3) < 0.05)`,
			v.trip, v.lat, v.lng).Scan(&nearStop); err != nil {
			return err
		}
		kind, sev := "UNEXPECTED_STOP", "HIGH"
		detail := fmt.Sprintf("stationary for %.0f minutes away from any scheduled stop", v.mins)
		if nearStop {
			kind, sev = "LONG_STOP", "MEDIUM"
			detail = fmt.Sprintf("stationary at a scheduled stop for %.0f minutes", v.mins)
		}
		if err := s.raise(ctx, v.trip, v.operator, kind, sev, detail); err != nil {
			return err
		}
	}
	return nil
}

// A bus a long way from every point on its own route.
func (s *Service) scanDeviation(ctx context.Context, th Thresholds) error {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (p.trip_id)
		       p.trip_id::text, t.operator_id::text, p.lat::float8, p.lng::float8, rt.name
		  FROM ops.bus_positions p
		  JOIN catalog.trips t  ON t.trip_id = p.trip_id
		  JOIN catalog.routes rt ON rt.route_id = t.route_id
		 WHERE t.status IN ('DEPARTED','IN_PROGRESS')
		   AND p.recorded_at > now() - interval '30 minutes'
		 ORDER BY p.trip_id, p.recorded_at DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type fix struct {
		trip, operator, route string
		lat, lng              float64
	}
	var fixes []fix
	for rows.Next() {
		var f fix
		if err := rows.Scan(&f.trip, &f.operator, &f.lat, &f.lng, &f.route); err != nil {
			return err
		}
		fixes = append(fixes, f)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, f := range fixes {
		stops, err := s.routePoints(ctx, f.trip)
		if err != nil {
			return err
		}
		if len(stops) < 2 {
			continue
		}
		best := math.MaxFloat64
		for i := 0; i+1 < len(stops); i++ {
			if d := distanceToSegment(f.lat, f.lng, stops[i], stops[i+1]); d < best {
				best = d
			}
		}
		if best > th.DeviationMetres {
			if err := s.raise(ctx, f.trip, f.operator, "ROUTE_DEVIATION", "HIGH",
				fmt.Sprintf("%.1f km off the %s corridor", best/1000, f.route)); err != nil {
				return err
			}
		} else if err := s.clear(ctx, f.trip, "ROUTE_DEVIATION"); err != nil {
			return err
		}
	}
	return nil
}

type point struct{ lat, lng float64 }

func (s *Service) routePoints(ctx context.Context, tripID string) ([]point, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT l.lat::float8, l.lng::float8
		  FROM catalog.trips t
		  JOIN catalog.route_stops rs ON rs.route_id = t.route_id
		  JOIN catalog.locations l ON l.location_id = rs.location_id
		 WHERE t.trip_id = $1::uuid AND l.lat IS NOT NULL
		 ORDER BY rs.stop_seq`, tripID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []point
	for rows.Next() {
		var p point
		if err := rows.Scan(&p.lat, &p.lng); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// distanceToSegment is a flat-earth approximation, which is entirely adequate
// over the tens of kilometres between two stops on one corridor.
func distanceToSegment(lat, lng float64, a, b point) float64 {
	const mPerDegLat = 111_320.0
	mPerDegLng := 111_320.0 * math.Cos(lat*math.Pi/180)

	px := (lng - a.lng) * mPerDegLng
	py := (lat - a.lat) * mPerDegLat
	bx := (b.lng - a.lng) * mPerDegLng
	by := (b.lat - a.lat) * mPerDegLat

	den := bx*bx + by*by
	t := 0.0
	if den > 0 {
		t = (px*bx + py*by) / den
		t = math.Max(0, math.Min(1, t))
	}
	dx := px - t*bx
	dy := py - t*by
	return math.Sqrt(dx*dx + dy*dy)
}

// ------------------------------------------------- event-driven alerts -----

func (s *Service) RaiseFromEvent(ctx context.Context, eventType, tripID, detail string) error {
	if tripID == "" {
		return nil
	}
	// An event about a trip that no longer exists is nothing to do, not a
	// failure. Trips are pruned once they are long past; treating their trailing
	// events as retryable would dead-letter them forever and leave a consumer
	// group with a permanent backlog nobody can clear.
	var operatorID string
	err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id = $1::uuid`, tripID).
		Scan(&operatorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	switch eventType {
	case "trip.cancelled":
		return s.raise(ctx, tripID, operatorID, "TRIP_CANCELLATION", "HIGH", detail)
	case "incident.reported":
		if detail == "" {
			detail = "crew reported an incident"
		}
		return s.raise(ctx, tripID, operatorID, "BUS_BREAKDOWN", "HIGH", detail)
	case "trip.arrived", "trip.completed":
		for _, k := range []string{"LATE_DEPARTURE", "GPS_OFFLINE", "LONG_STOP", "UNEXPECTED_STOP", "ROUTE_DEVIATION"} {
			if err := s.clear(ctx, tripID, k); err != nil {
				return err
			}
		}
	}
	return nil
}

// ----------------------------------------------------------------- alerts --

type Alert struct {
	AlertID   string     `json:"alert_id"`
	TripID    string     `json:"trip_id"`
	Route     string     `json:"route"`
	Bus       string     `json:"bus"`
	Brand     string     `json:"operator"`
	Kind      string     `json:"kind"`
	Severity  string     `json:"severity"`
	Detail    string     `json:"detail"`
	RaisedAt  time.Time  `json:"raised_at"`
	ClearedAt *time.Time `json:"cleared_at"`
	Ack       bool       `json:"acknowledged"`
}

func (s *Service) Alerts(ctx context.Context, operatorID string, includeCleared bool) ([]Alert, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.alert_id::text, a.trip_id::text, rt.name, b.registration, o.brand,
		       a.kind, a.severity, a.detail, a.raised_at, a.cleared_at,
		       a.acknowledged_at IS NOT NULL
		  FROM ops.alerts a
		  JOIN catalog.trips t     ON t.trip_id = a.trip_id
		  JOIN catalog.routes rt   ON rt.route_id = t.route_id
		  JOIN catalog.buses b     ON b.bus_id = t.bus_id
		  JOIN catalog.operators o ON o.operator_id = a.operator_id
		 WHERE ($1 = '' OR a.operator_id::text = $1)
		   AND ($2 OR a.cleared_at IS NULL)
		 ORDER BY (a.cleared_at IS NULL) DESC,
		          CASE a.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
		          a.raised_at DESC
		 LIMIT 200`, operatorID, includeCleared)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Alert{}
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.AlertID, &a.TripID, &a.Route, &a.Bus, &a.Brand,
			&a.Kind, &a.Severity, &a.Detail, &a.RaisedAt, &a.ClearedAt, &a.Ack); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) Acknowledge(ctx context.Context, alertID, staffID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ops.alerts SET acknowledged_by = $2::uuid, acknowledged_at = now()
		 WHERE alert_id = $1::uuid AND acknowledged_at IS NULL`, alertID, staffID)
	return err
}

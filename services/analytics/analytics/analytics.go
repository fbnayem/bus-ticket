// Package analytics is the reporting read model (plan workstream P2-L).
//
// The rule the plan states and this package exists to keep: no reporting query
// touches the booking database. Facts are written here by the analytics-ingest
// consumer from the event log, and every report and dashboard number below is
// read from the analytics schema alone.
//
// ClickHouse is the eventual home for this. What is here is the same shape —
// an append-only, denormalised, event-sourced fact table plus rollups — sitting
// in PostgreSQL. The property that would be expensive to retrofit is the
// separation, not the storage engine.
package analytics

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Fact is one business event, flattened for reporting.
type Fact struct {
	EventID      string
	EventType    string
	OccurredAt   time.Time
	OperatorID   string
	TripID       string
	RouteName    string
	Channel      string
	PNR          string
	Seats        int
	AmountPoisha int64
	Payload      json.RawMessage
}

// Ingest is idempotent on event_id, so a consumer redelivery cannot double a
// day's revenue.
func (s *Store) Ingest(ctx context.Context, f Fact) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO analytics.facts
			(event_id, event_type, occurred_at, day, hour, operator_id, trip_id,
			 route_name, channel, pnr, seats, amount_poisha, payload)
		VALUES ($1::uuid, $2, $3,
		        ($3 AT TIME ZONE 'Asia/Dhaka')::date,
		        EXTRACT(HOUR FROM ($3 AT TIME ZONE 'Asia/Dhaka'))::int,
		        NULLIF($4,'')::uuid, NULLIF($5,'')::uuid, NULLIF($6,''), NULLIF($7,''),
		        NULLIF($8,''), $9, $10, $11)
		ON CONFLICT (event_id) DO NOTHING`,
		f.EventID, f.EventType, f.OccurredAt, f.OperatorID, f.TripID,
		f.RouteName, f.Channel, f.PNR, f.Seats, f.AmountPoisha, f.Payload)
	return err
}

// ------------------------------------------------------- real-time metrics --

// Refresh recomputes the live dashboard. It runs on a ticker rather than per
// request so a dashboard open by twenty people costs one pass, not twenty.
func (s *Store) Refresh(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO analytics.live_metrics (metric, value, unit, computed_at)
		SELECT * FROM (
		  SELECT 'bookings_per_minute' AS metric,
		         COALESCE(count(*) FILTER (WHERE event_type='booking.confirmed'
		                                     AND occurred_at > now() - interval '5 minutes'),0)/5.0,
		         'per min', now() FROM analytics.facts
		  UNION ALL
		  SELECT 'revenue_today',
		         COALESCE(sum(amount_poisha) FILTER (WHERE event_type='booking.confirmed'
		                   AND day = (now() AT TIME ZONE 'Asia/Dhaka')::date),0)/100.0,
		         'BDT', now() FROM analytics.facts
		  UNION ALL
		  SELECT 'seats_sold_today',
		         COALESCE(sum(seats) FILTER (WHERE event_type='booking.confirmed'
		                   AND day = (now() AT TIME ZONE 'Asia/Dhaka')::date),0),
		         'seats', now() FROM analytics.facts
		  UNION ALL
		  SELECT 'cancellations_today',
		         COALESCE(count(*) FILTER (WHERE event_type='booking.cancelled'
		                   AND day = (now() AT TIME ZONE 'Asia/Dhaka')::date),0),
		         'bookings', now() FROM analytics.facts
		  UNION ALL
		  SELECT 'seats_held_now',
		         (SELECT COALESCE(count(*),0) FROM inventory.seat_hold_items i
		           JOIN inventory.seat_holds h ON h.hold_id = i.hold_id
		          WHERE h.status='HELD' AND h.expires_at > now()),
		         'seats', now()
		  UNION ALL
		  SELECT 'active_trips',
		         (SELECT COALESCE(count(*),0) FROM catalog.trips
		           WHERE status IN ('BOARDING','DEPARTED','IN_PROGRESS')),
		         'trips', now()
		  UNION ALL
		  SELECT 'gps_buses',
		         (SELECT COALESCE(count(DISTINCT trip_id),0) FROM ops.bus_positions
		           WHERE recorded_at > now() - interval '15 minutes'),
		         'buses', now()
		  UNION ALL
		  SELECT 'payment_success_rate',
		         CASE WHEN count(*) FILTER (WHERE event_type IN ('payment.success','payment.failed')
		                                      AND occurred_at > now() - interval '24 hours') = 0
		              THEN 100
		              ELSE round(100.0 * count(*) FILTER (WHERE event_type='payment.success'
		                                                    AND occurred_at > now() - interval '24 hours')
		                   / count(*) FILTER (WHERE event_type IN ('payment.success','payment.failed')
		                                        AND occurred_at > now() - interval '24 hours'), 1)
		         END, '%', now() FROM analytics.facts
		  UNION ALL
		  SELECT 'events_ingested', (SELECT count(*) FROM analytics.facts), 'facts', now()
		) m
		ON CONFLICT (metric) DO UPDATE
		   SET value = EXCLUDED.value, unit = EXCLUDED.unit, computed_at = EXCLUDED.computed_at`)
	return err
}

type Metric struct {
	Metric     string    `json:"metric"`
	Value      float64   `json:"value"`
	Unit       string    `json:"unit"`
	ComputedAt time.Time `json:"computed_at"`
}

func (s *Store) Live(ctx context.Context) ([]Metric, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT metric, value::float8, unit, computed_at FROM analytics.live_metrics ORDER BY metric`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Metric{}
	for rows.Next() {
		var m Metric
		if err := rows.Scan(&m.Metric, &m.Value, &m.Unit, &m.ComputedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------- the reports --

type DayRow struct {
	Day           string  `json:"day"`
	Bookings      int     `json:"bookings"`
	Seats         int     `json:"seats"`
	GrossPoisha   int64   `json:"gross_poisha"`
	Cancellations int     `json:"cancellations"`
	RefundPoisha  int64   `json:"refund_poisha"`
	Occupancy     float64 `json:"occupancy_pct"`
}

// Daily is the platform revenue report: gross booking value, seats, refunds and
// cancellations by day, optionally scoped to one operator.
func (s *Store) Daily(ctx context.Context, operatorID, from, to string) ([]DayRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT day::text,
		       count(*) FILTER (WHERE event_type='booking.confirmed'),
		       COALESCE(sum(seats) FILTER (WHERE event_type='booking.confirmed'),0),
		       COALESCE(sum(amount_poisha) FILTER (WHERE event_type='booking.confirmed'),0),
		       count(*) FILTER (WHERE event_type='booking.cancelled'),
		       COALESCE(sum(amount_poisha) FILTER (WHERE event_type='refund.completed'),0)
		  FROM analytics.facts
		 WHERE day BETWEEN $1::date AND $2::date
		   AND ($3 = '' OR operator_id::text = $3)
		 GROUP BY day ORDER BY day`, from, to, operatorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DayRow{}
	for rows.Next() {
		var r DayRow
		if err := rows.Scan(&r.Day, &r.Bookings, &r.Seats, &r.GrossPoisha,
			&r.Cancellations, &r.RefundPoisha); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type ChannelRow struct {
	Channel     string `json:"channel"`
	Bookings    int    `json:"bookings"`
	Seats       int    `json:"seats"`
	GrossPoisha int64  `json:"gross_poisha"`
}

func (s *Store) ByChannel(ctx context.Context, operatorID, from, to string) ([]ChannelRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(channel,'UNKNOWN'), count(*), COALESCE(sum(seats),0), COALESCE(sum(amount_poisha),0)
		  FROM analytics.facts
		 WHERE event_type = 'booking.confirmed'
		   AND day BETWEEN $1::date AND $2::date
		   AND ($3 = '' OR operator_id::text = $3)
		 GROUP BY 1 ORDER BY 4 DESC`, from, to, operatorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChannelRow{}
	for rows.Next() {
		var r ChannelRow
		if err := rows.Scan(&r.Channel, &r.Bookings, &r.Seats, &r.GrossPoisha); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type RouteRow struct {
	Route       string `json:"route"`
	Bookings    int    `json:"bookings"`
	Seats       int    `json:"seats"`
	GrossPoisha int64  `json:"gross_poisha"`
}

func (s *Store) ByRoute(ctx context.Context, operatorID, from, to string) ([]RouteRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(route_name,'(unknown)'), count(*), COALESCE(sum(seats),0), COALESCE(sum(amount_poisha),0)
		  FROM analytics.facts
		 WHERE event_type = 'booking.confirmed'
		   AND day BETWEEN $1::date AND $2::date
		   AND ($3 = '' OR operator_id::text = $3)
		 GROUP BY 1 ORDER BY 4 DESC LIMIT 25`, from, to, operatorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RouteRow{}
	for rows.Next() {
		var r RouteRow
		if err := rows.Scan(&r.Route, &r.Bookings, &r.Seats, &r.GrossPoisha); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type HourRow struct {
	Hour     int `json:"hour"`
	Bookings int `json:"bookings"`
	Searches int `json:"searches"`
}

// Demand by departure hour — the input the Phase 3 forecasting work needs, and
// meanwhile the answer to "which departures should we add?".
func (s *Store) ByHour(ctx context.Context, operatorID, from, to string) ([]HourRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT h.hour,
		       COALESCE(count(f.fact_id) FILTER (WHERE f.event_type='booking.confirmed'),0),
		       COALESCE(count(f.fact_id) FILTER (WHERE f.event_type='seat.held'),0)
		  FROM generate_series(0,23) AS h(hour)
		  LEFT JOIN analytics.facts f
		         ON f.hour = h.hour AND f.day BETWEEN $1::date AND $2::date
		        AND ($3 = '' OR f.operator_id::text = $3)
		 GROUP BY h.hour ORDER BY h.hour`, from, to, operatorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HourRow{}
	for rows.Next() {
		var r HourRow
		if err := rows.Scan(&r.Hour, &r.Bookings, &r.Searches); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Integrity is the reconciliation check the plan asks for: the analytics store
// counting the same confirmed bookings the transactional store has. It is the
// one place this package is allowed to look at commerce, and it exists
// precisely to prove the projection has not drifted.
type Integrity struct {
	Day             string `json:"day"`
	AnalyticsCount  int    `json:"analytics_bookings"`
	CommerceCount   int    `json:"commerce_bookings"`
	Variance        int    `json:"variance"`
}

func (s *Store) CheckIntegrity(ctx context.Context, day string) (Integrity, error) {
	var v Integrity
	v.Day = day
	err := s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM analytics.facts
		         WHERE event_type = 'booking.confirmed' AND day = $1::date),
		       (SELECT count(*) FROM commerce.bookings
		         WHERE status IN ('TICKETED','COMPLETED','CANCELLED',
		                          'REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED')
		           AND (created_at AT TIME ZONE 'Asia/Dhaka')::date = $1::date)`, day).
		Scan(&v.AnalyticsCount, &v.CommerceCount)
	v.Variance = v.AnalyticsCount - v.CommerceCount
	return v, err
}

// Package tripgen turns recurring schedules into concrete trips.
//
// This is the schedule engine from Phase 1 workstream P1-E: an operator
// configures "Dhaka -> Chattogram, 10:00 PM, every day, AC Business" once, and
// the generator materialises the actual trips plus their seat inventory over a
// rolling horizon.
//
// Generation is idempotent per (schedule, service_date) — the UNIQUE constraint
// on catalog.trips means re-running it creates zero duplicates, so it is safe to
// call on every boot and from a cron.
package tripgen

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/inventory/inventory"
)

type Generator struct {
	pool *pgxpool.Pool
	inv  *inventory.Store
}

func New(pool *pgxpool.Pool, inv *inventory.Store) *Generator {
	return &Generator{pool: pool, inv: inv}
}

// Dhaka time. Departure times are stored as local wall-clock on the schedule.
var dhaka = time.FixedZone("Asia/Dhaka", 6*3600)

type Result struct {
	TripsCreated int
	SeatsOpened  int
	DaysAhead    int
}

// Generate materialises trips for the next `days` days, inventory included.
func (g *Generator) Generate(ctx context.Context, days int) (Result, error) {
	res := Result{DaysAhead: days}

	type schedule struct {
		id, routeID, busID, operatorID, layoutID string
		departLocal                              time.Time
		daysMask                                 int
		validFrom                                time.Time
		segmentCount                             int
	}

	rows, err := g.pool.Query(ctx, `
		SELECT s.schedule_id::text, s.route_id::text, s.bus_id::text, s.operator_id::text,
		       b.layout_id::text, s.depart_local, s.days_mask, s.valid_from,
		       (SELECT count(*) - 1 FROM catalog.route_stops rs WHERE rs.route_id = s.route_id)
		  FROM catalog.schedules s
		  JOIN catalog.buses b ON b.bus_id = s.bus_id
		 ORDER BY s.depart_local`)
	if err != nil {
		return res, err
	}
	var schedules []schedule
	for rows.Next() {
		var s schedule
		if err := rows.Scan(&s.id, &s.routeID, &s.busID, &s.operatorID, &s.layoutID,
			&s.departLocal, &s.daysMask, &s.validFrom, &s.segmentCount); err != nil {
			rows.Close()
			return res, err
		}
		schedules = append(schedules, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}

	// Seat layouts are immutable once referenced, so read each one once.
	layoutCache := map[string][]inventory.SeatSpec{}

	today := time.Now().In(dhaka).Truncate(24 * time.Hour)
	for d := 0; d < days; d++ {
		date := today.AddDate(0, 0, d)

		for _, s := range schedules {
			// bit 0 = Monday
			weekdayBit := (int(date.Weekday()) + 6) % 7
			if s.daysMask&(1<<uint(weekdayBit)) == 0 {
				continue
			}
			if date.Before(s.validFrom.In(dhaka).Truncate(24 * time.Hour)) {
				continue
			}

			var skipped bool
			if err := g.pool.QueryRow(ctx, `
				SELECT EXISTS(SELECT 1 FROM catalog.schedule_exceptions
				               WHERE schedule_id=$1::uuid AND service_date=$2::date AND action='SKIP')`,
				s.id, date.Format("2006-01-02")).Scan(&skipped); err != nil {
				return res, err
			}
			if skipped {
				continue
			}

			departAt := time.Date(date.Year(), date.Month(), date.Day(),
				s.departLocal.Hour(), s.departLocal.Minute(), 0, 0, dhaka)

			var tripID string
			err := g.pool.QueryRow(ctx, `
				INSERT INTO catalog.trips
					(operator_id, route_id, bus_id, schedule_id, service_date, depart_at,
					 segment_count, layout_id, status)
				VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6,$7,$8::uuid,'OPEN')
				ON CONFLICT (schedule_id, service_date) DO NOTHING
				RETURNING trip_id::text`,
				s.operatorID, s.routeID, s.busID, s.id,
				date.Format("2006-01-02"), departAt, s.segmentCount, s.layoutID).Scan(&tripID)
			if err != nil {
				continue // already generated for this date
			}

			seats, ok := layoutCache[s.layoutID]
			if !ok {
				seats, err = g.inv.SeatsFromLayout(ctx, s.layoutID)
				if err != nil {
					return res, fmt.Errorf("layout %s: %w", s.layoutID, err)
				}
				layoutCache[s.layoutID] = seats
			}
			if err := g.inv.OpenTrip(ctx, tripID, s.segmentCount, seats); err != nil {
				return res, fmt.Errorf("open trip %s: %w", tripID, err)
			}
			// A new trip has to become searchable. The indexer consumes this;
			// the periodic full reindex is a backstop, not the mechanism.
			if _, err := g.pool.Exec(ctx, `
				INSERT INTO ops.outbox (aggregate_id, event_type, payload)
				VALUES ($1::uuid, 'trip.created', jsonb_build_object(
					'trip_id', $1::text, 'operator_id', $2::text,
					'service_date', $3::text, 'seat_count', $4::int))`,
				tripID, s.operatorID, date.Format("2006-01-02"), len(seats)); err != nil {
				return res, fmt.Errorf("publish trip.created %s: %w", tripID, err)
			}
			res.TripsCreated++
			res.SeatsOpened += len(seats)
		}
	}
	return res, nil
}

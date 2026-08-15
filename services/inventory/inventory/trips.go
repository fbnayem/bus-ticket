package inventory

import (
	"context"
	"fmt"
)

// SeatSpec is one physical seat as materialised from an immutable layout version.
type SeatSpec struct {
	SeatNo    string
	SeatType  string
	FareClass string
	Deck      int
	Row       int
	Col       int
}

// OpenTrip materialises inventory for a trip: one trip_seats row per physical
// seat, with every segment free. Idempotent on trip_id, so re-running trip
// generation creates zero duplicates.
//
// Note there is no foreign key to catalog.trips. Inventory owns exactly one
// question — "who holds which segments of which seat on THIS trip" — and every
// statement in this package carries trip_id. That is what makes the Phase 3
// shard cutover a routing change rather than a rewrite.
func (s *Store) OpenTrip(ctx context.Context, tripID string, segmentCount int, seats []SeatSpec) error {
	if segmentCount < 1 || segmentCount > MaxSegments {
		return fmt.Errorf("%w: segment_count=%d", ErrBadSegments, segmentCount)
	}
	if len(seats) == 0 {
		return fmt.Errorf("inventory: trip needs at least one seat")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	ct, err := tx.Exec(ctx, `
		INSERT INTO inventory.trip_inventory (trip_id, segment_count, seat_count)
		VALUES ($1::uuid, $2, $3)
		ON CONFLICT (trip_id) DO NOTHING`, tripID, segmentCount, len(seats))
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return tx.Commit(ctx) // already open
	}

	for _, st := range seats {
		if st.SeatType == "" {
			st.SeatType = "NORMAL"
		}
		if st.FareClass == "" {
			st.FareClass = "BASE"
		}
		if st.Deck == 0 {
			st.Deck = 1
		}
		// A CREW or BLOCKED seat is born unavailable on every segment.
		var blocked int64
		if st.SeatType == "CREW" || st.SeatType == "BLOCKED" {
			blocked = int64(1)<<uint(segmentCount) - 1
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.trip_seats
				(trip_id, seat_no, seat_type, fare_class, deck, row_idx, col_idx, blocked_mask)
			VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
			tripID, st.SeatNo, st.SeatType, st.FareClass, st.Deck, st.Row, st.Col, blocked); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// SeatsFromLayout reads an immutable seat-layout version from the catalog.
// Layouts are frozen once trip-referenced, so this always returns the same
// seats for the same layout id — a historical ticket stays interpretable.
func (s *Store) SeatsFromLayout(ctx context.Context, layoutID string) ([]SeatSpec, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no, seat_type, fare_class, deck, row_idx, col_idx
		  FROM catalog.seat_layout_items
		 WHERE layout_id = $1::uuid
		 ORDER BY row_idx, col_idx`, layoutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SeatSpec
	for rows.Next() {
		var st SeatSpec
		if err := rows.Scan(&st.SeatNo, &st.SeatType, &st.FareClass, &st.Deck, &st.Row, &st.Col); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// ReplayMasksFromEvents rebuilds every seat's hold and sold masks purely from
// the append-only event log. The proof suite compares this against the live
// table: if they ever disagree, the mutation path lost or invented a fact.
func (s *Store) ReplayMasksFromEvents(ctx context.Context, tripID string) (hold, sold map[string]int64, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no, event_type, COALESCE(segment_mask, 0)
		  FROM inventory.inventory_events
		 WHERE trip_id = $1::uuid AND seat_no IS NOT NULL
		 ORDER BY event_id`, tripID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	hold = map[string]int64{}
	sold = map[string]int64{}
	for rows.Next() {
		var seat, evt string
		var mask int64
		if err := rows.Scan(&seat, &evt, &mask); err != nil {
			return nil, nil, err
		}
		switch evt {
		case "SEAT_HELD":
			hold[seat] |= mask
		case "SEAT_RELEASED", "HOLD_EXPIRED":
			hold[seat] &^= mask
		case "SEAT_BOOKED":
			hold[seat] &^= mask
			sold[seat] |= mask
		}
	}
	return hold, sold, rows.Err()
}

// LiveMasks reads the authoritative masks straight from the table.
func (s *Store) LiveMasks(ctx context.Context, tripID string) (hold, sold map[string]int64, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no, segment_hold_mask, segment_sold_mask
		  FROM inventory.trip_seats WHERE trip_id = $1::uuid`, tripID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	hold = map[string]int64{}
	sold = map[string]int64{}
	for rows.Next() {
		var seat string
		var h, sd int64
		if err := rows.Scan(&seat, &h, &sd); err != nil {
			return nil, nil, err
		}
		if h != 0 {
			hold[seat] = h
		}
		if sd != 0 {
			sold[seat] = sd
		}
	}
	return hold, sold, rows.Err()
}

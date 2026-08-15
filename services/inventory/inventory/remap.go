package inventory

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Seat movement for a replacement bus.
//
// When a bus breaks down and another one takes the trip, some passengers'
// seats stop existing. The plan is explicit that this must produce a conflict
// list for the crew rather than a silent double assignment, and that means the
// move itself has to be atomic: a passenger cannot be un-seated from the old
// seat unless they were successfully seated on the new one.
//
// This lives in inventory-service because it is seat state, and seat state has
// exactly one owner. The operations console decides WHICH seat somebody moves
// to; it is not permitted to decide whether the move is safe.

var ErrNotSold = errors.New("inventory: that seat is not sold to this hold")

// Reassign moves one seat of a confirmed hold onto a different seat number for
// the same segments. Either the passenger ends up on exactly one seat, or
// nothing changes.
func (s *Store) Reassign(ctx context.Context, holdID, oldSeat, newSeat string) error {
	if oldSeat == newSeat {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var tripID string
	var mask int64
	err = tx.QueryRow(ctx, `
		SELECT trip_id::text, segment_mask FROM inventory.seat_hold_items
		 WHERE hold_id = $1::uuid AND seat_no = $2 FOR UPDATE`, holdID, oldSeat).
		Scan(&tripID, &mask)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrHoldNotFound
	}
	if err != nil {
		return err
	}

	// Take the new seat first. If this returns zero rows somebody else owns an
	// overlapping segment of it and the passenger keeps the seat they have.
	ct, err := tx.Exec(ctx, `
		UPDATE inventory.trip_seats
		   SET segment_sold_mask = segment_sold_mask | $3::bigint,
		       version           = version + 1
		 WHERE trip_id = $1::uuid AND seat_no = $2
		   AND ((segment_sold_mask | segment_hold_mask | blocked_mask) & $3::bigint) = 0`,
		tripID, newSeat, mask)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrSeatUnavailable
	}

	// Only now give up the old one, and only if it really was ours.
	ct, err = tx.Exec(ctx, `
		UPDATE inventory.trip_seats
		   SET segment_sold_mask = segment_sold_mask & ~($3::bigint),
		       version           = version + 1
		 WHERE trip_id = $1::uuid AND seat_no = $2
		   AND (segment_sold_mask & $3::bigint) = $3::bigint`,
		tripID, oldSeat, mask)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrNotSold
	}

	if _, err := tx.Exec(ctx, `
		UPDATE inventory.seat_hold_items SET seat_no = $3
		 WHERE hold_id = $1::uuid AND seat_no = $2`, holdID, oldSeat, newSeat); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
		VALUES ($1::uuid, $2, $3::uuid, 'SEAT_RELEASED', $4),
		       ($1::uuid, $5, $3::uuid, 'SEAT_BOOKED',   $4)`,
		tripID, oldSeat, holdID, mask, newSeat); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.booked', jsonb_build_object(
			'trip_id', $1::text, 'hold_id', $2::text, 'from_seat', $3::text, 'to_seat', $4::text,
			'reason', 'replacement bus'))`,
		tripID, holdID, oldSeat, newSeat); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithdrawSeat takes a seat out of sale for every segment. A replacement bus
// with fewer seats uses it so the seats that no longer physically exist cannot
// be sold to anyone else while the crew resolves the conflicts.
func (s *Store) WithdrawSeat(ctx context.Context, tripID, seatNo string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var segCount int
	if err := tx.QueryRow(ctx,
		`SELECT segment_count FROM inventory.trip_inventory WHERE trip_id = $1::uuid`, tripID).
		Scan(&segCount); err != nil {
		return err
	}
	all := int64(1)<<uint(segCount) - 1

	if _, err := tx.Exec(ctx, `
		UPDATE inventory.trip_seats
		   SET blocked_mask = blocked_mask | ($3::bigint & ~segment_sold_mask),
		       version      = version + 1
		 WHERE trip_id = $1::uuid AND seat_no = $2`, tripID, seatNo, all); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.inventory_events (trip_id, seat_no, event_type, segment_mask)
		VALUES ($1::uuid, $2, 'SEAT_BLOCKED', $3)`, tripID, seatNo, all); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.blocked', jsonb_build_object(
			'trip_id', $1::text, 'seats', jsonb_build_array($2::text), 'reason', 'seat not on the replacement bus'))`,
		tripID, seatNo); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AddSeats opens seats that exist on the replacement bus but not on the
// original. Idempotent, so re-running a replacement adds nothing twice.
func (s *Store) AddSeats(ctx context.Context, tripID string, seats []SeatSpec) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var segCount int
	if err := tx.QueryRow(ctx,
		`SELECT segment_count FROM inventory.trip_inventory WHERE trip_id = $1::uuid`, tripID).
		Scan(&segCount); err != nil {
		return 0, err
	}

	added := 0
	for _, st := range seats {
		var blocked int64
		if st.SeatType == "CREW" || st.SeatType == "BLOCKED" {
			blocked = int64(1)<<uint(segCount) - 1
		}
		ct, err := tx.Exec(ctx, `
			INSERT INTO inventory.trip_seats
				(trip_id, seat_no, seat_type, fare_class, deck, row_idx, col_idx, blocked_mask)
			VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (trip_id, seat_no) DO NOTHING`,
			tripID, st.SeatNo, st.SeatType, st.FareClass, st.Deck, st.Row, st.Col, blocked)
		if err != nil {
			return 0, err
		}
		added += int(ct.RowsAffected())
	}
	if added > 0 {
		if _, err := tx.Exec(ctx,
			`UPDATE inventory.trip_inventory SET seat_count = seat_count + $2 WHERE trip_id = $1::uuid`,
			tripID, added); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return added, nil
}

// FreeSeats lists seats with every requested segment free — what the console
// offers a displaced passenger.
func (s *Store) FreeSeats(ctx context.Context, tripID string, boardSeq, dropSeq int) ([]string, error) {
	mask, err := SegmentMask(boardSeq, dropSeq)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no FROM inventory.trip_seats
		 WHERE trip_id = $1::uuid
		   AND ((segment_sold_mask | segment_hold_mask | blocked_mask) & $2) = 0
		 ORDER BY deck, row_idx, col_idx`, tripID, mask)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

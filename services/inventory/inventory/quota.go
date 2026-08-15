package inventory

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// Counter quota — the only sanctioned way to sell a seat without a live
// connection to this service.
//
// The rule from the plan, restated: a counter may never sell a seat it does
// not exclusively own. An offline terminal cannot see authoritative seat
// state, so if it sells from shared inventory it will eventually sell a seat
// the website sold thirty seconds earlier — two passengers, one seat, an
// argument at the bus door, and a ledger that only balances by manual
// writedown.
//
// So the counter takes ownership BEFORE it goes offline. AllocateQuota sets
// bits in blocked_mask, which every channel already respects, so a quota seat
// is invisible to the website for as long as the counter holds it. SellQuota
// then moves those bits blocked -> sold, and its WHERE clause requires that
// the bits were blocked in the first place. A terminal that replays a sale for
// a seat outside its quota gets rowcount 0 and the sale is rejected.
//
// The enforcement lives here, in inventory-service. The POS is not trusted to
// enforce it, and no future POS can opt out of it.

var (
	ErrNotInQuota   = errors.New("inventory: seat is not in this counter's quota")
	ErrQuotaTooLarge = errors.New("inventory: quota request exceeds the per-counter limit")
)

// MaxQuotaSeats bounds how much inventory one counter can take out of general
// sale. Without a ceiling a counter could quietly block an entire bus.
const MaxQuotaSeats = 8

// AllocateQuota takes exclusive ownership of seats for a counter.
// All-or-nothing, exactly like a passenger hold: partial quota is worse than
// no quota, because the clerk cannot tell which half they own.
func (s *Store) AllocateQuota(ctx context.Context, counterID, tripID string, seats []string, boardSeq, dropSeq int) (int64, error) {
	if len(seats) == 0 {
		return 0, fmt.Errorf("inventory: no seats requested")
	}
	if len(seats) > MaxQuotaSeats {
		return 0, ErrQuotaTooLarge
	}
	mask, err := SegmentMask(boardSeq, dropSeq)
	if err != nil {
		return 0, err
	}
	ordered := append([]string(nil), seats...)
	sort.Strings(ordered)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, seat := range ordered {
		// Same shape as AcquireHold: the seat must be free of holds, sales and
		// existing blocks across every requested segment.
		ct, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET blocked_mask = blocked_mask | $3,
			       version      = version + 1
			 WHERE trip_id = $1::uuid
			   AND seat_no = $2
			   AND (segment_hold_mask | segment_sold_mask | blocked_mask) & $3 = 0`,
			tripID, seat, mask)
		if err != nil {
			return 0, err
		}
		if ct.RowsAffected() != 1 {
			return 0, ErrSeatUnavailable
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO counter.quota_items
				(counter_id, trip_id, seat_no, segment_mask, board_seq, drop_seq)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
			ON CONFLICT (trip_id, seat_no, segment_mask, counter_id)
			DO UPDATE SET status = 'ALLOCATED', allocated_at = now(), settled_at = NULL`,
			counterID, tripID, seat, mask, boardSeq, dropSeq); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, event_type, segment_mask)
			VALUES ($1::uuid, $2, 'QUOTA_ALLOCATED', $3)`, tripID, seat, mask); err != nil {
			return 0, err
		}
	}
	// Quota seats leave general sale, so search has to hear about it — that is
	// what makes a counter reservation disappear from the public website.
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.blocked', jsonb_build_object(
			'trip_id', $1::text, 'seats', to_jsonb($2::text[]),
			'counter_id', $3::text, 'reason', 'counter quota'))`,
		tripID, seats, counterID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return mask, nil
}

// ReleaseQuota hands unsold quota seats back to general sale.
func (s *Store) ReleaseQuota(ctx context.Context, counterID, tripID string, seats []string, mask int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, seat := range seats {
		ct, err := tx.Exec(ctx, `
			UPDATE counter.quota_items
			   SET status = 'RELEASED', settled_at = now()
			 WHERE counter_id = $1::uuid AND trip_id = $2::uuid
			   AND seat_no = $3 AND segment_mask = $4 AND status = 'ALLOCATED'`,
			counterID, tripID, seat, mask)
		if err != nil {
			return err
		}
		if ct.RowsAffected() != 1 {
			continue // not ours, or already settled — releasing is idempotent
		}
		if _, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET blocked_mask = blocked_mask & ~($3::bigint),
			       version      = version + 1
			 WHERE trip_id = $1::uuid AND seat_no = $2`, tripID, seat, mask); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, event_type, segment_mask)
			VALUES ($1::uuid, $2, 'QUOTA_RELEASED', $3)`, tripID, seat, mask); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.released', jsonb_build_object(
			'trip_id', $1::text, 'seats', to_jsonb($2::text[]),
			'counter_id', $3::text, 'reason', 'counter quota released'))`,
		tripID, seats, counterID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SellQuota converts owned quota seats into sold seats and records a CONFIRMED
// hold so that everything downstream — tickets, cancellation, refunds, the
// seat map — behaves exactly as it does for a seat sold on the website. An
// offline counter sale is not a special kind of booking once it lands.
//
// This is the function a replayed offline sale calls, and the reason a replay
// storm is harmless: the guard `(blocked_mask & mask) = mask` is true exactly
// once per seat.
func (s *Store) SellQuota(ctx context.Context, counterID, tripID string, seats []string, boardSeq, dropSeq int, priceSnapshot []byte) (string, error) {
	mask, err := SegmentMask(boardSeq, dropSeq)
	if err != nil {
		return "", err
	}
	if len(seats) == 0 {
		return "", fmt.Errorf("inventory: no seats in the sale")
	}
	if len(priceSnapshot) == 0 {
		priceSnapshot = []byte(`{}`)
	}
	ordered := append([]string(nil), seats...)
	sort.Strings(ordered)

	holdID, err := newUUID()
	if err != nil {
		return "", err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.seat_holds
			(hold_id, trip_id, status, channel, session_ref, price_snapshot, expires_at, settled_at)
		VALUES ($1::uuid, $2::uuid, 'CONFIRMED', 'COUNTER_OFFLINE', $3, $4::jsonb, now(), now())`,
		holdID, tripID, counterID, string(priceSnapshot)); err != nil {
		return "", err
	}

	for _, seat := range ordered {
		// Ownership check first: is this seat in THIS counter's quota?
		ct, err := tx.Exec(ctx, `
			UPDATE counter.quota_items
			   SET status = 'SOLD', settled_at = now()
			 WHERE counter_id = $1::uuid AND trip_id = $2::uuid
			   AND seat_no = $3 AND segment_mask = $4 AND status = 'ALLOCATED'`,
			counterID, tripID, seat, mask)
		if err != nil {
			return "", err
		}
		if ct.RowsAffected() != 1 {
			return "", ErrNotInQuota
		}

		// Then the seat itself: blocked bits become sold bits, atomically.
		ct, err = tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET segment_sold_mask = segment_sold_mask | $3::bigint,
			       blocked_mask      = blocked_mask & ~($3::bigint),
			       version           = version + 1
			 WHERE trip_id = $1::uuid AND seat_no = $2
			   AND (blocked_mask & $3::bigint) = $3::bigint`,
			tripID, seat, mask)
		if err != nil {
			return "", err
		}
		if ct.RowsAffected() != 1 {
			return "", ErrNotInQuota
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.seat_hold_items (hold_id, trip_id, seat_no, segment_mask)
			VALUES ($1::uuid, $2::uuid, $3, $4)`, holdID, tripID, seat, mask); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
			VALUES ($1::uuid, $2, $3::uuid, 'SEAT_BOOKED', $4)`,
			tripID, seat, holdID, mask); err != nil {
			return "", err
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.quota_sold', jsonb_build_object(
			'hold_id', $2::text, 'trip_id', $1::text, 'seats', to_jsonb($3::text[]),
			'channel', 'COUNTER_OFFLINE'))`, tripID, holdID, seats); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return holdID, nil
}

// QuotaSeat is one seat a counter currently owns.
type QuotaSeat struct {
	SeatNo   string `json:"seat_no"`
	TripID   string `json:"trip_id"`
	Mask     int64  `json:"segment_mask"`
	BoardSeq int    `json:"board_seq"`
	DropSeq  int    `json:"drop_seq"`
	Status   string `json:"status"`
}

func (s *Store) ListQuota(ctx context.Context, counterID, tripID string) ([]QuotaSeat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no, trip_id::text, segment_mask, board_seq, drop_seq, status
		  FROM counter.quota_items
		 WHERE counter_id = $1::uuid
		   AND ($2 = '' OR trip_id = $2::uuid)
		   AND status = 'ALLOCATED'
		 ORDER BY trip_id, seat_no`, counterID, tripID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QuotaSeat{}
	for rows.Next() {
		var q QuotaSeat
		if err := rows.Scan(&q.SeatNo, &q.TripID, &q.Mask, &q.BoardSeq, &q.DropSeq, &q.Status); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

package inventory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the ONLY component in the platform permitted to mutate seat state.
// Every sales channel — web, app, counter POS, agent, operator, partner API, AI —
// reaches seats through this type. No channel gets its own seat logic.
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// HoldRequest is all-or-nothing: either every seat is acquired for every
// requested segment, or nothing is.
type HoldRequest struct {
	TripID        string
	Seats         []string
	BoardSeq      int
	DropSeq       int
	Channel       string
	SessionRef    string
	PriceSnapshot []byte // frozen at hold time, copied forward to the booking
	TTL           time.Duration
}

type Hold struct {
	HoldID    string
	TripID    string
	Status    string
	Mask      int64
	Seats     []string
	ExpiresAt time.Time
}

// AcquireHold performs the atomic seat acquisition.
//
// The rules this function exists to enforce:
//   - never SELECT-then-UPDATE; the conditional UPDATE's rowcount IS the lock
//   - all-or-nothing across every seat in the request
//   - a losing contender mutates nothing and leaves no rows behind
func (s *Store) AcquireHold(ctx context.Context, req HoldRequest) (*Hold, error) {
	mask, err := SegmentMask(req.BoardSeq, req.DropSeq)
	if err != nil {
		return nil, err
	}
	if len(req.Seats) == 0 {
		return nil, fmt.Errorf("inventory: no seats requested")
	}
	if req.TTL <= 0 {
		req.TTL = 10 * time.Minute
	}
	if req.Channel == "" {
		req.Channel = "WEB"
	}
	if len(req.PriceSnapshot) == 0 {
		req.PriceSnapshot = []byte(`{}`)
	}

	// Deterministic lock ordering. Two concurrent multi-seat holds that overlap
	// would otherwise be able to grab each other's seats in opposite order and
	// deadlock; sorting gives every transaction the same global sequence.
	seats := append([]string(nil), req.Seats...)
	sort.Strings(seats)

	holdID, err := newUUID()
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful Commit

	// ---- the acquisition itself -------------------------------------------
	// One conditional UPDATE per seat. The WHERE clause asks a single question:
	// "are all of my requested segment bits currently free on this seat?"
	// rowcount 1 = acquired. rowcount 0 = someone else owns an overlapping
	// segment, so the whole hold is abandoned.
	for _, seat := range seats {
		ct, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET segment_hold_mask = segment_hold_mask | $3,
			       version           = version + 1
			 WHERE trip_id = $1::uuid
			   AND seat_no = $2
			   AND (segment_hold_mask | segment_sold_mask | blocked_mask) & $3 = 0`,
			req.TripID, seat, mask)
		if err != nil {
			return nil, err
		}
		if ct.RowsAffected() != 1 {
			return nil, ErrSeatUnavailable
		}
	}

	// ---- provenance, written in the SAME transaction ----------------------
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.seat_holds
			(hold_id, trip_id, status, channel, session_ref, price_snapshot, expires_at)
		VALUES ($1::uuid, $2::uuid, 'HELD', $3, $4, $5::jsonb, now() + make_interval(secs => $6))`,
		holdID, req.TripID, req.Channel, req.SessionRef, string(req.PriceSnapshot), req.TTL.Seconds(),
	); err != nil {
		return nil, err
	}

	for _, seat := range seats {
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.seat_hold_items (hold_id, trip_id, seat_no, segment_mask)
			VALUES ($1::uuid, $2::uuid, $3, $4)`,
			holdID, req.TripID, seat, mask); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
			VALUES ($1::uuid, $2, $3::uuid, 'SEAT_HELD', $4)`,
			req.TripID, seat, holdID, mask); err != nil {
			return nil, err
		}
	}

	// Transactional outbox: the event becomes durable with the state change or
	// not at all. The relay publishes it afterwards, and the schema registry
	// rejects it if this payload ever stops carrying what consumers were
	// promised — which is the whole point of declaring the shape.
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.held', jsonb_build_object(
			'hold_id', $2::text, 'trip_id', $1::text, 'segment_mask', $3::bigint,
			'seats', to_jsonb($4::text[]), 'channel', $5::text))`,
		req.TripID, holdID, mask, seats, req.Channel); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	var expires time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT expires_at FROM inventory.seat_holds WHERE hold_id = $1::uuid`, holdID).
		Scan(&expires); err != nil {
		return nil, err
	}
	return &Hold{HoldID: holdID, TripID: req.TripID, Status: "HELD", Mask: mask, Seats: seats, ExpiresAt: expires}, nil
}

// ConfirmHold moves HELD segment bits to SOLD. It is idempotent on hold_id:
// calling it a hundred times produces exactly one effect, which is what makes a
// duplicated payment webhook harmless.
func (s *Store) ConfirmHold(ctx context.Context, holdID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var status, tripID string
	err = tx.QueryRow(ctx, `
		SELECT status, trip_id::text
		  FROM inventory.seat_holds
		 WHERE hold_id = $1::uuid
		 FOR UPDATE`, holdID).Scan(&status, &tripID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrHoldNotFound
	}
	if err != nil {
		return err
	}

	switch status {
	case "CONFIRMED":
		return tx.Commit(ctx) // already done — replay is a no-op
	case "HELD":
		// proceed
	default:
		return ErrHoldNotActive
	}

	rows, err := tx.Query(ctx, `
		SELECT seat_no, segment_mask FROM inventory.seat_hold_items
		 WHERE hold_id = $1::uuid ORDER BY seat_no`, holdID)
	if err != nil {
		return err
	}
	type item struct {
		seat string
		mask int64
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.seat, &it.mask); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, it := range items {
		// The guard `(segment_hold_mask & $3) = $3` is what makes the expiry race
		// safe: if the sweeper released this hold first, the bits are already
		// gone and this returns 0 rows rather than selling a seat we no longer
		// own. Confirm and expiry can therefore race freely — exactly one wins.
		ct, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET segment_sold_mask = segment_sold_mask | $3::bigint,
			       segment_hold_mask = segment_hold_mask & ~($3::bigint),
			       version           = version + 1
			 WHERE trip_id = $1::uuid
			   AND seat_no = $2
			   AND (segment_hold_mask & $3::bigint) = $3::bigint`,
			tripID, it.seat, it.mask)
		if err != nil {
			return err
		}
		if ct.RowsAffected() != 1 {
			return ErrHoldLost
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
			VALUES ($1::uuid, $2, $3::uuid, 'SEAT_BOOKED', $4)`,
			tripID, it.seat, holdID, it.mask); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE inventory.seat_holds SET status = 'CONFIRMED', settled_at = now()
		 WHERE hold_id = $1::uuid AND status = 'HELD'`, holdID); err != nil {
		return err
	}
	bookedSeats := make([]string, 0, len(items))
	for _, it := range items {
		bookedSeats = append(bookedSeats, it.seat)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.booked', jsonb_build_object(
			'hold_id', $2::text, 'trip_id', $1::text, 'seats', to_jsonb($3::text[])))`,
		tripID, holdID, bookedSeats); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseHold returns HELD segment bits to the pool. Idempotent: releasing an
// already-settled hold is a no-op, never an error the caller must special-case.
func (s *Store) ReleaseHold(ctx context.Context, holdID, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var status, tripID string
	err = tx.QueryRow(ctx, `
		SELECT status, trip_id::text FROM inventory.seat_holds
		 WHERE hold_id = $1::uuid FOR UPDATE`, holdID).Scan(&status, &tripID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrHoldNotFound
	}
	if err != nil {
		return err
	}
	if status != "HELD" {
		return tx.Commit(ctx) // already confirmed, released or expired
	}

	if err := releaseBits(ctx, tx, holdID, tripID, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// releaseBits clears a hold's segment bits and marks the hold settled.
// Shared by explicit release and by the expiry sweeper.
func releaseBits(ctx context.Context, tx pgx.Tx, holdID, tripID, reason string) error {
	newStatus := "RELEASED"
	eventType := "SEAT_RELEASED"
	if reason == "EXPIRED" {
		newStatus = "EXPIRED"
		eventType = "HOLD_EXPIRED"
	}

	rows, err := tx.Query(ctx, `
		SELECT seat_no, segment_mask FROM inventory.seat_hold_items
		 WHERE hold_id = $1::uuid ORDER BY seat_no`, holdID)
	if err != nil {
		return err
	}
	type item struct {
		seat string
		mask int64
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.seat, &it.mask); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, it := range items {
		if _, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET segment_hold_mask = segment_hold_mask & ~($3::bigint),
			       version           = version + 1
			 WHERE trip_id = $1::uuid AND seat_no = $2`,
			tripID, it.seat, it.mask); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
			VALUES ($1::uuid, $2, $3::uuid, $4, $5)`,
			tripID, it.seat, holdID, eventType, it.mask); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE inventory.seat_holds SET status = $2, settled_at = now()
		 WHERE hold_id = $1::uuid AND status = 'HELD'`, holdID, newStatus); err != nil {
		return err
	}
	releasedSeats := make([]string, 0, len(items))
	for _, it := range items {
		releasedSeats = append(releasedSeats, it.seat)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.released', jsonb_build_object(
			'hold_id', $2::text, 'trip_id', $1::text, 'reason', $3::text,
			'seats', to_jsonb($4::text[])))`,
		tripID, holdID, reason, releasedSeats)
	return err
}

// ReleaseConfirmed returns SOLD segment bits to the pool. This is the seat side
// of a cancellation: the seat becomes sellable again the moment the refund is
// recorded, so a cancelled seat is never left stranded until departure.
//
// Deliberately separate from ReleaseHold, which only handles HELD bits.
// Un-selling is a rarer and more consequential operation than abandoning a hold,
// and collapsing the two would make it too easy to un-sell by accident.
func (s *Store) ReleaseConfirmed(ctx context.Context, holdID, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var status, tripID string
	err = tx.QueryRow(ctx, `
		SELECT status, trip_id::text FROM inventory.seat_holds
		 WHERE hold_id = $1::uuid FOR UPDATE`, holdID).Scan(&status, &tripID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrHoldNotFound
	}
	if err != nil {
		return err
	}
	if status != "CONFIRMED" {
		return tx.Commit(ctx) // already released, or never sold — idempotent
	}

	rows, err := tx.Query(ctx, `
		SELECT seat_no, segment_mask FROM inventory.seat_hold_items
		 WHERE hold_id = $1::uuid ORDER BY seat_no`, holdID)
	if err != nil {
		return err
	}
	type item struct {
		seat string
		mask int64
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.seat, &it.mask); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, it := range items {
		if _, err := tx.Exec(ctx, `
			UPDATE inventory.trip_seats
			   SET segment_sold_mask = segment_sold_mask & ~($3::bigint),
			       version           = version + 1
			 WHERE trip_id = $1::uuid AND seat_no = $2`,
			tripID, it.seat, it.mask); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory.inventory_events (trip_id, seat_no, hold_id, event_type, segment_mask)
			VALUES ($1::uuid, $2, $3::uuid, 'SEAT_RELEASED', $4)`,
			tripID, it.seat, holdID, it.mask); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE inventory.seat_holds SET status = 'RELEASED', settled_at = now()
		 WHERE hold_id = $1::uuid`, holdID); err != nil {
		return err
	}
	unsold := make([]string, 0, len(items))
	for _, it := range items {
		unsold = append(unsold, it.seat)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inventory.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'seat.released', jsonb_build_object(
			'hold_id', $2::text, 'trip_id', $1::text, 'reason', $3::text,
			'seats', to_jsonb($4::text[])))`,
		tripID, holdID, reason, unsold); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SweepExpired releases holds whose PostgreSQL deadline has passed.
//
// PostgreSQL — not Redis — is the authority on expiry. Redis mirrors the
// deadline as a timer for latency, but if Redis is flushed entirely, this
// sweeper still frees every seat on schedule. A seat can never be stranded by
// cache loss; the worst case is bounded by the sweep interval.
func (s *Store) SweepExpired(ctx context.Context, limit int) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT hold_id::text, trip_id::text FROM inventory.seat_holds
		 WHERE status = 'HELD' AND expires_at < now()
		 ORDER BY expires_at
		 LIMIT $1
		 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, err
	}
	type due struct{ hold, trip string }
	var dues []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.hold, &d.trip); err != nil {
			rows.Close()
			return 0, err
		}
		dues = append(dues, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, d := range dues {
		if err := releaseBits(ctx, tx, d.hold, d.trip, "EXPIRED"); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(dues), nil
}

// SeatState is the availability answer for one seat over one journey.
type SeatState struct {
	SeatNo    string
	Available bool
	Sold      bool
	Held      bool
	Blocked   bool
}

// SeatMap answers availability for a journey. Note this reads the authoritative
// table: search may serve approximate availability from OpenSearch, but the seat
// map and the hold always come from here.
func (s *Store) SeatMap(ctx context.Context, tripID string, boardSeq, dropSeq int) ([]SeatState, error) {
	mask, err := SegmentMask(boardSeq, dropSeq)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT seat_no,
		       (segment_sold_mask & $2) <> 0 AS sold,
		       (segment_hold_mask & $2) <> 0 AS held,
		       (blocked_mask      & $2) <> 0 AS blocked
		  FROM inventory.trip_seats
		 WHERE trip_id = $1::uuid
		 ORDER BY seat_no`, tripID, mask)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SeatState
	for rows.Next() {
		var st SeatState
		if err := rows.Scan(&st.SeatNo, &st.Sold, &st.Held, &st.Blocked); err != nil {
			return nil, err
		}
		st.Available = !st.Sold && !st.Held && !st.Blocked
		out = append(out, st)
	}
	return out, rows.Err()
}

// CountAvailable is the cheap form of SeatMap used by the proof suite.
func (s *Store) CountAvailable(ctx context.Context, tripID string, boardSeq, dropSeq int) (int, error) {
	mask, err := SegmentMask(boardSeq, dropSeq)
	if err != nil {
		return 0, err
	}
	var n int
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FROM inventory.trip_seats
		 WHERE trip_id = $1::uuid
		   AND ((segment_sold_mask | segment_hold_mask | blocked_mask) & $2) = 0`,
		tripID, mask).Scan(&n)
	return n, err
}

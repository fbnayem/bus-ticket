package ops

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Replacement bus.
//
// A bus breaks down and another one runs the trip. The replacement rarely has
// the same seat map, so some passengers' seats stop existing. The plan is
// explicit about what must not happen: a silent double assignment. So the flow
// below never guesses quietly — every passenger either lands on a seat that was
// atomically acquired for them, or appears on a conflict list a human has to
// resolve before the bus leaves.

var ErrSameBus = errors.New("ops: the replacement is the bus already assigned")

type ReplacementResult struct {
	ReplacementID string       `json:"replacement_id"`
	FromBus       string       `json:"from_bus"`
	ToBus         string       `json:"to_bus"`
	SeatsAdded    int          `json:"seats_added"`
	SeatsWithdrawn int         `json:"seats_withdrawn"`
	Remapped      int          `json:"remapped"`
	Conflicts     int          `json:"conflicts"`
	Rows          []RemapRow   `json:"rows"`
}

type RemapRow struct {
	PNR      string `json:"pnr"`
	OldSeat  string `json:"old_seat"`
	NewSeat  string `json:"new_seat,omitempty"`
	Status   string `json:"status"`
	Passenger string `json:"passenger,omitempty"`
}

// Replace swaps the bus on a trip and remaps every ticketed passenger.
func (s *Service) Replace(ctx context.Context, tripID, toBusID, reason, staffID string) (*ReplacementResult, error) {
	var fromBusID, fromReg, toReg, oldLayout, newLayout string
	var segCount int
	if err := s.pool.QueryRow(ctx, `
		SELECT t.bus_id::text, b.registration, b.layout_id::text, t.segment_count
		  FROM catalog.trips t JOIN catalog.buses b ON b.bus_id = t.bus_id
		 WHERE t.trip_id = $1::uuid`, tripID).
		Scan(&fromBusID, &fromReg, &oldLayout, &segCount); err != nil {
		return nil, err
	}
	if fromBusID == toBusID {
		return nil, ErrSameBus
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT registration, layout_id::text FROM catalog.buses WHERE bus_id = $1::uuid`, toBusID).
		Scan(&toReg, &newLayout); err != nil {
		return nil, err
	}

	newSeats, err := s.inv.SeatsFromLayout(ctx, newLayout)
	if err != nil {
		return nil, err
	}
	onNewBus := map[string]bool{}
	for _, st := range newSeats {
		if st.SeatType != "CREW" && st.SeatType != "BLOCKED" {
			onNewBus[st.SeatNo] = true
		}
	}

	res := &ReplacementResult{FromBus: fromReg, ToBus: toReg, Rows: []RemapRow{}}

	// Open any seat the replacement has that the original did not. Doing this
	// first means a displaced passenger can be offered one of them.
	added, err := s.inv.AddSeats(ctx, tripID, newSeats)
	if err != nil {
		return nil, err
	}
	res.SeatsAdded = added

	if err := s.pool.QueryRow(ctx, `
		INSERT INTO ops.replacements (trip_id, from_bus_id, to_bus_id, reason, created_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5,'')::uuid)
		RETURNING replacement_id::text`,
		tripID, fromBusID, toBusID, reason, staffID).Scan(&res.ReplacementID); err != nil {
		return nil, err
	}

	// Everyone currently holding a ticket on this trip, oldest booking first so
	// the remap is deterministic rather than whoever the planner happened to
	// return first.
	rows, err := s.pool.Query(ctx, `
		SELECT b.booking_id::text, b.pnr, b.hold_id::text, bs.seat_no,
		       COALESCE(p.full_name,''), b.board_stop_seq, b.drop_stop_seq
		  FROM commerce.bookings b
		  JOIN commerce.booking_seats bs ON bs.booking_id = b.booking_id
		  LEFT JOIN commerce.booking_passengers p
		         ON p.booking_id = b.booking_id AND p.seat_no = bs.seat_no
		 WHERE b.trip_id = $1::uuid AND b.status IN ('CONFIRMED','TICKETED')
		 ORDER BY b.created_at, bs.seat_no`, tripID)
	if err != nil {
		return nil, err
	}
	type seat struct {
		bookingID, pnr, holdID, seatNo, passenger string
		board, drop                               int
	}
	var occupied []seat
	for rows.Next() {
		var v seat
		if err := rows.Scan(&v.bookingID, &v.pnr, &v.holdID, &v.seatNo,
			&v.passenger, &v.board, &v.drop); err != nil {
			rows.Close()
			return nil, err
		}
		occupied = append(occupied, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, occ := range occupied {
		if onNewBus[occ.seatNo] {
			res.Remapped++
			res.Rows = append(res.Rows, RemapRow{
				PNR: occ.pnr, OldSeat: occ.seatNo, NewSeat: occ.seatNo,
				Status: "REMAPPED", Passenger: occ.passenger})
			if err := s.recordRemap(ctx, res.ReplacementID, occ.bookingID, occ.pnr,
				occ.seatNo, occ.seatNo, "REMAPPED"); err != nil {
				return nil, err
			}
			continue
		}

		// Their seat is gone. Offer the first free seat that exists on the new
		// bus; the move itself is inventory's conditional UPDATE, so two
		// displaced passengers can never be given the same replacement.
		free, err := s.inv.FreeSeats(ctx, tripID, occ.board, occ.drop)
		if err != nil {
			return nil, err
		}
		moved := ""
		for _, cand := range free {
			if !onNewBus[cand] {
				continue
			}
			if err := s.inv.Reassign(ctx, occ.holdID, occ.seatNo, cand); err == nil {
				moved = cand
				break
			}
		}
		if moved == "" {
			res.Conflicts++
			res.Rows = append(res.Rows, RemapRow{
				PNR: occ.pnr, OldSeat: occ.seatNo, Status: "CONFLICT", Passenger: occ.passenger})
			if err := s.recordRemap(ctx, res.ReplacementID, occ.bookingID, occ.pnr,
				occ.seatNo, "", "CONFLICT"); err != nil {
				return nil, err
			}
			continue
		}

		if _, err := s.pool.Exec(ctx, `
			UPDATE commerce.booking_seats SET seat_no = $3
			 WHERE booking_id = $1::uuid AND seat_no = $2`, occ.bookingID, occ.seatNo, moved); err != nil {
			return nil, err
		}
		// The ticket follows the passenger, and so does the QR: the token is
		// bound to (pnr, seat), so leaving it behind would fail the boarding scan.
		if _, err := s.pool.Exec(ctx, `
			UPDATE commerce.tickets SET seat_no = $3
			 WHERE booking_id = $1::uuid AND seat_no = $2`, occ.bookingID, occ.seatNo, moved); err != nil {
			return nil, err
		}
		if _, err := s.pool.Exec(ctx, `
			UPDATE commerce.booking_passengers SET seat_no = $3
			 WHERE booking_id = $1::uuid AND seat_no = $2`, occ.bookingID, occ.seatNo, moved); err != nil {
			return nil, err
		}
		res.Remapped++
		res.Rows = append(res.Rows, RemapRow{
			PNR: occ.pnr, OldSeat: occ.seatNo, NewSeat: moved,
			Status: "REMAPPED", Passenger: occ.passenger})
		if err := s.recordRemap(ctx, res.ReplacementID, occ.bookingID, occ.pnr,
			occ.seatNo, moved, "REMAPPED"); err != nil {
			return nil, err
		}
	}

	// Withdraw every seat that does not exist on the replacement, so nothing
	// can be sold onto a seat that is not physically there.
	withdrawn, err := s.withdrawMissing(ctx, tripID, onNewBus)
	if err != nil {
		return nil, err
	}
	res.SeatsWithdrawn = withdrawn

	if _, err := s.pool.Exec(ctx, `
		UPDATE catalog.trips SET bus_id = $2::uuid WHERE trip_id = $1::uuid`,
		tripID, toBusID); err != nil {
		return nil, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE ops.replacements SET seats_remapped = $2, conflicts = $3
		 WHERE replacement_id = $1::uuid`, res.ReplacementID, res.Remapped, res.Conflicts); err != nil {
		return nil, err
	}

	// Passengers hear about it, and so does the control room, through the
	// normal event path rather than a special case here.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO ops.outbox (aggregate_id, event_type, payload)
		VALUES ($1::uuid, 'trip.delayed', jsonb_build_object(
			'trip_id', $1::text, 'minutes', 30, 'reason', $2::text, 'replacement_bus', $3::text))`,
		tripID, reason, toReg); err != nil {
		return nil, err
	}
	return res, nil
}

func (s *Service) recordRemap(ctx context.Context, replacementID, bookingID, pnr, oldSeat, newSeat, status string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ops.seat_remaps (replacement_id, booking_id, pnr, old_seat, new_seat, status)
		VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''), $6)
		ON CONFLICT (replacement_id, booking_id, old_seat) DO UPDATE
		   SET new_seat = EXCLUDED.new_seat, status = EXCLUDED.status`,
		replacementID, bookingID, pnr, oldSeat, newSeat, status)
	return err
}

func (s *Service) withdrawMissing(ctx context.Context, tripID string, onNewBus map[string]bool) (int, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT seat_no FROM inventory.trip_seats WHERE trip_id = $1::uuid ORDER BY seat_no`, tripID)
	if err != nil {
		return 0, err
	}
	var all []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return 0, err
		}
		all = append(all, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	n := 0
	for _, seatNo := range all {
		if onNewBus[seatNo] {
			continue
		}
		if err := s.inv.WithdrawSeat(ctx, tripID, seatNo); err != nil {
			return n, fmt.Errorf("withdraw %s: %w", seatNo, err)
		}
		n++
	}
	return n, nil
}

// Conflicts lists the passengers a replacement could not seat. They are the
// crew's job before departure, and this is the queue they work from.
func (s *Service) Conflicts(ctx context.Context, tripID string) ([]RemapRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.pnr, r.old_seat, COALESCE(r.new_seat,''), r.status,
		       COALESCE(p.full_name,'')
		  FROM ops.seat_remaps r
		  JOIN ops.replacements rp ON rp.replacement_id = r.replacement_id
		  LEFT JOIN commerce.booking_passengers p
		         ON p.booking_id = r.booking_id AND p.seat_no = r.old_seat
		 WHERE rp.trip_id = $1::uuid AND r.status = 'CONFLICT'
		 ORDER BY r.pnr`, tripID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RemapRow{}
	for rows.Next() {
		var r RemapRow
		if err := rows.Scan(&r.PNR, &r.OldSeat, &r.NewSeat, &r.Status, &r.Passenger); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ResolveConflict seats a displaced passenger on a specific seat a human chose.
func (s *Service) ResolveConflict(ctx context.Context, tripID, pnr, oldSeat, newSeat, staffID string) error {
	var bookingID, holdID, replacementID string
	err := s.pool.QueryRow(ctx, `
		SELECT b.booking_id::text, b.hold_id::text, r.replacement_id::text
		  FROM ops.seat_remaps r
		  JOIN ops.replacements rp ON rp.replacement_id = r.replacement_id
		  JOIN commerce.bookings b ON b.booking_id = r.booking_id
		 WHERE rp.trip_id = $1::uuid AND r.pnr = $2 AND r.old_seat = $3
		   AND r.status = 'CONFLICT'`, tripID, pnr, oldSeat).
		Scan(&bookingID, &holdID, &replacementID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("ops: no open conflict for that passenger")
	}
	if err != nil {
		return err
	}
	if err := s.inv.Reassign(ctx, holdID, oldSeat, newSeat); err != nil {
		return err
	}
	for _, q := range []string{
		`UPDATE commerce.booking_seats SET seat_no = $3 WHERE booking_id = $1::uuid AND seat_no = $2`,
		`UPDATE commerce.tickets SET seat_no = $3 WHERE booking_id = $1::uuid AND seat_no = $2`,
		`UPDATE commerce.booking_passengers SET seat_no = $3 WHERE booking_id = $1::uuid AND seat_no = $2`,
	} {
		if _, err := s.pool.Exec(ctx, q, bookingID, oldSeat, newSeat); err != nil {
			return err
		}
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE ops.seat_remaps
		   SET new_seat = $4, status = 'RESOLVED', resolved_by = NULLIF($5,'')::uuid, resolved_at = now()
		 WHERE replacement_id = $1::uuid AND booking_id = $2::uuid AND old_seat = $3`,
		replacementID, bookingID, oldSeat, newSeat, staffID)
	return err
}

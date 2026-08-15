package httpapi

import (
	"context"
	"time"
)

// Helpers shared by every channel. They exist so that a booking made at a
// counter, by an agent or on the website is written the same way — the only
// difference between the channels should be who is paying and how, never the
// shape of the record that comes out.

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// attributeSale records which channel actually made the sale. Settlement
// cannot split operator revenue from agent commission without it, and support
// cannot answer "who sold this ticket?".
func (s *Server) attributeSale(ctx context.Context, bookingID, counterID, agencyID, staffID string) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE commerce.bookings
		   SET counter_id = NULLIF($2,'')::uuid,
		       agency_id  = NULLIF($3,'')::uuid,
		       sold_by    = NULLIF($4,'')::uuid
		 WHERE booking_id = $1::uuid`, bookingID, counterID, agencyID, staffID); err != nil {
		s.log.Error("attribute sale", "err", err, "booking", bookingID)
	}
}

func (s *Server) savePassengers(ctx context.Context, bookingID string, passengers []passengerIn, phone, email string) {
	for _, p := range passengers {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO commerce.booking_passengers
				(booking_id, seat_no, full_name, gender, age, id_type, id_number)
			VALUES ($1::uuid,$2,$3,NULLIF($4,''),NULLIF($5,0),NULLIF($6,''),NULLIF($7,''))
			ON CONFLICT (booking_id, seat_no) DO UPDATE SET full_name = EXCLUDED.full_name`,
			bookingID, p.SeatNo, p.FullName, p.Gender, p.Age, p.IDType, p.IDNumber); err != nil {
			s.log.Error("passenger insert", "err", err)
		}
	}
	if phone != "" {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO commerce.booking_contacts (booking_id, phone, email)
			VALUES ($1::uuid, $2, NULLIF($3,''))
			ON CONFLICT (booking_id) DO UPDATE SET phone = EXCLUDED.phone`,
			bookingID, phone, email); err != nil {
			s.log.Error("contact insert", "err", err)
		}
	}
}

type ticketOut struct {
	TicketID  string    `json:"ticket_id"`
	SeatNo    string    `json:"seat_no"`
	QRToken   string    `json:"qr_token"`
	Status    string    `json:"status"`
	Passenger string    `json:"passenger,omitempty"`
	IssuedAt  time.Time `json:"issued_at"`
}

func (s *Server) ticketsFor(ctx context.Context, bookingID string) []ticketOut {
	rows, err := s.pool.Query(ctx, `
		SELECT t.ticket_id::text, t.seat_no, t.qr_token, t.status, t.issued_at,
		       COALESCE(p.full_name,'')
		  FROM commerce.tickets t
		  LEFT JOIN commerce.booking_passengers p
		         ON p.booking_id = t.booking_id AND p.seat_no = t.seat_no
		 WHERE t.booking_id = $1::uuid ORDER BY t.seat_no`, bookingID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []ticketOut{}
	for rows.Next() {
		var t ticketOut
		if err := rows.Scan(&t.TicketID, &t.SeatNo, &t.QRToken, &t.Status, &t.IssuedAt, &t.Passenger); err != nil {
			continue
		}
		out = append(out, t)
	}
	return out
}

// dateRange reads from/to query parameters, defaulting to the last 7 days.
func dateRange(from, to string) (string, string) {
	if to == "" {
		to = time.Now().Format("2006-01-02")
	}
	if from == "" {
		from = time.Now().AddDate(0, 0, -7).Format("2006-01-02")
	}
	return from, to
}

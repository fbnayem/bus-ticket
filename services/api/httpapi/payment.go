package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/busticket/platform/services/commerce/commerce"
)

// Payment. The browser's success page NEVER confirms a payment — it only reads
// state. Confirmation happens exactly once, when a signed provider webhook
// passes the verification chain in commerce.HandleWebhook.
//
// The sandbox below models a hosted-checkout redirect: the intent is signed
// server-side, the "provider" page hands the signed reference back, and the
// completion endpoint delivers a webhook the way bKash or Nagad would. Nothing
// the browser can edit changes what gets charged.

type intentRequest struct {
	BookingID string `json:"booking_id"`
	Provider  string `json:"provider"`
}

// signedIntent is what travels through the browser. Any tampering invalidates
// the signature and the webhook is rejected.
type signedIntent struct {
	BookingID string `json:"booking_id"`
	Provider  string `json:"provider"`
	TxnID     string `json:"txn_id"`
	Amount    int64  `json:"amount_poisha"`
	Currency  string `json:"currency"`
	Sig       string `json:"sig"`
}

func (s *Server) intentSecret() []byte {
	if len(s.intentSec) > 0 {
		return s.intentSec
	}
	return []byte("sandbox-intent-secret")
}

func (s *Server) signIntent(i signedIntent) string {
	mac := hmac.New(sha256.New, s.intentSecret())
	fmt.Fprintf(mac, "%s|%s|%s|%d|%s", i.BookingID, i.Provider, i.TxnID, i.Amount, i.Currency)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) handlePaymentIntent(w http.ResponseWriter, r *http.Request) {
	var req intentRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	switch req.Provider {
	case "BKASH", "NAGAD", "CARD", "BANK":
	default:
		fail(w, 400, "bad_provider", "Choose bKash, Nagad, card or bank.")
		return
	}

	var amount int64
	var status, pnr string
	err := s.pool.QueryRow(r.Context(),
		`SELECT total_poisha, status, pnr FROM commerce.bookings WHERE booking_id = $1::uuid`,
		req.BookingID).Scan(&amount, &status, &pnr)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find that booking.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the booking.")
		return
	}
	if status != "PAYMENT_PENDING" {
		fail(w, 409, "not_payable", fmt.Sprintf("This booking is already %s.", status))
		return
	}

	intent := signedIntent{
		BookingID: req.BookingID, Provider: req.Provider,
		TxnID: "TXN-" + randomID(), Amount: amount, Currency: "BDT",
	}
	intent.Sig = s.signIntent(intent)
	raw, _ := json.Marshal(intent)
	ref := base64.RawURLEncoding.EncodeToString(raw)

	writeJSON(w, 201, map[string]any{
		"payment_ref":   ref,
		"provider":      req.Provider,
		"amount_poisha": amount,
		"pnr":           pnr,
		// In production this is the provider's own hosted checkout URL.
		"redirect_url": "/payment/sandbox?ref=" + ref,
	})
}

type sandboxCompleteRequest struct {
	Ref     string `json:"payment_ref"`
	Outcome string `json:"outcome"` // success | failure
}

func (s *Server) handleSandboxComplete(w http.ResponseWriter, r *http.Request) {
	var req sandboxCompleteRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(req.Ref)
	if err != nil {
		fail(w, 400, "bad_ref", "That payment reference is not valid.")
		return
	}
	var intent signedIntent
	if err := json.Unmarshal(raw, &intent); err != nil {
		fail(w, 400, "bad_ref", "That payment reference is not valid.")
		return
	}
	if !hmac.Equal([]byte(s.signIntent(intent)), []byte(intent.Sig)) {
		fail(w, 400, "bad_ref", "That payment reference has been altered.")
		return
	}
	if req.Outcome == "failure" {
		writeJSON(w, 200, map[string]any{"status": "FAILED", "confirmed": false})
		return
	}

	// Deliver the webhook exactly as a provider would — signed, out of band,
	// and independent of whatever the browser does next.
	hook := commerce.Webhook{
		Provider: intent.Provider, ProviderTxnID: intent.TxnID,
		BookingID: intent.BookingID, AmountPoisha: intent.Amount, Currency: intent.Currency,
	}
	hook.Signature = s.com.Sign(hook)

	accepted, err := s.com.HandleWebhook(r.Context(), hook)
	if err != nil {
		s.log.Error("sandbox webhook", "err", err)
		fail(w, 502, "payment_failed", "The payment could not be confirmed. You have not been charged.")
		return
	}

	var pnr, status string
	_ = s.pool.QueryRow(r.Context(),
		`SELECT pnr, status FROM commerce.bookings WHERE booking_id=$1::uuid`, intent.BookingID).
		Scan(&pnr, &status)
	writeJSON(w, 200, map[string]any{
		"status": status, "pnr": pnr,
		"confirmed":      status == "TICKETED",
		"first_delivery": accepted, // false on a replay — still a success for the caller
	})
}

// handleWebhook is the real provider endpoint. Signed, and safe to call any
// number of times: UNIQUE(provider, provider_txn_id) collapses duplicates.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	var hook commerce.Webhook
	if err := decode(r, &hook); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	hook.Provider = r.PathValue("provider")

	accepted, err := s.com.HandleWebhook(r.Context(), hook)
	if err != nil {
		// Providers retry on non-2xx, which is what we want for a genuine fault.
		s.log.Warn("webhook rejected", "provider", hook.Provider, "err", err)
		fail(w, 400, "rejected", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"accepted": accepted})
}

// --------------------------------------------------------- booking read --

type ticketDTO struct {
	TicketID  string `json:"ticket_id"`
	SeatNo    string `json:"seat_no"`
	QRToken   string `json:"qr_token"`
	Status    string `json:"status"`
	Passenger string `json:"passenger"`
}

func (s *Server) handleGetBooking(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pnr := r.PathValue("pnr")

	var out struct {
		PNR           string      `json:"pnr"`
		BookingID     string      `json:"booking_id"`
		Status        string      `json:"status"`
		TotalPoisha   int64       `json:"total_poisha"`
		Channel       string      `json:"channel"`
		CreatedAt     time.Time   `json:"created_at"`
		TripID        string      `json:"trip_id"`
		Brand         string      `json:"brand"`
		BusType       string      `json:"bus_type"`
		Registration  string      `json:"registration"`
		DepartAt      time.Time   `json:"depart_at"`
		BoardAt       time.Time   `json:"board_at"`
		ArriveAt      time.Time   `json:"arrive_at"`
		Origin        string      `json:"origin"`
		Destination   string      `json:"destination"`
		BoardSeq      int         `json:"board_seq"`
		DropSeq       int         `json:"drop_seq"`
		Phone         string      `json:"phone"`
		Email         string      `json:"email"`
		VATRegistered bool        `json:"vat_registered"`
		Seats         []string    `json:"seats"`
		Tickets       []ticketDTO `json:"tickets"`
		Refund        *struct {
			Status string `json:"status"`
			Amount int64  `json:"amount_poisha"`
		} `json:"refund,omitempty"`
	}

	var routeID string
	err := s.pool.QueryRow(ctx, `
		SELECT b.pnr, b.booking_id::text, b.status, b.total_poisha, b.channel, b.created_at,
		       b.trip_id::text, o.brand, bt.name, bus.registration, t.depart_at,
		       t.route_id::text,
		       b.board_stop_seq, b.drop_stop_seq,
		       COALESCE(c.phone,''), COALESCE(c.email,''),
		       lo.name, ld.name, (o.vat_bin IS NOT NULL AND o.vat_bin <> '')
		  FROM commerce.bookings b
		  JOIN catalog.trips t      ON t.trip_id = b.trip_id
		  JOIN catalog.operators o  ON o.operator_id = b.operator_id
		  JOIN catalog.buses bus    ON bus.bus_id = t.bus_id
		  JOIN catalog.bus_types bt ON bt.bus_type_id = bus.bus_type_id
		  LEFT JOIN commerce.booking_contacts c ON c.booking_id = b.booking_id
		  JOIN catalog.route_stops rso ON rso.route_id = t.route_id AND rso.stop_seq = b.board_stop_seq
		  JOIN catalog.locations   lo  ON lo.location_id = rso.location_id
		  JOIN catalog.route_stops rsd ON rsd.route_id = t.route_id AND rsd.stop_seq = b.drop_stop_seq
		  JOIN catalog.locations   ld  ON ld.location_id = rsd.location_id
		 WHERE b.pnr = upper($1)`, pnr).
		Scan(&out.PNR, &out.BookingID, &out.Status, &out.TotalPoisha, &out.Channel, &out.CreatedAt,
			&out.TripID, &out.Brand, &out.BusType, &out.Registration, &out.DepartAt,
			&routeID, &out.BoardSeq, &out.DropSeq, &out.Phone, &out.Email, &out.Origin, &out.Destination,
			&out.VATRegistered)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		s.log.Error("get booking", "err", err)
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}

	// The passenger's own boarding time, not the trip's origin departure. On an
	// intercity route a mid-route boarder is picked up hours after the bus first
	// pulls out, so a ticket that prints the origin's time sends them to the
	// counter at the wrong hour. arrive_at is the same computation at the drop
	// stop. Both fall back to depart_at only when the route carries no timings.
	out.BoardAt, out.ArriveAt = out.DepartAt, out.DepartAt
	if offRows, oerr := s.pool.Query(ctx,
		`SELECT from_stop_seq, minutes FROM catalog.route_segment_minutes
		  WHERE route_id=$1::uuid`, routeID); oerr == nil {
		offsets := map[int]int{}
		for offRows.Next() {
			var seq, min int
			if offRows.Scan(&seq, &min) == nil {
				offsets[seq] = min
			}
		}
		offRows.Close()
		if len(offsets) > 0 {
			out.BoardAt = arrivalAt(out.DepartAt, offsets, out.BoardSeq)
			out.ArriveAt = arrivalAt(out.DepartAt, offsets, out.DropSeq)
		}
	}

	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(tk.ticket_id::text,''), bs.seat_no, COALESCE(tk.qr_token,''),
		       COALESCE(tk.status,'PENDING'), COALESCE(p.full_name,'')
		  FROM commerce.booking_seats bs
		  LEFT JOIN commerce.tickets tk ON tk.booking_id = bs.booking_id AND tk.seat_no = bs.seat_no
		  LEFT JOIN commerce.booking_passengers p ON p.booking_id = bs.booking_id AND p.seat_no = bs.seat_no
		 WHERE bs.booking_id = $1::uuid ORDER BY bs.seat_no`, out.BookingID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var t ticketDTO
			if rows.Scan(&t.TicketID, &t.SeatNo, &t.QRToken, &t.Status, &t.Passenger) == nil {
				out.Seats = append(out.Seats, t.SeatNo)
				out.Tickets = append(out.Tickets, t)
			}
		}
	}

	var rStatus string
	var rAmount int64
	if err := s.pool.QueryRow(ctx,
		`SELECT status, amount_poisha FROM commerce.refunds
		  WHERE booking_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, out.BookingID).
		Scan(&rStatus, &rAmount); err == nil {
		out.Refund = &struct {
			Status string `json:"status"`
			Amount int64  `json:"amount_poisha"`
		}{rStatus, rAmount}
	}

	writeJSON(w, 200, out)
}

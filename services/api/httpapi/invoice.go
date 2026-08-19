package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// decomposeInclusiveVAT splits a VAT-INCLUSIVE gross into its base and VAT parts.
//
// Retail prices here already contain VAT, so the tax is backed out, never added
// on top: base = round(gross * 10000 / (10000 + rate)), and the VAT is whatever
// remains. Computing it this way is the whole correctness guarantee — base + vat
// equals the gross to the poisha, so a printed invoice can never total to a
// different figure than the passenger actually paid. A rate of 0 (an exempt or
// non-AC supply) yields the gross as base and no VAT.
func decomposeInclusiveVAT(gross int64, rateBp int) (base, vat int64) {
	if rateBp <= 0 || gross <= 0 {
		return gross, 0
	}
	// Round to nearest poisha: (gross*10000 + half) / (10000+rate).
	denom := int64(10000 + rateBp)
	base = (gross*10000 + denom/2) / denom
	vat = gross - base
	return base, vat
}

type invoiceParty struct {
	Name  string `json:"name"`
	BIN   string `json:"bin,omitempty"`
	Phone string `json:"phone,omitempty"`
	Email string `json:"email,omitempty"`
}

// handleBookingInvoice issues the operator's Mushak 6.3 challanpatra for a booking.
// It is a derived document: no money moves, the ledger is untouched. The transport
// fare (what the operator received, net of any discount) is decomposed at the
// operator's registered rate — but only on AC trips, non-AC transport being
// VAT-exempt by law. The platform service fee is disclosed as a separate line so
// the grand total reconciles with what the passenger paid, without being folded
// into the operator's tax invoice.
func (s *Server) handleBookingInvoice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pnr := r.PathValue("pnr")

	var (
		total, discount int64
		createdAt       time.Time
		bookingID       string
		brand, legal    string
		vatBIN          *string
		vatRateBp       int
		isAC            bool
		origin, dest    string
		departAt        time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT b.booking_id::text, b.total_poisha, b.discount_poisha, b.created_at,
		       o.brand, o.legal_name, o.vat_bin, o.vat_rate_bp, bt.is_ac,
		       lo.name, ld.name, t.depart_at
		  FROM commerce.bookings b
		  JOIN catalog.trips t      ON t.trip_id = b.trip_id
		  JOIN catalog.operators o  ON o.operator_id = b.operator_id
		  JOIN catalog.buses bus    ON bus.bus_id = t.bus_id
		  JOIN catalog.bus_types bt ON bt.bus_type_id = bus.bus_type_id
		  JOIN catalog.route_stops rso ON rso.route_id = t.route_id AND rso.stop_seq = b.board_stop_seq
		  JOIN catalog.locations   lo  ON lo.location_id = rso.location_id
		  JOIN catalog.route_stops rsd ON rsd.route_id = t.route_id AND rsd.stop_seq = b.drop_stop_seq
		  JOIN catalog.locations   ld  ON ld.location_id = rsd.location_id
		 WHERE b.pnr = upper($1)`, pnr).
		Scan(&bookingID, &total, &discount, &createdAt, &brand, &legal, &vatBIN, &vatRateBp,
			&isAC, &origin, &dest, &departAt)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "booking_not_found", "We could not find a booking with that PNR.")
		return
	}
	if err != nil {
		s.log.Error("invoice", "err", err)
		fail(w, 500, "query_failed", "Could not load that booking.")
		return
	}

	// A Mushak 6.3 can only be issued by a VAT-registered supplier.
	if vatBIN == nil || *vatBIN == "" {
		fail(w, 404, "not_vat_registered",
			"This operator is not VAT-registered, so no Mushak 6.3 invoice is issued for this booking.")
		return
	}

	// Buyer: first passenger's name, and the booking contact phone. This endpoint
	// is reachable with the PNR alone (the PNR is the bearer capability, as with
	// /tracking and /cancellation-quote), so it discloses only what those already
	// do — name and phone. Email is deliberately NOT returned here: it added a
	// contactable identifier that a bare, guessed or observed PNR should not yield.
	var buyerName, phone string
	_ = s.pool.QueryRow(ctx,
		`SELECT COALESCE(full_name,'') FROM commerce.booking_passengers
		  WHERE booking_id=$1::uuid ORDER BY seat_no LIMIT 1`, bookingID).Scan(&buyerName)
	_ = s.pool.QueryRow(ctx,
		`SELECT COALESCE(phone,'') FROM commerce.booking_contacts
		  WHERE booking_id=$1::uuid LIMIT 1`, bookingID).Scan(&phone)

	// The transport fare the operator received = everything the passenger paid
	// except the platform's service fee. It is already net of any discount, and
	// VAT is charged on the actual consideration, so this is the taxable value.
	serviceFee := int64(serviceFeePoisha)
	fareGross := total - serviceFee
	if fareGross < 0 {
		fareGross = 0
	}

	effectiveRate := vatRateBp
	if !isAC {
		effectiveRate = 0 // non-AC intercity transport is VAT-exempt
	}
	base, vat := decomposeInclusiveVAT(fareGross, effectiveRate)

	writeJSON(w, 200, map[string]any{
		"invoice_no":   "MUSHAK6.3-" + pnr,
		"pnr":          pnr,
		"issued_at":    createdAt,
		"depart_at":    departAt,
		"seller":       invoiceParty{Name: legal, BIN: *vatBIN},
		"seller_brand": brand,
		"buyer":        invoiceParty{Name: buyerName, Phone: phone},
		"origin":       origin,
		"destination":  dest,
		"is_ac":        isAC,
		"vat_exempt":   !isAC,
		"transport": map[string]any{
			"rate_bp":      effectiveRate,
			"base_poisha":  base,
			"vat_poisha":   vat,
			"gross_poisha": fareGross,
		},
		"platform_fee_poisha": serviceFee,
		"discount_poisha":     discount,
		"total_poisha":        total,
	})
}

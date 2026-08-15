// Package eventwire connects the event backbone to the services that consume
// it: notifications, the search projection, operational alerting, analytics and
// partner webhooks.
//
// It exists so those services stay unaware of each other. The notification
// platform does not know how to read a booking; this package does, and hands it
// a resolved audience. That is the same seam commerce has with inventory — an
// interface instead of an import — and it is why swapping any of them for a
// real network call is a change here rather than everywhere.
package eventwire

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/analytics/analytics"
	"github.com/busticket/platform/services/events/events"
	"github.com/busticket/platform/services/notify/notify"
	"github.com/busticket/platform/services/ops/ops"
	"github.com/busticket/platform/services/partner/partner"
	"github.com/busticket/platform/services/promo/promo"
	"github.com/busticket/platform/services/searchidx/searchidx"
)

type Wiring struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	ntf  *notify.Service
	idx  *searchidx.Indexer

	// Attached after construction — see Attach.
	analytics *analytics.Store
	ops       *ops.Service
	partner   *partner.Service
	promo     *promo.Store
}

func New(pool *pgxpool.Pool, log *slog.Logger, ntf *notify.Service, idx *searchidx.Indexer) *Wiring {
	return &Wiring{pool: pool, log: log, ntf: ntf, idx: idx}
}

// Register binds every consumer group this build implements.
func (w *Wiring) Register(bus *events.Bus) {
	bus.Subscribe("notification-dispatcher", w.notificationHandler)
	bus.Subscribe("search-indexer", w.searchHandler)
	bus.Subscribe("analytics-ingest", w.analyticsHandler)
	bus.Subscribe("ops-alerting", w.opsHandler)
	bus.Subscribe("partner-webhooks", w.partnerHandler)
}

// Lag reports how far behind each consumer group is. The admin health page
// shows it, because "the event backbone is running" is not the same claim as
// "the event backbone is keeping up".
type ConsumerLag struct {
	Consumer  string    `json:"consumer"`
	Position  int64     `json:"position"`
	Head      int64     `json:"head"`
	Lag       int64     `json:"lag"`
	Delivered int64     `json:"delivered"`
	Failed    int64     `json:"failed"`
	DeadLetters int64   `json:"dead_letters"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (w *Wiring) Lag(ctx context.Context) ([]ConsumerLag, error) {
	rows, err := w.pool.Query(ctx, `
		SELECT c.consumer, c.position,
		       COALESCE((SELECT max(offset_id) FROM events.event_log e
		                  WHERE e.topic = ANY(c.topics)), 0) AS head,
		       c.delivered, c.failed,
		       (SELECT count(*) FROM events.dead_letters d
		         WHERE d.consumer = c.consumer AND d.resolved_at IS NULL),
		       c.updated_at
		  FROM events.consumers c ORDER BY c.consumer`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConsumerLag{}
	for rows.Next() {
		var l ConsumerLag
		if err := rows.Scan(&l.Consumer, &l.Position, &l.Head, &l.Delivered,
			&l.Failed, &l.DeadLetters, &l.UpdatedAt); err != nil {
			return nil, err
		}
		l.Lag = l.Head - l.Position
		if l.Lag < 0 {
			l.Lag = 0
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ------------------------------------------------------- notifications ------

func (w *Wiring) notificationHandler(ctx context.Context, e events.Envelope) error {
	var payload map[string]any
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return err
	}
	_, err := w.ntf.Dispatch(ctx, e.EventID, e.EventType, payload)
	return err
}

// ------------------------------------------------------------- search -------

func (w *Wiring) searchHandler(ctx context.Context, e events.Envelope) error {
	tripID := e.Str("trip_id")
	if tripID == "" {
		tripID = e.AggregateID
	}
	if tripID == "" {
		return nil
	}
	switch e.EventType {
	case "trip.cancelled":
		return w.idx.SetTripStatus(ctx, tripID, "CANCELLED")
	case "trip.departed":
		return w.idx.SetTripStatus(ctx, tripID, "DEPARTED")
	case "trip.arrived":
		return w.idx.SetTripStatus(ctx, tripID, "ARRIVED")
	case "seat.held", "seat.released", "seat.booked", "seat.blocked", "seat.quota_sold":
		return w.idx.TouchAvailability(ctx, tripID)
	}
	return w.idx.IndexTrip(ctx, tripID)
}

// --------------------------------------------------------- audiences --------

// Resolver turns an event into the people who should hear about it. It is the
// only code in the notification path that knows how to read a booking.
type Resolver struct {
	pool *pgxpool.Pool
	// controlRoom is where operational alerts go when there is nobody more
	// specific — a breakdown at 2am has to reach a human.
	controlRoom notify.Audience
}

func NewResolver(pool *pgxpool.Pool) *Resolver {
	return &Resolver{
		pool: pool,
		controlRoom: notify.Audience{
			UserKey: "control-room",
			Phone:   "+8801700000000",
			Email:   "control@jatra.test",
			Lang:    "en",
		},
	}
}

func (r *Resolver) Resolve(ctx context.Context, eventType string, payload map[string]any) ([]notify.Audience, error) {
	switch eventType {
	case "booking.confirmed", "booking.cancelled", "booking.rescheduled",
		"payment.failed", "refund.completed", "ticket.issued":
		return r.forBooking(ctx, str(payload["pnr"]), payload)

	case "trip.cancelled", "trip.delayed", "bus.approaching":
		return r.forTrip(ctx, str(payload["trip_id"]), payload)

	case "incident.reported":
		return r.forIncident(ctx, str(payload["trip_id"]), payload)

	case "wallet.low", "wallet.recharged":
		return r.forAgency(ctx, str(payload["agency_id"]), payload)

	case "settlement.paid", "settlement.approved":
		return r.forOperator(ctx, str(payload["operator_id"]), payload)
	}
	return nil, nil
}

func (r *Resolver) forBooking(ctx context.Context, pnr string, payload map[string]any) ([]notify.Audience, error) {
	if pnr == "" {
		return nil, nil
	}
	var a notify.Audience
	var total int64
	var departs time.Time
	var seats, route, brand, bookingID, userID string
	err := r.pool.QueryRow(ctx, `
		SELECT b.booking_id::text, COALESCE(b.user_id::text,''),
		       COALESCE(c.phone,''), COALESCE(c.email,''),
		       b.total_poisha, t.depart_at, rt.name, o.brand,
		       COALESCE((SELECT string_agg(seat_no, ', ' ORDER BY seat_no)
		                   FROM commerce.booking_seats WHERE booking_id = b.booking_id), '')
		  FROM commerce.bookings b
		  LEFT JOIN commerce.booking_contacts c ON c.booking_id = b.booking_id
		  JOIN catalog.trips t     ON t.trip_id = b.trip_id
		  JOIN catalog.routes rt   ON rt.route_id = t.route_id
		  JOIN catalog.operators o ON o.operator_id = b.operator_id
		 WHERE b.pnr = $1`, pnr).
		Scan(&bookingID, &userID, &a.Phone, &a.Email, &total, &departs, &route, &brand, &seats)
	if errors.Is(err, pgx.ErrNoRows) {
		// The booking is gone. Nothing to send and nothing to retry — a poisoned
		// message must not be able to hold a consumer group hostage.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve booking %s: %w", pnr, err)
	}
	if a.Phone == "" && a.Email == "" {
		return nil, nil // a counter walk-up who gave no contact details
	}
	a.UserKey = a.Phone
	a.BookingID = bookingID
	a.UserID = userID
	a.Vars = map[string]string{
		"pnr":      pnr,
		"route":    route,
		"operator": brand,
		"departs":  notify.Localtime(departs),
		"seats":    seats,
		"total":    notify.Taka(total),
		"refund":   notify.Taka(int64(num(payload["refund_poisha"]))),
		"minutes":  str(payload["minutes"]),
	}
	// A push token would come from the mobile app's device registration. There
	// is no app in this build, so PUSH simply has no address and is skipped —
	// visibly, in the delivery log, rather than silently.
	return []notify.Audience{a}, nil
}

func (r *Resolver) forTrip(ctx context.Context, tripID string, payload map[string]any) ([]notify.Audience, error) {
	if tripID == "" {
		return nil, nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT b.pnr, b.booking_id::text, COALESCE(b.user_id::text,''),
		       COALESCE(c.phone,''), COALESCE(c.email,''),
		       t.depart_at, rt.name, b.total_poisha,
		       COALESCE((SELECT string_agg(seat_no, ', ' ORDER BY seat_no)
		                   FROM commerce.booking_seats WHERE booking_id = b.booking_id), '')
		  FROM commerce.bookings b
		  LEFT JOIN commerce.booking_contacts c ON c.booking_id = b.booking_id
		  JOIN catalog.trips t   ON t.trip_id = b.trip_id
		  JOIN catalog.routes rt ON rt.route_id = t.route_id
		 WHERE b.trip_id = $1::uuid AND b.status IN ('CONFIRMED','TICKETED')`, tripID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []notify.Audience{}
	for rows.Next() {
		var a notify.Audience
		var pnr, route, seats string
		var total int64
		var departs time.Time
		if err := rows.Scan(&pnr, &a.BookingID, &a.UserID, &a.Phone, &a.Email,
			&departs, &route, &total, &seats); err != nil {
			return nil, err
		}
		if a.Phone == "" && a.Email == "" {
			continue
		}
		a.UserKey = a.Phone
		a.Vars = map[string]string{
			"pnr": pnr, "route": route, "seats": seats,
			"departs": notify.Localtime(departs), "total": notify.Taka(total),
			"minutes":   str(payload["minutes"]),
			"stop_name": str(payload["stop_name"]),
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *Resolver) forIncident(ctx context.Context, tripID string, payload map[string]any) ([]notify.Audience, error) {
	a := r.controlRoom
	a.Vars = map[string]string{
		"kind": str(payload["kind"]),
		"note": str(payload["note"]),
	}
	var route, bus, phone, email string
	err := r.pool.QueryRow(ctx, `
		SELECT rt.name, b.registration,
		       COALESCE(o.contact_phone,''), COALESCE(o.contact_email,'')
		  FROM catalog.trips t
		  JOIN catalog.routes rt   ON rt.route_id = t.route_id
		  JOIN catalog.buses b     ON b.bus_id = t.bus_id
		  JOIN catalog.operators o ON o.operator_id = t.operator_id
		 WHERE t.trip_id = $1::uuid`, tripID).Scan(&route, &bus, &phone, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.Vars["route"], a.Vars["bus"] = route, bus

	// Both the operator and the platform control room hear about it. An
	// incident that only reaches one of them is how a bus stays broken down.
	op := notify.Audience{UserKey: "operator:" + route, Phone: phone, Email: email, Lang: "bn", Vars: a.Vars}
	return []notify.Audience{a, op}, nil
}

func (r *Resolver) forAgency(ctx context.Context, agencyID string, payload map[string]any) ([]notify.Audience, error) {
	if agencyID == "" {
		return nil, nil
	}
	var a notify.Audience
	var name string
	err := r.pool.QueryRow(ctx, `
		SELECT name, COALESCE(phone,''), COALESCE(contact_email,'')
		  FROM agent.agencies WHERE agency_id = $1::uuid`, agencyID).
		Scan(&name, &a.Phone, &a.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.UserKey = "agency:" + agencyID
	a.Vars = map[string]string{
		"agency":    name,
		"available": notify.Taka(int64(num(payload["available_poisha"]))),
		"amount":    notify.Taka(int64(num(payload["amount_poisha"]))),
	}
	return []notify.Audience{a}, nil
}

func (r *Resolver) forOperator(ctx context.Context, operatorID string, payload map[string]any) ([]notify.Audience, error) {
	if operatorID == "" {
		return nil, nil
	}
	var a notify.Audience
	var brand string
	err := r.pool.QueryRow(ctx, `
		SELECT brand, COALESCE(contact_phone,''), COALESCE(contact_email,'')
		  FROM catalog.operators WHERE operator_id = $1::uuid`, operatorID).
		Scan(&brand, &a.Phone, &a.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.UserKey = "operator:" + operatorID
	a.Vars = map[string]string{
		"operator": brand,
		"period":   str(payload["period"]),
		"amount":   notify.Taka(int64(num(payload["amount_poisha"]))),
	}
	return []notify.Audience{a}, nil
}

// ------------------------------------------------------------- courier ------

// Courier lets identity-service send an OTP without importing the notification
// platform or knowing that templates exist.
type Courier struct{ ntf *notify.Service }

func NewCourier(n *notify.Service) *Courier { return &Courier{ntf: n} }

func (c *Courier) SendOTP(ctx context.Context, phone, code, lang string) error {
	return c.ntf.SendNow(ctx, "auth.otp", notify.Audience{
		UserKey: phone,
		Phone:   phone,
		Lang:    lang,
		Vars:    map[string]string{"code": code},
	})
}

// ------------------------------------------------------------- helpers ------

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

package eventwire

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/busticket/platform/services/analytics/analytics"
	"github.com/busticket/platform/services/events/events"
	"github.com/busticket/platform/services/ops/ops"
	"github.com/busticket/platform/services/partner/partner"
	"github.com/busticket/platform/services/promo/promo"
)

// The remaining consumer groups. Each is idempotent by construction rather than
// by checking first, because a consumer that dies between acting and
// checkpointing will be handed the same event again.

// Attach gives the wiring the services its later consumers need. They are set
// after construction because the analytics store, the control centre and the
// partner service are themselves wired against the same pool.
func (w *Wiring) Attach(a *analytics.Store, o *ops.Service, p *partner.Service, pr *promo.Store) {
	w.analytics = a
	w.ops = o
	w.partner = p
	w.promo = pr
}

func (w *Wiring) analyticsHandler(ctx context.Context, e events.Envelope) error {
	if w.analytics == nil {
		return nil
	}
	var p map[string]any
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return err
	}
	// Everything the fact needs comes out of the event itself. Enriching from
	// the booking tables here would put reporting load back on the database the
	// plan says it must never touch.
	seats := 0
	if v, ok := p["seat_count"].(float64); ok {
		seats = int(v)
	}
	amount := int64(num(p["total_poisha"]))
	if amount == 0 {
		amount = int64(num(p["amount_poisha"]))
	}
	return w.analytics.Ingest(ctx, analytics.Fact{
		EventID:      e.EventID,
		EventType:    e.EventType,
		OccurredAt:   e.OccurredAt,
		OperatorID:   str(p["operator_id"]),
		TripID:       str(p["trip_id"]),
		RouteName:    str(p["route"]),
		Channel:      str(p["channel"]),
		PNR:          str(p["pnr"]),
		Seats:        seats,
		AmountPoisha: amount,
		Payload:      e.Payload,
	})
}

func (w *Wiring) opsHandler(ctx context.Context, e events.Envelope) error {
	if w.ops == nil {
		return nil
	}
	tripID := e.Str("trip_id")
	if tripID == "" {
		tripID = e.AggregateID
	}
	detail := e.Str("note")
	if detail == "" {
		detail = e.Str("reason")
	}
	if e.EventType == "incident.reported" && e.Str("kind") != "" {
		detail = e.Str("kind") + ": " + detail
	}
	return w.ops.RaiseFromEvent(ctx, e.EventType, tripID, detail)
}

func (w *Wiring) partnerHandler(ctx context.Context, e events.Envelope) error {
	if w.partner == nil {
		return nil
	}
	_, err := w.partner.Enqueue(ctx, e.EventID, e.EventType, e.Payload)
	return err
}

// referralHandler qualifies a referral when the invitee's first paid booking
// lands. It rides on the notification consumer's topics because the trigger is
// the same event, and it is deliberately best-effort: a referral reward that
// fails to issue must never fail a booking.
func (w *Wiring) qualifyReferral(ctx context.Context, log *slog.Logger, phone, bookingID string) {
	if w.promo == nil || phone == "" {
		return
	}
	if _, err := w.promo.Qualify(ctx, phone, bookingID); err != nil {
		log.Warn("referral qualification failed", "err", err, "booking", bookingID)
	}
}

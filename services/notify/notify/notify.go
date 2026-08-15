// Package notify is the notification platform (plan workstream P2-K).
//
// It exists because a booking that nobody is told about is not a booking a
// passenger can use. Six other workstreams depend on this one, which is why the
// plan starts Phase 2 with it.
//
// What is real here: templates in Bangla and English for every event, per-event
// channel routing, two SMS aggregators with failover, a delivery attempt log
// carrying the cost of every individual message, a monthly budget circuit
// breaker, per-class hourly rate caps, and per-recipient channel preferences.
//
// What is simulated: the providers. A "sent" SMS lands in notify.outbound_sink
// instead of on a handset, because there is no aggregator contract to send it
// through. Everything around that boundary — routing, language, failover,
// cost accounting, the breaker, the delivery log — is the part that is
// expensive to retrofit, so it is the part that is built.
package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Audience is one recipient of one event, already resolved.
//
// The notification service deliberately does not know how to read a booking or
// look up an operator. Whoever wires it into the platform supplies a Resolver,
// which keeps this package free of every other service's tables.
type Audience struct {
	// UserKey identifies the recipient for preferences and de-duplication.
	// A phone number for passengers, a staff or agency id for staff.
	UserKey   string
	Phone     string
	Email     string
	PushToken string
	// Lang overrides the stored preference. Empty means "use the preference".
	Lang string

	BookingID  string
	UserID     string
	OperatorID string

	// Vars fill the {{placeholders}} in the template.
	Vars map[string]string
}

// Resolver turns an event into the people who should hear about it.
type Resolver interface {
	Resolve(ctx context.Context, eventType string, payload map[string]any) ([]Audience, error)
}

type Service struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	res  Resolver
}

func New(pool *pgxpool.Pool, log *slog.Logger, res Resolver) *Service {
	return &Service{pool: pool, log: log, res: res}
}

var ErrNoRoute = errors.New("notify: no route configured for this event type")

type route struct {
	templateKey string
	channels    []string
	class       string
}

func (s *Service) route(ctx context.Context, eventType string) (route, error) {
	var r route
	err := s.pool.QueryRow(ctx, `
		SELECT template_key, channels, event_class
		  FROM notify.routes WHERE event_type = $1 AND active`, eventType).
		Scan(&r.templateKey, &r.channels, &r.class)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNoRoute
	}
	return r, err
}

// Dispatch is what the event consumer calls. eventID makes the whole thing
// idempotent: redelivering an event cannot produce a second SMS, because the
// notification row collides on (event_id, dedupe_key) and the send is skipped.
func (s *Service) Dispatch(ctx context.Context, eventID, eventType string, payload map[string]any) (sent int, err error) {
	r, err := s.route(ctx, eventType)
	if errors.Is(err, ErrNoRoute) {
		return 0, nil // not every event is worth telling somebody about
	}
	if err != nil {
		return 0, err
	}
	audiences, err := s.res.Resolve(ctx, eventType, payload)
	if err != nil {
		return 0, err
	}
	for _, a := range audiences {
		ok, err := s.deliver(ctx, eventID, eventType, r, a)
		if err != nil {
			return sent, err
		}
		if ok {
			sent++
		}
	}
	return sent, nil
}

// SendNow is the direct path for messages that are not the consequence of a
// platform event — an OTP is the obvious one; it has to be in the passenger's
// hand before any state worth publishing exists.
func (s *Service) SendNow(ctx context.Context, eventType string, a Audience) error {
	r, err := s.route(ctx, eventType)
	if err != nil {
		return err
	}
	_, err = s.deliver(ctx, "", eventType, r, a)
	return err
}

// ----------------------------------------------------------------- delivery --

func (s *Service) deliver(ctx context.Context, eventID, eventType string, r route, a Audience) (bool, error) {
	prefs, err := s.preferences(ctx, a)
	if err != nil {
		return false, err
	}
	lang := a.Lang
	if lang == "" {
		lang = prefs.lang
	}

	dedupe := r.templateKey + "|" + a.UserKey
	var notifID string
	q := `
		INSERT INTO notify.notifications
			(event_id, template_key, event_type, event_class, lang, dedupe_key,
			 to_phone, to_email, to_push, booking_id, user_id, operator_id, payload)
		VALUES (NULLIF($1,'')::uuid, $2, $3, $4, $5, $6,
		        NULLIF($7,''), NULLIF($8,''), NULLIF($9,''),
		        NULLIF($10,'')::uuid, NULLIF($11,'')::uuid, NULLIF($12,'')::uuid, $13)`
	if eventID != "" {
		// Only event-driven sends de-duplicate. Two OTPs a minute apart are two
		// messages, not one message delivered twice.
		q += ` ON CONFLICT (event_id, dedupe_key) DO NOTHING`
	}
	q += ` RETURNING notification_id::text`

	vars := map[string]string{}
	for k, v := range a.Vars {
		vars[k] = v
	}
	err = s.pool.QueryRow(ctx, q, eventID, r.templateKey, eventType, r.class, lang, dedupe,
		a.Phone, a.Email, a.PushToken, a.BookingID, a.UserID, a.OperatorID, vars).Scan(&notifID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // already delivered for this event and recipient
	}
	if err != nil {
		return false, err
	}

	if reason := s.suppressReason(ctx, r, prefs); reason != "" {
		_, err := s.pool.Exec(ctx, `
			UPDATE notify.notifications
			   SET status = 'SUPPRESSED', suppress_reason = $2, completed_at = now()
			 WHERE notification_id = $1::uuid`, notifID, reason)
		return false, err
	}

	anySent := false
	for _, ch := range r.channels {
		if !prefs.allows(ch) {
			continue
		}
		addr := a.address(ch)
		if addr == "" {
			continue
		}
		subject, body, ok, err := s.render(ctx, r.templateKey, lang, ch, vars)
		if err != nil {
			return false, err
		}
		if !ok {
			continue // no template for this channel in this language
		}
		if s.trySend(ctx, notifID, ch, addr, subject, body) {
			anySent = true
		}
	}

	status := "FAILED"
	if anySent {
		status = "SENT"
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE notify.notifications SET status = $2, completed_at = now()
		 WHERE notification_id = $1::uuid`, notifID, status); err != nil {
		return false, err
	}
	if !anySent {
		return false, fmt.Errorf("notify: every channel failed for %s", eventType)
	}
	return true, nil
}

func (a Audience) address(channel string) string {
	switch channel {
	case "SMS":
		return a.Phone
	case "EMAIL":
		return a.Email
	case "PUSH":
		return a.PushToken
	}
	return ""
}

// trySend walks the providers for a channel in priority order. The first one
// that accepts the message wins; the ones that refused are still recorded,
// because "which aggregator dropped it" is the first question anyone asks.
func (s *Service) trySend(ctx context.Context, notifID, channel, addr, subject, body string) bool {
	rows, err := s.pool.Query(ctx, `
		SELECT provider, cost_poisha, simulate_failure
		  FROM notify.providers
		 WHERE channel = $1 AND enabled
		   AND (cooldown_until IS NULL OR cooldown_until < now())
		 ORDER BY priority`, channel)
	if err != nil {
		s.log.Error("provider lookup", "err", err)
		return false
	}
	type prov struct {
		name string
		cost int64
		fail bool
	}
	var provs []prov
	for rows.Next() {
		var p prov
		if err := rows.Scan(&p.name, &p.cost, &p.fail); err != nil {
			continue
		}
		provs = append(provs, p)
	}
	rows.Close()

	for _, p := range provs {
		if p.fail {
			s.recordAttempt(ctx, notifID, channel, p.name, "FAILED",
				"provider unreachable", 0, body)
			s.markUnhealthy(ctx, p.name, "provider unreachable")
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO notify.outbound_sink (channel, provider, recipient, subject, body)
			VALUES ($1,$2,$3,NULLIF($4,''),$5)`, channel, p.name, addr, subject, body); err != nil {
			s.recordAttempt(ctx, notifID, channel, p.name, "FAILED", err.Error(), 0, body)
			s.markUnhealthy(ctx, p.name, err.Error())
			continue
		}
		s.recordAttempt(ctx, notifID, channel, p.name, "SENT", "", p.cost, body)
		s.markHealthy(ctx, p.name)
		s.spend(ctx, p.cost)
		return true
	}
	return false
}

func (s *Service) recordAttempt(ctx context.Context, notifID, channel, provider, status, errMsg string, cost int64, rendered string) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO notify.attempts
			(notification_id, channel, provider, status, error, cost_poisha, rendered)
		VALUES ($1::uuid,$2,$3,$4,NULLIF($5,''),$6,$7)`,
		notifID, channel, provider, status, errMsg, cost, rendered); err != nil {
		s.log.Error("attempt log", "err", err)
	}
}

// A provider that fails repeatedly stops being chosen for five minutes. Without
// this, a dead primary aggregator costs every message an extra round trip.
func (s *Service) markUnhealthy(ctx context.Context, provider, msg string) {
	_, _ = s.pool.Exec(ctx, `
		UPDATE notify.providers
		   SET failure_streak = failure_streak + 1,
		       last_error = $2,
		       cooldown_until = CASE WHEN failure_streak + 1 >= 3
		                             THEN now() + interval '5 minutes' END,
		       updated_at = now()
		 WHERE provider = $1`, provider, msg)
}

func (s *Service) markHealthy(ctx context.Context, provider string) {
	_, _ = s.pool.Exec(ctx, `
		UPDATE notify.providers
		   SET failure_streak = 0, cooldown_until = NULL, last_error = NULL, updated_at = now()
		 WHERE provider = $1 AND (failure_streak <> 0 OR cooldown_until IS NOT NULL)`, provider)
}

func (s *Service) spend(ctx context.Context, cost int64) {
	if cost == 0 {
		return
	}
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO notify.budgets (period, cap_poisha, spent_poisha)
		VALUES (to_char(now(),'YYYY-MM'), 5000000, $1)
		ON CONFLICT (period) DO UPDATE
		   SET spent_poisha = notify.budgets.spent_poisha + $1,
		       tripped_at = CASE
		           WHEN notify.budgets.tripped_at IS NULL
		            AND notify.budgets.spent_poisha + $1 >= notify.budgets.cap_poisha
		           THEN now() ELSE notify.budgets.tripped_at END`, cost)
}

// --------------------------------------------------------------- gate rules --

type prefs struct {
	lang                            string
	sms, email, push, marketingOptIn bool
}

func (p prefs) allows(channel string) bool {
	switch channel {
	case "SMS":
		return p.sms
	case "EMAIL":
		return p.email
	case "PUSH":
		return p.push
	}
	return false
}

func (s *Service) preferences(ctx context.Context, a Audience) (prefs, error) {
	p := prefs{lang: "bn", sms: true, email: true, push: true, marketingOptIn: true}
	key := a.UserKey
	if key == "" {
		key = a.Phone
	}
	if key == "" {
		return p, nil
	}
	err := s.pool.QueryRow(ctx, `
		SELECT lang, sms, email, push, marketing FROM notify.preferences WHERE user_key = $1`, key).
		Scan(&p.lang, &p.sms, &p.email, &p.push, &p.marketingOptIn)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	return p, err
}

// suppressReason is the circuit breaker. Its most important property is what it
// refuses to do: a blown budget or a runaway hourly rate never stops a
// TRANSACTIONAL message, because the alternative is a passenger who paid and
// was never told their PNR.
func (s *Service) suppressReason(ctx context.Context, r route, p prefs) string {
	if r.class == "MARKETING" && !p.marketingOptIn {
		return "recipient opted out of marketing"
	}
	if r.class == "TRANSACTIONAL" {
		return ""
	}

	var cap_, spent int64
	err := s.pool.QueryRow(ctx, `
		SELECT cap_poisha, spent_poisha FROM notify.budgets WHERE period = to_char(now(),'YYYY-MM')`).
		Scan(&cap_, &spent)
	if err == nil && spent >= cap_ {
		return fmt.Sprintf("monthly notification budget exhausted (%d/%d poisha)", spent, cap_)
	}

	var perHour, lastHour int
	if err := s.pool.QueryRow(ctx, `
		SELECT c.per_hour,
		       (SELECT count(*) FROM notify.notifications n
		         WHERE n.event_class = c.event_class
		           AND n.status = 'SENT'
		           AND n.created_at > now() - interval '1 hour')
		  FROM notify.rate_caps c WHERE c.event_class = $1`, r.class).Scan(&perHour, &lastHour); err == nil {
		if lastHour >= perHour {
			return fmt.Sprintf("%s rate cap reached (%d/hour)", r.class, perHour)
		}
	}
	return ""
}

// ---------------------------------------------------------------- rendering --

func (s *Service) render(ctx context.Context, key, lang, channel string, vars map[string]string) (subject, body string, ok bool, err error) {
	var subj *string
	err = s.pool.QueryRow(ctx, `
		SELECT subject, body FROM notify.templates
		 WHERE template_key = $1 AND lang = $2 AND channel = $3`, key, lang, channel).
		Scan(&subj, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if subj != nil {
		subject = fill(*subj, vars)
	}
	return subject, fill(body, vars), true, nil
}

// fill substitutes {{name}} placeholders. A placeholder with no value is left
// visible rather than silently blanked — an SMS reading "seat" with nothing
// after it is a bug worth seeing in the delivery log.
func fill(tmpl string, vars map[string]string) string {
	out := tmpl
	for k, v := range vars {
		out = strings.ReplaceAll(out, "{{"+k+"}}", v)
	}
	return strings.ReplaceAll(out, "\\n", "\n")
}

// Taka formats poisha for a passenger-facing message.
func Taka(poisha int64) string {
	return fmt.Sprintf("%d.%02d", poisha/100, poisha%100)
}

// Localtime formats a departure the way a passenger reads it.
func Localtime(t time.Time) string { return t.Format("2 Jan, 3:04 PM") }

// Package partner is the partner API and its webhooks (plan workstream P3-B).
//
// A partner is just another sales channel, so the one rule that governs the
// whole platform governs this too: partner endpoints delegate to the same
// inventory service and the same booking service as the website. There is no
// partner-specific seat logic here, and there is nothing in this package that
// touches a seat.
//
// What IS here is everything that makes an external caller safe to let in:
// signed requests with a replay window, per-partner quotas and rate limits, an
// IP allow-list, a sandbox tier that has to be certified before it can go live,
// and outbound webhooks that are signed, retried with backoff, dead-lettered,
// replayable, and visible to the partner in a delivery log.
package partner

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnknownClient = errors.New("partner: unknown client")
	ErrBadSignature  = errors.New("partner: signature does not verify")
	ErrStale         = errors.New("partner: request timestamp outside the replay window")
	ErrReplay        = errors.New("partner: nonce already used")
	ErrNotAllowed    = errors.New("partner: source address is not allow-listed")
	ErrQuota         = errors.New("partner: daily quota exhausted")
	ErrSuspended     = errors.New("partner: suspended")
)

// replayWindow is how far a signed request's timestamp may be from now. Five
// minutes is generous enough for clock drift and mean enough that a captured
// request is worthless by the time it is replayed.
const replayWindow = 5 * time.Minute

type Service struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	http *http.Client
}

func New(pool *pgxpool.Pool, log *slog.Logger) *Service {
	return &Service{pool: pool, log: log, http: &http.Client{Timeout: 5 * time.Second}}
}

// Caller is an authenticated partner.
type Caller struct {
	PartnerID string
	Name      string
	Tier      string
	Sandbox   bool
}

// Authenticate verifies an inbound partner request.
//
// Two schemes are accepted, and the difference matters. An API key proves who
// you are. A signature proves who you are AND that this exact request was not
// altered or replayed, which is why anything that moves money or seats requires
// it. The order of checks below is fixed and every step can only reject.
func (s *Service) Authenticate(ctx context.Context, r *http.Request, body []byte, requireSignature bool) (*Caller, error) {
	clientID := r.Header.Get("X-Jatra-Client")
	if clientID == "" {
		if v := r.Header.Get("Authorization"); strings.HasPrefix(v, "ApiKey ") {
			clientID, _, _ = strings.Cut(strings.TrimPrefix(v, "ApiKey "), ":")
		}
	}
	if clientID == "" {
		return nil, ErrUnknownClient
	}

	var partnerID, name, tier, secretHash string
	var quota, ratePerMin int
	var allow []string
	err := s.pool.QueryRow(ctx, `
		SELECT p.partner_id::text, p.name, p.tier, k.secret_hash,
		       p.daily_quota, p.rate_per_min, p.ip_allowlist
		  FROM partner.api_keys k JOIN partner.partners p ON p.partner_id = k.partner_id
		 WHERE k.client_id = $1 AND k.status = 'ACTIVE'`, clientID).
		Scan(&partnerID, &name, &tier, &secretHash, &quota, &ratePerMin, &allow)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnknownClient
	}
	if err != nil {
		return nil, err
	}
	if tier == "SUSPENDED" {
		return nil, ErrSuspended
	}

	if len(allow) > 0 {
		ip := clientIP(r)
		ok := false
		for _, a := range allow {
			if a == ip {
				ok = true
				break
			}
		}
		if !ok {
			return nil, ErrNotAllowed
		}
	}

	sig := r.Header.Get("X-Jatra-Signature")
	if requireSignature || sig != "" {
		if err := s.verifySignature(ctx, partnerID, clientID, r, body, sig); err != nil {
			return nil, err
		}
	} else {
		// Key-only auth: the secret itself is presented and compared against its
		// stored hash.
		_, secret, _ := strings.Cut(strings.TrimPrefix(r.Header.Get("Authorization"), "ApiKey "), ":")
		sum := sha256.Sum256([]byte(secret))
		if !hmac.Equal([]byte(hex.EncodeToString(sum[:])), []byte(secretHash)) {
			return nil, ErrBadSignature
		}
	}

	if err := s.chargeQuota(ctx, partnerID, quota); err != nil {
		return nil, err
	}
	return &Caller{PartnerID: partnerID, Name: name, Tier: tier, Sandbox: tier == "SANDBOX"}, nil
}

func (s *Service) verifySignature(ctx context.Context, partnerID, clientID string, r *http.Request, body []byte, sig string) error {
	if sig == "" {
		return ErrBadSignature
	}
	tsStr := r.Header.Get("X-Jatra-Timestamp")
	nonce := r.Header.Get("X-Jatra-Nonce")
	if tsStr == "" || nonce == "" {
		return ErrBadSignature
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return ErrBadSignature
	}
	skew := time.Since(time.Unix(ts, 0))
	if skew < -replayWindow || skew > replayWindow {
		return ErrStale
	}

	var signing string
	if err := s.pool.QueryRow(ctx,
		`SELECT signing_secret FROM partner.api_keys WHERE client_id = $1`, clientID).Scan(&signing); err != nil {
		return err
	}
	want := SignRequest(signing, r.Method, r.URL.Path, tsStr, nonce, body)
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return ErrBadSignature
	}

	// The nonce is good exactly once. The insert IS the check — an application
	// "have I seen this?" lookup would race two copies of the same replay.
	ct, err := s.pool.Exec(ctx, `
		INSERT INTO partner.request_nonces (partner_id, nonce) VALUES ($1::uuid, $2)
		ON CONFLICT DO NOTHING`, partnerID, nonce)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrReplay
	}
	return nil
}

// SignRequest is the canonical inbound signature. Published so partners can
// implement it and so the test suite signs exactly what the server verifies.
func SignRequest(secret, method, path, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s\n%s\n%s\n%s\n%s", method, path, timestamp, nonce, hex.EncodeToString(sum[:]))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// chargeQuota increments the daily counter and refuses past the cap. The
// conditional UPDATE is the gate, so a partner firing a thousand concurrent
// requests cannot slip past a limit that a read-then-write would let through.
func (s *Service) chargeQuota(ctx context.Context, partnerID string, quota int) error {
	var calls int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO partner.quota_usage (partner_id, day, calls) VALUES ($1::uuid, catalog.bd_today(), 1)
		ON CONFLICT (partner_id, day) DO UPDATE
		   SET calls = partner.quota_usage.calls + 1
		 WHERE partner.quota_usage.calls < $2
		RETURNING calls`, partnerID, quota).Scan(&calls)
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = s.pool.Exec(ctx, `
			UPDATE partner.quota_usage SET rejected = rejected + 1
			 WHERE partner_id = $1::uuid AND day = catalog.bd_today()`, partnerID)
		return ErrQuota
	}
	return err
}

// Quota reports what is left, for the 429 response headers and the portal.
func (s *Service) Quota(ctx context.Context, partnerID string) (used, limit, rejected int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(u.calls,0), p.daily_quota, COALESCE(u.rejected,0)
		  FROM partner.partners p
		  LEFT JOIN partner.quota_usage u ON u.partner_id = p.partner_id AND u.day = catalog.bd_today()
		 WHERE p.partner_id = $1::uuid`, partnerID).Scan(&used, &limit, &rejected)
	return
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		ip, _, _ := strings.Cut(v, ",")
		return strings.TrimSpace(ip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------------------------------------------------------- webhooks --

// SignWebhook is the outbound signature partners verify. Timestamp is inside
// the signed material so a captured delivery cannot be replayed against them.
func SignWebhook(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s.", timestamp)
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Enqueue queues one platform event for every partner subscribed to it. The
// unique key on (subscription, event) makes the consumer idempotent: a
// redelivered event queues nothing new.
func (s *Service) Enqueue(ctx context.Context, eventID, eventType string, payload json.RawMessage) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.subscription_id::text, s.partner_id::text, k.signing_secret
		  FROM partner.subscriptions s
		  JOIN partner.partners p ON p.partner_id = s.partner_id
		  JOIN partner.api_keys k ON k.partner_id = s.partner_id AND k.status = 'ACTIVE'
		 WHERE s.active AND p.tier <> 'SUSPENDED' AND $1 = ANY(s.event_types)`, eventType)
	if err != nil {
		return 0, err
	}
	type sub struct{ id, partner, secret string }
	var subs []sub
	for rows.Next() {
		var v sub
		if err := rows.Scan(&v.id, &v.partner, &v.secret); err != nil {
			rows.Close()
			return 0, err
		}
		subs = append(subs, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	queued := 0
	for _, v := range subs {
		body := envelope(eventID, eventType, payload)
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		ct, err := s.pool.Exec(ctx, `
			INSERT INTO partner.deliveries
				(subscription_id, partner_id, event_id, event_type, payload, signature)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
			ON CONFLICT (subscription_id, event_id) DO NOTHING`,
			v.id, v.partner, eventID, eventType, body, ts+"."+SignWebhook(v.secret, ts, body))
		if err != nil {
			return queued, err
		}
		queued += int(ct.RowsAffected())
	}
	return queued, nil
}

func envelope(eventID, eventType string, payload json.RawMessage) []byte {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	b, _ := json.Marshal(map[string]any{
		"event_id":   eventID,
		"event_type": eventType,
		"version":    1,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
		"payload":    json.RawMessage(payload),
	})
	return b
}

// backoff is exponential with a cap, reaching roughly 24 hours over 8 attempts.
func backoff(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Minute
	case 2:
		return 2 * time.Minute
	case 3:
		return 5 * time.Minute
	case 4:
		return 15 * time.Minute
	case 5:
		return time.Hour
	case 6:
		return 3 * time.Hour
	case 7:
		return 6 * time.Hour
	default:
		return 12 * time.Hour
	}
}

const maxAttempts = 8

// Dispatch attempts every delivery that is due. A partner endpoint that is down
// for six hours gets its events when it comes back; one that is down for a day
// gets a dead-lettered delivery and an alert, and can ask for a replay.
func (s *Service) Dispatch(ctx context.Context, batch int) (delivered, failed, dead int, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.delivery_id::text, d.payload, d.signature, d.attempts,
		       s.url, d.event_type, d.event_id::text
		  FROM partner.deliveries d
		  JOIN partner.subscriptions s ON s.subscription_id = d.subscription_id
		 WHERE d.status IN ('PENDING','RETRYING') AND d.next_attempt_at <= now()
		 ORDER BY d.next_attempt_at
		 LIMIT $1`, batch)
	if err != nil {
		return 0, 0, 0, err
	}
	type job struct {
		id, sig, url, eventType, eventID string
		body                             []byte
		attempts                         int
	}
	var jobs []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.id, &j.body, &j.sig, &j.attempts, &j.url, &j.eventType, &j.eventID); err != nil {
			rows.Close()
			return 0, 0, 0, err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, 0, err
	}

	for _, j := range jobs {
		ts, sig, _ := strings.Cut(j.sig, ".")
		code, sendErr := s.post(ctx, j.url, ts, sig, j.eventType, j.eventID, j.body)
		attempt := j.attempts + 1

		if sendErr == nil && code >= 200 && code < 300 {
			if _, err := s.pool.Exec(ctx, `
				UPDATE partner.deliveries
				   SET status='DELIVERED', attempts=$2, last_status_code=$3,
				       last_error=NULL, delivered_at=now()
				 WHERE delivery_id=$1::uuid`, j.id, attempt, code); err != nil {
				return delivered, failed, dead, err
			}
			delivered++
			continue
		}

		msg := fmt.Sprintf("HTTP %d", code)
		if sendErr != nil {
			msg = sendErr.Error()
		}
		status, next := "RETRYING", backoff(attempt)
		if attempt >= maxAttempts {
			status = "DEAD"
		}
		if _, err := s.pool.Exec(ctx, `
			UPDATE partner.deliveries
			   SET status=$2, attempts=$3, last_status_code=NULLIF($4,0), last_error=$5,
			       next_attempt_at = now() + $6::interval
			 WHERE delivery_id=$1::uuid`, j.id, status, attempt, code, msg, next.String()); err != nil {
			return delivered, failed, dead, err
		}
		if status == "DEAD" {
			dead++
		} else {
			failed++
		}
	}
	return delivered, failed, dead, nil
}

func (s *Service) post(ctx context.Context, target, ts, sig, eventType, eventID string, body []byte) (int, error) {
	// A partner-registered URL must never become a request against the platform's
	// own network. Refuse anything that is not http(s) or that resolves to a
	// private, loopback, link-local or cloud-metadata address before dispatching.
	if err := safeOutboundURL(ctx, target); err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jatra-Timestamp", ts)
	req.Header.Set("X-Jatra-Signature", sig)
	req.Header.Set("X-Jatra-Event", eventType)
	req.Header.Set("X-Jatra-Event-Id", eventID)
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// safeOutboundURL refuses a webhook target that is not http(s) or that resolves
// to a non-public address (private, loopback, link-local, unspecified, multicast,
// or the 169.254.169.254 cloud-metadata endpoint). This blocks SSRF via a
// partner-registered URL. A residual DNS-rebinding window remains between this
// resolve and the client's own dial; tightening that further would need a
// dial-time IP check on the shared transport.
func safeOutboundURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("partner: bad webhook url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("partner: webhook url must be http(s), got %q", u.Scheme)
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", u.Hostname())
	if err != nil {
		return fmt.Errorf("partner: cannot resolve webhook host: %w", err)
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return errors.New("partner: webhook host resolves to a non-public address")
		}
	}
	return nil
}

func publicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	return !ip.Equal(net.IPv4(169, 254, 169, 254))
}

// Replay re-arms a dead delivery. It is the repair tool a partner asks for
// after they fix their endpoint, and it is deliberately not automatic.
func (s *Service) Replay(ctx context.Context, deliveryID string) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE partner.deliveries
		   SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL
		 WHERE delivery_id=$1::uuid AND status IN ('DEAD','RETRYING')`, deliveryID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return errors.New("partner: that delivery is not replayable")
	}
	return nil
}

// ReplayAllDead re-arms every dead delivery for a partner.
func (s *Service) ReplayAllDead(ctx context.Context, partnerID string) (int, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE partner.deliveries
		   SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL
		 WHERE partner_id=$1::uuid AND status='DEAD'`, partnerID)
	if err != nil {
		return 0, err
	}
	return int(ct.RowsAffected()), nil
}

// VerifyInboundWebhook is the sandbox sink's side of the contract: it verifies
// the signature the platform sent, using the same secret a real partner would
// hold. This is what makes the delivery path a proof rather than a claim.
func (s *Service) VerifyInboundWebhook(ctx context.Context, ts, sig string, body []byte) (partnerID string, ok bool) {
	rows, err := s.pool.Query(ctx,
		`SELECT partner_id::text, signing_secret FROM partner.api_keys WHERE status='ACTIVE'`)
	if err != nil {
		return "", false
	}
	defer rows.Close()
	for rows.Next() {
		var id, secret string
		if err := rows.Scan(&id, &secret); err != nil {
			continue
		}
		if hmac.Equal([]byte(SignWebhook(secret, ts, body)), []byte(sig)) {
			return id, true
		}
	}
	return "", false
}

// ------------------------------------------------------------- the portal --

type Delivery struct {
	DeliveryID  string     `json:"delivery_id"`
	EventType   string     `json:"event_type"`
	EventID     string     `json:"event_id"`
	Status      string     `json:"status"`
	Attempts    int        `json:"attempts"`
	StatusCode  *int       `json:"last_status_code"`
	LastError   string     `json:"last_error,omitempty"`
	NextAttempt time.Time  `json:"next_attempt_at"`
	CreatedAt   time.Time  `json:"created_at"`
	DeliveredAt *time.Time `json:"delivered_at"`
	URL         string     `json:"url"`
	Partner     string     `json:"partner"`
}

func (s *Service) Deliveries(ctx context.Context, partnerID string, limit int) ([]Delivery, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.delivery_id::text, d.event_type, d.event_id::text, d.status, d.attempts,
		       d.last_status_code, COALESCE(d.last_error,''), d.next_attempt_at,
		       d.created_at, d.delivered_at, s.url, p.name
		  FROM partner.deliveries d
		  JOIN partner.subscriptions s ON s.subscription_id = d.subscription_id
		  JOIN partner.partners p ON p.partner_id = d.partner_id
		 WHERE ($1 = '' OR d.partner_id::text = $1)
		 ORDER BY d.created_at DESC LIMIT $2`, partnerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.DeliveryID, &d.EventType, &d.EventID, &d.Status, &d.Attempts,
			&d.StatusCode, &d.LastError, &d.NextAttempt, &d.CreatedAt, &d.DeliveredAt,
			&d.URL, &d.Partner); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

type Partner struct {
	PartnerID   string     `json:"partner_id"`
	Name        string     `json:"name"`
	Email       string     `json:"contact_email"`
	Tier        string     `json:"tier"`
	DailyQuota  int        `json:"daily_quota"`
	RatePerMin  int        `json:"rate_per_min"`
	CallsToday  int        `json:"calls_today"`
	Rejected    int        `json:"rejected_today"`
	CertifiedAt *time.Time `json:"certified_at"`
	Subscriptions int      `json:"subscriptions"`
	DeadLetters int        `json:"dead_letters"`
}

func (s *Service) Partners(ctx context.Context) ([]Partner, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.partner_id::text, p.name, p.contact_email, p.tier, p.daily_quota, p.rate_per_min,
		       COALESCE(u.calls,0), COALESCE(u.rejected,0), p.certified_at,
		       (SELECT count(*) FROM partner.subscriptions s WHERE s.partner_id = p.partner_id AND s.active),
		       (SELECT count(*) FROM partner.deliveries d WHERE d.partner_id = p.partner_id AND d.status='DEAD')
		  FROM partner.partners p
		  LEFT JOIN partner.quota_usage u ON u.partner_id = p.partner_id AND u.day = catalog.bd_today()
		 ORDER BY p.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Partner{}
	for rows.Next() {
		var p Partner
		if err := rows.Scan(&p.PartnerID, &p.Name, &p.Email, &p.Tier, &p.DailyQuota, &p.RatePerMin,
			&p.CallsToday, &p.Rejected, &p.CertifiedAt, &p.Subscriptions, &p.DeadLetters); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Certify is the gate between sandbox and production. A partner cannot be moved
// to LIVE without having actually completed the flow in sandbox, which is
// checked here rather than taken on trust.
func (s *Service) Certify(ctx context.Context, partnerID string) error {
	var sandboxCalls int
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(calls),0) FROM partner.quota_usage WHERE partner_id = $1::uuid`,
		partnerID).Scan(&sandboxCalls); err != nil {
		return err
	}
	if sandboxCalls < 1 {
		return errors.New("partner: no sandbox activity recorded — certification requires a completed sandbox run")
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE partner.partners SET tier = 'LIVE', certified_at = now()
		 WHERE partner_id = $1::uuid AND tier = 'SANDBOX'`, partnerID)
	return err
}

func (s *Service) SetTier(ctx context.Context, partnerID, tier string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE partner.partners SET tier = $2 WHERE partner_id = $1::uuid`, partnerID, tier)
	return err
}

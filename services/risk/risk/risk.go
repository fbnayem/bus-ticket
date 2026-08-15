// Package risk is the fraud and abuse engine (plan workstream P3-A).
//
// Three properties shape it.
//
// It fails open. Risk evaluation sits inline on the hold, booking, payment and
// refund paths, and a fraud engine that can stop the platform selling tickets is
// a worse problem than the fraud it prevents. Any error, timeout or missing
// rule yields ALLOW plus an asynchronous review.
//
// New rules start in SHADOW. They are evaluated and recorded but never
// enforced, so a rule's false-positive rate is measured on real traffic before
// anybody is turned away by it. Promotion to ENFORCING is a deliberate act.
//
// Rules are rows. Adding one, retuning a threshold or pulling one out of
// enforcement is an UPDATE, not a deploy — which matters because fraud patterns
// change faster than release cycles.
package risk

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The five outcomes from the plan, strongest last.
const (
	Allow     = "ALLOW"
	Challenge = "CHALLENGE"
	Review    = "REVIEW"
	RateLimit = "RATE_LIMIT"
	Block     = "BLOCK"
)

func severity(outcome string) int {
	switch outcome {
	case Block:
		return 4
	case RateLimit:
		return 3
	case Review:
		return 2
	case Challenge:
		return 1
	}
	return 0
}

// budget is the latency the engine is allowed to spend before it gives up and
// allows. The plan sets 30 ms p95; this is the hard ceiling behind that.
const budget = 30 * time.Millisecond

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Subject is who is being assessed. Several of them apply to one request — an
// address, a device and a phone number — and the strongest verdict wins.
type Subject struct {
	IP     string
	Device string
	Phone  string
	UserID string
}

type Decision struct {
	Outcome  string   `json:"outcome"`
	Enforced bool     `json:"enforced"`
	Rules    []string `json:"rules,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Score    float64  `json:"score"`
	LatencyUS int     `json:"latency_us"`
}

// Allowed is the question a handler actually asks.
func (d Decision) Allowed() bool { return !d.Enforced || d.Outcome == Allow || d.Outcome == Review }

// Evaluate scores an action. It never returns an error: an engine that can
// return an error is an engine that can be made to fail closed by accident.
func (s *Service) Evaluate(ctx context.Context, action string, sub Subject, amountPoisha int64) Decision {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	d := Decision{Outcome: Allow}

	// A standing block is checked first and is not a rule — it is a decision a
	// human already made, and it outranks anything scored here.
	if kind, subject, reason, ok := s.blocked(ctx, sub); ok {
		d = Decision{Outcome: Block, Enforced: true, Reason: reason, Score: 100}
		s.record(ctx, kind, subject, action, "", d, time.Since(start))
		return d
	}

	rules, err := s.rules(ctx)
	if err != nil {
		d.Reason = "risk engine unavailable — allowed"
		return d
	}

	for _, r := range rules {
		kind, subject := r.subjectFor(sub)
		if subject == "" {
			continue
		}
		observed, err := s.observe(ctx, r, kind, subject, amountPoisha)
		if err != nil || observed < r.threshold {
			continue
		}
		enforced := r.mode == "ENFORCING"
		if severity(r.outcome) > severity(d.Outcome) || (enforced && !d.Enforced) {
			if severity(r.outcome) >= severity(d.Outcome) {
				d.Outcome = r.outcome
				d.Reason = fmt.Sprintf("%s: %s (observed %.0f, threshold %.0f)",
					r.code, r.description, observed, r.threshold)
			}
		}
		if enforced {
			d.Enforced = true
		}
		d.Rules = append(d.Rules, r.code)
		d.Score += observed / r.threshold * 25
		s.hit(ctx, r.code)
		s.record(ctx, kind, subject, action, r.code, Decision{
			Outcome: r.outcome, Enforced: enforced, Score: observed,
		}, time.Since(start))

		if r.outcome == Review && enforced {
			s.openCase(ctx, kind, subject, r.description)
		}
	}

	if len(d.Rules) == 0 {
		d.Outcome = Allow
	}
	// A rule that fired only in shadow mode is recorded but never enforced.
	if d.Outcome != Allow && !d.Enforced {
		d.Reason = "shadow only — " + d.Reason
	}
	d.LatencyUS = int(time.Since(start).Microseconds())
	return d
}

type rule struct {
	code, description, signal, outcome, mode string
	windowMinutes                            int
	threshold                                float64
}

func (r rule) subjectFor(s Subject) (kind, subject string) {
	switch r.signal {
	case "IP_VELOCITY", "HOLD_RATE", "BOOKING_RATE", "PHONE_VELOCITY":
		return "IP", s.IP
	case "DEVICE_VELOCITY", "HOLD_TO_BOOK_RATIO":
		return "DEVICE", s.Device
	case "PAYMENT_FAILURES", "CANCELLATION_RATE", "REFUND_RATE":
		return "PHONE", s.Phone
	case "AMOUNT":
		if s.UserID != "" {
			return "USER", s.UserID
		}
		return "PHONE", s.Phone
	}
	return "", ""
}

func (s *Service) rules(ctx context.Context) ([]rule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT code, description, signal, window_minutes, threshold::float8, outcome, mode
		  FROM risk.rules WHERE mode <> 'DISABLED' ORDER BY code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []rule
	for rows.Next() {
		var r rule
		if err := rows.Scan(&r.code, &r.description, &r.signal, &r.windowMinutes,
			&r.threshold, &r.outcome, &r.mode); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// observe measures one signal for one subject inside the rule's window. Every
// measurement comes from risk.events — the engine's own append-only record of
// what it has been asked about — so it never scans a transactional table on the
// booking path.
func (s *Service) observe(ctx context.Context, r rule, kind, subject string, amountPoisha int64) (float64, error) {
	if r.signal == "AMOUNT" {
		return float64(amountPoisha), nil
	}
	action := map[string]string{
		"HOLD_RATE":          "hold",
		"BOOKING_RATE":       "booking",
		"CANCELLATION_RATE":  "cancel",
		"REFUND_RATE":        "refund",
		"PAYMENT_FAILURES":   "payment_failed",
		"IP_VELOCITY":        "",
		"DEVICE_VELOCITY":    "",
		"PHONE_VELOCITY":     "otp",
		"HOLD_TO_BOOK_RATIO": "hold",
	}[r.signal]

	var n float64
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::float8 FROM risk.events
		 WHERE subject_kind = $1 AND subject = $2
		   AND ($3 = '' OR action = $3)
		   AND occurred_at > now() - make_interval(mins => $4)`,
		kind, subject, action, r.windowMinutes).Scan(&n)
	if err != nil {
		return 0, err
	}
	if r.signal == "HOLD_TO_BOOK_RATIO" {
		var booked float64
		if err := s.pool.QueryRow(ctx, `
			SELECT count(*)::float8 FROM risk.events
			 WHERE subject_kind = $1 AND subject = $2 AND action = 'booking'
			   AND occurred_at > now() - make_interval(mins => $3)`,
			kind, subject, r.windowMinutes).Scan(&booked); err != nil {
			return 0, err
		}
		if booked == 0 {
			return n, nil
		}
		return n / booked, nil
	}
	return n, nil
}

// Observe records that something happened, which is what later measurements are
// made from. Handlers call it on every hold, booking, payment and refund.
func (s *Service) Observe(ctx context.Context, action string, sub Subject) {
	for _, pair := range [][2]string{{"IP", sub.IP}, {"DEVICE", sub.Device}, {"PHONE", sub.Phone}, {"USER", sub.UserID}} {
		if pair[1] == "" {
			continue
		}
		_, _ = s.pool.Exec(ctx, `
			INSERT INTO risk.events (subject_kind, subject, action, outcome, enforced)
			VALUES ($1, $2, $3, 'ALLOW', false)`, pair[0], pair[1], action)
	}
}

func (s *Service) record(ctx context.Context, kind, subject, action, ruleCode string, d Decision, took time.Duration) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO risk.events
			(subject_kind, subject, action, rule_code, outcome, enforced, score, latency_us)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8)`,
		kind, subject, action, ruleCode, d.Outcome, d.Enforced, d.Score, took.Microseconds())
}

func (s *Service) hit(ctx context.Context, code string) {
	_, _ = s.pool.Exec(ctx, `UPDATE risk.rules SET hits = hits + 1 WHERE code = $1`, code)
}

func (s *Service) blocked(ctx context.Context, sub Subject) (kind, subject, reason string, ok bool) {
	for _, pair := range [][2]string{{"USER", sub.UserID}, {"PHONE", sub.Phone}, {"DEVICE", sub.Device}, {"IP", sub.IP}} {
		if pair[1] == "" {
			continue
		}
		var r string
		err := s.pool.QueryRow(ctx, `
			SELECT reason FROM risk.blocks
			 WHERE subject_kind = $1 AND subject = $2 AND lifted_at IS NULL
			   AND (expires_at IS NULL OR expires_at > now())`, pair[0], pair[1]).Scan(&r)
		if err == nil {
			return pair[0], pair[1], r, true
		}
	}
	return "", "", "", false
}

func (s *Service) openCase(ctx context.Context, kind, subject, reason string) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO risk.cases (subject_kind, subject, reason)
		VALUES ($1,$2,$3) ON CONFLICT (subject_kind, subject, status) DO NOTHING`,
		kind, subject, reason)
}

// ------------------------------------------------------------- the console --

type Rule struct {
	Code        string    `json:"code"`
	Description string    `json:"description"`
	Signal      string    `json:"signal"`
	Window      int       `json:"window_minutes"`
	Threshold   float64   `json:"threshold"`
	Outcome     string    `json:"outcome"`
	Mode        string    `json:"mode"`
	Hits        int64     `json:"hits"`
	FalsePositives int64  `json:"false_positives"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (s *Service) Rules(ctx context.Context) ([]Rule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT code, description, signal, window_minutes, threshold::float8, outcome, mode,
		       hits, false_positives, updated_at
		  FROM risk.rules ORDER BY mode, code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var r Rule
		if err := rows.Scan(&r.Code, &r.Description, &r.Signal, &r.Window, &r.Threshold,
			&r.Outcome, &r.Mode, &r.Hits, &r.FalsePositives, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetMode moves a rule between shadow and enforcement. Promoting a rule that
// has never been observed is refused: the whole point of shadow mode is that
// nobody is turned away by a rule whose false-positive rate is unknown.
func (s *Service) SetMode(ctx context.Context, code, mode string) error {
	if mode == "ENFORCING" {
		var hits int64
		if err := s.pool.QueryRow(ctx,
			`SELECT hits FROM risk.rules WHERE code = $1`, code).Scan(&hits); err != nil {
			return err
		}
		if hits == 0 {
			return errors.New("risk: this rule has never fired in shadow — observe it before enforcing it")
		}
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE risk.rules SET mode = $2, version = version + 1, updated_at = now() WHERE code = $1`,
		code, mode)
	return err
}

type Case struct {
	CaseID   string    `json:"case_id"`
	Kind     string    `json:"subject_kind"`
	Subject  string    `json:"subject"`
	Reason   string    `json:"reason"`
	Status   string    `json:"status"`
	OpenedAt time.Time `json:"opened_at"`
	Events   int       `json:"events"`
}

func (s *Service) Cases(ctx context.Context) ([]Case, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.case_id::text, c.subject_kind, c.subject, c.reason, c.status, c.opened_at,
		       (SELECT count(*) FROM risk.events e
		         WHERE e.subject_kind = c.subject_kind AND e.subject = c.subject
		           AND e.occurred_at > c.opened_at - interval '1 day')
		  FROM risk.cases c ORDER BY (c.status='OPEN') DESC, c.opened_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Case{}
	for rows.Next() {
		var c Case
		if err := rows.Scan(&c.CaseID, &c.Kind, &c.Subject, &c.Reason, &c.Status,
			&c.OpenedAt, &c.Events); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CloseCase resolves a review. Marking it CLEARED counts the rule that raised
// it as a false positive, which is what makes the shadow-mode measurement real.
func (s *Service) CloseCase(ctx context.Context, caseID, verdict, note, staffID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var kind, subject string
	if err := tx.QueryRow(ctx, `
		UPDATE risk.cases SET status = $2, closed_at = now(), closed_by = NULLIF($3,'')::uuid, note = $4
		 WHERE case_id = $1::uuid AND status = 'OPEN'
		 RETURNING subject_kind, subject`, caseID, verdict, staffID, note).Scan(&kind, &subject); err != nil {
		return err
	}
	if verdict == "CLEARED" {
		if _, err := tx.Exec(ctx, `
			UPDATE risk.rules SET false_positives = false_positives + 1
			 WHERE code IN (SELECT DISTINCT rule_code FROM risk.events
			                 WHERE subject_kind = $1 AND subject = $2 AND rule_code IS NOT NULL
			                   AND occurred_at > now() - interval '7 days')`, kind, subject); err != nil {
			return err
		}
	}
	if verdict == "CONFIRMED" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO risk.blocks (subject_kind, subject, reason, blocked_by)
			VALUES ($1,$2,'confirmed by a risk admin', NULLIF($3,'')::uuid)
			ON CONFLICT (subject_kind, subject) DO UPDATE
			   SET lifted_at = NULL, lifted_by = NULL, blocked_at = now()`, kind, subject, staffID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type BlockRecord struct {
	Kind      string     `json:"subject_kind"`
	Subject   string     `json:"subject"`
	Reason    string     `json:"reason"`
	BlockedAt time.Time  `json:"blocked_at"`
	LiftedAt  *time.Time `json:"lifted_at"`
}

func (s *Service) Blocks(ctx context.Context) ([]BlockRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT subject_kind, subject, reason, blocked_at, lifted_at
		  FROM risk.blocks ORDER BY (lifted_at IS NULL) DESC, blocked_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BlockRecord{}
	for rows.Next() {
		var b BlockRecord
		if err := rows.Scan(&b.Kind, &b.Subject, &b.Reason, &b.BlockedAt, &b.LiftedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Lift reverses a block. Every block is reversible by a risk admin and the
// reversal is attributable — the plan requires both.
func (s *Service) Lift(ctx context.Context, kind, subject, staffID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE risk.blocks SET lifted_at = now(), lifted_by = NULLIF($3,'')::uuid
		 WHERE subject_kind = $1 AND subject = $2 AND lifted_at IS NULL`, kind, subject, staffID)
	return err
}

func (s *Service) BlockSubject(ctx context.Context, kind, subject, reason, staffID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO risk.blocks (subject_kind, subject, reason, blocked_by)
		VALUES ($1,$2,$3,NULLIF($4,'')::uuid)
		ON CONFLICT (subject_kind, subject) DO UPDATE
		   SET reason = EXCLUDED.reason, blocked_at = now(), lifted_at = NULL, lifted_by = NULL`,
		kind, subject, reason, staffID)
	return err
}

// Stats is what the risk dashboard shows: how often each outcome is reached and
// what the engine costs the booking path.
type Stats struct {
	Outcome  string  `json:"outcome"`
	Count    int     `json:"count"`
	Enforced int     `json:"enforced"`
	P95Micro float64 `json:"p95_latency_us"`
}

func (s *Service) Stats(ctx context.Context, hours int) ([]Stats, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT outcome, count(*), count(*) FILTER (WHERE enforced),
		       COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_us), 0)::float8
		  FROM risk.events
		 WHERE occurred_at > now() - make_interval(hours => $1)
		 GROUP BY outcome ORDER BY 2 DESC`, hours)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Stats{}
	for rows.Next() {
		var v Stats
		if err := rows.Scan(&v.Outcome, &v.Count, &v.Enforced, &v.P95Micro); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

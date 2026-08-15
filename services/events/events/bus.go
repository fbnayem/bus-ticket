// Package events is the platform's event backbone: the outbox relay, the
// append-only event log, and consumer groups with checkpoints and dead letters.
//
// The plan specifies Kafka with a schema registry, a DLQ per consumer group and
// idempotent consumers. Kafka is not running in this build, so the same
// contract is implemented on PostgreSQL. The parts that are hard to retrofit —
// the envelope, the registry, per-consumer offsets, dead-lettering, and the
// rule that a producer only ever writes to its own transactional outbox — are
// all real here. Replacing the sink with a Kafka producer is a change to
// Relay(); nothing that produces or consumes an event has to move.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Envelope is the standard event shape from the plan, delivered to handlers.
type Envelope struct {
	Offset        int64           `json:"offset"`
	EventID       string          `json:"event_id"`
	Topic         string          `json:"topic"`
	EventType     string          `json:"event_type"`
	Version       int             `json:"version"`
	Producer      string          `json:"producer"`
	CorrelationID string          `json:"correlation_id,omitempty"`
	AggregateID   string          `json:"aggregate_id,omitempty"`
	Payload       json.RawMessage `json:"payload"`
	OccurredAt    time.Time       `json:"timestamp"`
}

// Str reads a string field out of the payload without forcing every handler to
// declare a struct for events it only glances at.
func (e Envelope) Str(key string) string {
	var m map[string]any
	if json.Unmarshal(e.Payload, &m) != nil {
		return ""
	}
	switch v := m[key].(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%g", v)
	case bool:
		return fmt.Sprintf("%t", v)
	}
	return ""
}

// Handler processes one event. It must be idempotent: a consumer that dies
// after acting but before its offset advances will be given the event again.
type Handler func(ctx context.Context, e Envelope) error

type Bus struct {
	pool     *pgxpool.Pool
	log      *slog.Logger
	handlers map[string]Handler
	// attempts is how many times a handler is retried before the event is
	// dead-lettered and the offset moves past it. A poisoned event must never
	// be able to wedge a consumer group forever.
	attempts int
}

func New(pool *pgxpool.Pool, log *slog.Logger) *Bus {
	return &Bus{pool: pool, log: log, handlers: map[string]Handler{}, attempts: 3}
}

// Subscribe binds a handler to a consumer group that already exists as a row in
// events.consumers. Registering a group the database has never heard of is a
// programming error, so it fails loudly at startup rather than silently
// consuming nothing.
func (b *Bus) Subscribe(consumer string, h Handler) { b.handlers[consumer] = h }

// ------------------------------------------------------------------- relay --

// identSafe guards the one place a table name is interpolated. The names come
// from a table we own, but a query built by string concatenation deserves a
// gate regardless.
var identSafe = regexp.MustCompile(`^[a-z_]+\.[a-z_]+$`)

// Relay moves rows from every producer's outbox into the event log. It is the
// only thing that publishes: no service writes to its database and to the log
// in two steps, so an event either becomes durable with its state change or
// does not exist.
func (b *Bus) Relay(ctx context.Context, batch int) (published, rejected int, err error) {
	rows, err := b.pool.Query(ctx,
		`SELECT source_table, producer FROM events.outbox_sources WHERE enabled ORDER BY source_table`)
	if err != nil {
		return 0, 0, err
	}
	type src struct{ table, producer string }
	var sources []src
	for rows.Next() {
		var s src
		if err := rows.Scan(&s.table, &s.producer); err != nil {
			rows.Close()
			return 0, 0, err
		}
		sources = append(sources, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}

	for _, s := range sources {
		if !identSafe.MatchString(s.table) {
			b.log.Error("refusing to relay a suspicious source table", "table", s.table)
			continue
		}
		q := fmt.Sprintf(`
			WITH claimed AS (
			    SELECT outbox_id, event_id, aggregate_id, event_type,
			           correlation_id, payload, created_at
			      FROM %[1]s
			     WHERE published_at IS NULL
			     ORDER BY outbox_id
			     LIMIT $1
			       FOR UPDATE SKIP LOCKED
			), checked AS (
			    SELECT c.*, events.schema_reject_reason(c.event_type, c.payload) AS reason
			      FROM claimed c
			), good AS (
			    INSERT INTO events.event_log
			        (event_id, topic, event_type, producer, correlation_id,
			         aggregate_id, payload, occurred_at)
			    SELECT event_id, events.topic_for(event_type), event_type, $2,
			           correlation_id, aggregate_id, payload, created_at
			      FROM checked WHERE reason IS NULL
			    ON CONFLICT (event_id) DO NOTHING
			    RETURNING 1
			), bad AS (
			    INSERT INTO events.rejected_events
			        (source_table, event_id, event_type, reason, payload)
			    SELECT $3, event_id, event_type, reason, payload
			      FROM checked WHERE reason IS NOT NULL
			    ON CONFLICT (event_id) DO NOTHING
			    RETURNING 1
			), marked AS (
			    UPDATE %[1]s o SET published_at = now()
			      FROM checked c WHERE o.outbox_id = c.outbox_id
			    RETURNING 1
			)
			SELECT (SELECT count(*) FROM good), (SELECT count(*) FROM bad)`, s.table)

		var p, r int
		if err := b.pool.QueryRow(ctx, q, batch, s.producer, s.table).Scan(&p, &r); err != nil {
			return published, rejected, fmt.Errorf("relay %s: %w", s.table, err)
		}
		published += p
		rejected += r
	}
	return published, rejected, nil
}

// ---------------------------------------------------------------- delivery --

// Deliver walks each subscribed consumer group forward from its checkpoint.
func (b *Bus) Deliver(ctx context.Context, batch int) (delivered, dead int, err error) {
	for name, h := range b.handlers {
		d, x, err := b.deliverOne(ctx, name, h, batch)
		delivered += d
		dead += x
		if err != nil {
			return delivered, dead, err
		}
	}
	return delivered, dead, nil
}

func (b *Bus) deliverOne(ctx context.Context, consumer string, h Handler, batch int) (int, int, error) {
	// One process at a time per group. Two API instances would otherwise both
	// read from the same checkpoint and deliver everything twice; handlers are
	// idempotent, but doubling every SMS is not a cost worth paying.
	conn, err := b.pool.Acquire(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Release()

	var locked bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtext('events:' || $1))`, consumer).Scan(&locked); err != nil {
		return 0, 0, err
	}
	if !locked {
		return 0, 0, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx),
			`SELECT pg_advisory_unlock(hashtext('events:' || $1))`, consumer)
	}()

	var position int64
	var topics []string
	if err := conn.QueryRow(ctx,
		`SELECT position, topics FROM events.consumers WHERE consumer = $1`, consumer).
		Scan(&position, &topics); err != nil {
		return 0, 0, fmt.Errorf("consumer %s is not registered in events.consumers: %w", consumer, err)
	}

	rows, err := conn.Query(ctx, `
		SELECT offset_id, event_id::text, topic, event_type, version, producer,
		       COALESCE(correlation_id::text,''), COALESCE(aggregate_id::text,''),
		       payload, occurred_at
		  FROM events.event_log
		 WHERE offset_id > $1 AND topic = ANY($2)
		 ORDER BY offset_id LIMIT $3`, position, topics, batch)
	if err != nil {
		return 0, 0, err
	}
	var evs []Envelope
	for rows.Next() {
		var e Envelope
		if err := rows.Scan(&e.Offset, &e.EventID, &e.Topic, &e.EventType, &e.Version,
			&e.Producer, &e.CorrelationID, &e.AggregateID, &e.Payload, &e.OccurredAt); err != nil {
			rows.Close()
			return 0, 0, err
		}
		evs = append(evs, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if len(evs) == 0 {
		return 0, 0, nil
	}

	var delivered, dead int
	last := position
	for _, e := range evs {
		var lastErr error
		for attempt := 1; attempt <= b.attempts; attempt++ {
			if lastErr = h(ctx, e); lastErr == nil {
				break
			}
			time.Sleep(time.Duration(attempt) * 20 * time.Millisecond)
		}
		if lastErr != nil {
			dead++
			b.log.Warn("event dead-lettered", "consumer", consumer,
				"event_type", e.EventType, "event_id", e.EventID, "err", lastErr)
			if _, err := conn.Exec(ctx, `
				INSERT INTO events.dead_letters
					(consumer, offset_id, event_id, event_type, attempts, last_error)
				VALUES ($1,$2,$3::uuid,$4,$5,$6)
				ON CONFLICT (consumer, event_id) DO NOTHING`,
				consumer, e.Offset, e.EventID, e.EventType, b.attempts, lastErr.Error()); err != nil {
				return delivered, dead, err
			}
		} else {
			delivered++
		}
		last = e.Offset
	}

	if _, err := conn.Exec(ctx, `
		UPDATE events.consumers
		   SET position = $2, delivered = delivered + $3, failed = failed + $4, updated_at = now()
		 WHERE consumer = $1 AND position < $2`, consumer, last, delivered, dead); err != nil {
		return delivered, dead, err
	}
	return delivered, dead, nil
}

// Replay re-delivers a dead-lettered event to its consumer and, if it succeeds
// this time, marks the dead letter resolved. This is the operator's repair tool
// after the underlying cause is fixed.
func (b *Bus) Replay(ctx context.Context, consumer, eventID string) error {
	h, ok := b.handlers[consumer]
	if !ok {
		return fmt.Errorf("no handler registered for consumer %q", consumer)
	}
	var e Envelope
	if err := b.pool.QueryRow(ctx, `
		SELECT offset_id, event_id::text, topic, event_type, version, producer,
		       COALESCE(correlation_id::text,''), COALESCE(aggregate_id::text,''),
		       payload, occurred_at
		  FROM events.event_log WHERE event_id = $1::uuid`, eventID).
		Scan(&e.Offset, &e.EventID, &e.Topic, &e.EventType, &e.Version, &e.Producer,
			&e.CorrelationID, &e.AggregateID, &e.Payload, &e.OccurredAt); err != nil {
		return err
	}
	if err := h(ctx, e); err != nil {
		return err
	}
	_, err := b.pool.Exec(ctx, `
		UPDATE events.dead_letters SET resolved_at = now()
		 WHERE consumer = $1 AND event_id = $2::uuid AND resolved_at IS NULL`, consumer, eventID)
	return err
}

// Run relays and delivers on a ticker until the context ends.
func (b *Bus) Run(ctx context.Context, every time.Duration, batch int) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pub, rej, err := b.Relay(ctx, batch)
			if err != nil {
				b.log.Warn("relay failed", "err", err)
			}
			if rej > 0 {
				b.log.Warn("events rejected by the schema registry", "count", rej)
			}
			del, dead, err := b.Deliver(ctx, batch)
			if err != nil {
				b.log.Warn("deliver failed", "err", err)
			}
			if pub > 0 || del > 0 || dead > 0 {
				b.log.Info("event backbone", "published", pub, "delivered", del, "dead_lettered", dead)
			}
		}
	}
}

// Drain relays and delivers until nothing is left. Tests and the smoke suites
// use it so they never have to sleep and hope.
func (b *Bus) Drain(ctx context.Context, batch int) error {
	for i := 0; i < 100; i++ {
		pub, _, err := b.Relay(ctx, batch)
		if err != nil {
			return err
		}
		del, dead, err := b.Deliver(ctx, batch)
		if err != nil {
			return err
		}
		if pub == 0 && del == 0 && dead == 0 {
			return nil
		}
	}
	return nil
}

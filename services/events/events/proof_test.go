package events_test

// Proofs for the event backbone.
//
// The properties worth proving are the ones a Kafka deployment would give you
// for free and a home-grown relay can quietly get wrong: relaying is idempotent,
// the schema registry stops a malformed event before any consumer sees it, a
// poisoned event dead-letters instead of wedging its consumer group, and two
// relays racing the same outbox publish each event once.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/events/events"
)

func dsn() string {
	if v := os.Getenv("DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://platform:platform@localhost:55440/platform?sslmode=disable"
}

func openPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dsn())
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.MaxConns = 40
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	return pool
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

// consumer registers a throwaway consumer group and removes it afterwards.
func consumer(t *testing.T, pool *pgxpool.Pool, topics string) string {
	t.Helper()
	name := fmt.Sprintf("proof-%d", time.Now().UnixNano())
	// Sweep any group a previously interrupted run left behind, so a stale
	// consumer never shows up as platform lag on somebody's health page.
	_, _ = pool.Exec(context.Background(),
		`DELETE FROM events.dead_letters WHERE consumer LIKE 'proof-%'`)
	_, _ = pool.Exec(context.Background(),
		`DELETE FROM events.consumers WHERE consumer LIKE 'proof-%'`)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO events.consumers (consumer, topics, position)
		VALUES ($1, $2::text[], (SELECT COALESCE(max(offset_id),0) FROM events.event_log))`,
		name, topics); err != nil {
		t.Fatalf("register consumer: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM events.dead_letters WHERE consumer = $1`, name)
		_, _ = pool.Exec(ctx, `DELETE FROM events.consumers WHERE consumer = $1`, name)
	})
	return name
}

// emit writes an event into a real producer outbox.
func emit(t *testing.T, pool *pgxpool.Pool, eventType, payload string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO ops.outbox (aggregate_id, event_type, payload)
		VALUES (gen_random_uuid(), $1, $2::jsonb)`, eventType, payload); err != nil {
		t.Fatalf("emit: %v", err)
	}
}

// Proof 1: relaying twice publishes once. The outbox row is the only record a
// producer keeps, and a relay that crashes after publishing but before marking
// must not produce a second event when it comes back.
func TestProof1_RelayIsIdempotent(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	bus := events.New(pool, quietLogger())

	tripID := newUUID(t, pool)
	emit(t, pool, "trip.delayed",
		fmt.Sprintf(`{"trip_id":%q,"minutes":20,"proof":"relay-idempotency"}`, tripID))

	if _, _, err := bus.Relay(ctx, 500); err != nil {
		t.Fatalf("relay: %v", err)
	}

	// Put the row back into the unpublished state, exactly as a crash between
	// the insert and the mark would leave it, and relay again.
	if _, err := pool.Exec(ctx, `
		UPDATE ops.outbox SET published_at = NULL
		 WHERE payload->>'proof' = 'relay-idempotency'`); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	if _, _, err := bus.Relay(ctx, 500); err != nil {
		t.Fatalf("second relay: %v", err)
	}

	var published int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM events.event_log
		 WHERE payload->>'proof' = 'relay-idempotency'`).Scan(&published); err != nil {
		t.Fatalf("count: %v", err)
	}
	t.Logf("relayed twice after a simulated crash: %d event(s) in the log", published)
	if published != 1 {
		t.Fatalf("expected exactly 1 published event, got %d", published)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM events.event_log WHERE payload->>'proof' = 'relay-idempotency'`)
	_, _ = pool.Exec(ctx, `DELETE FROM ops.outbox WHERE payload->>'proof' = 'relay-idempotency'`)
}

// Proof 2: the schema registry rejects before publication, not after. A
// consumer must never be the first thing to discover a producer changed shape.
func TestProof2_RegistryRejectsBeforeAnyConsumerSeesIt(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	bus := events.New(pool, quietLogger())

	// trip.delayed requires trip_id and minutes. Send it without minutes.
	tripID := newUUID(t, pool)
	emit(t, pool, "trip.delayed", fmt.Sprintf(`{"trip_id":%q,"proof":"registry-missing-field"}`, tripID))
	// And an event type nobody registered at all.
	emit(t, pool, "trip.teleported", fmt.Sprintf(`{"trip_id":%q,"proof":"registry-unknown"}`, tripID))

	_, rejected, err := bus.Relay(ctx, 500)
	if err != nil {
		t.Fatalf("relay: %v", err)
	}

	var published int
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM events.event_log
		 WHERE payload->>'proof' IN ('registry-missing-field','registry-unknown')`).Scan(&published)

	var reasons []string
	rows, err := pool.Query(ctx, `
		SELECT reason FROM events.rejected_events
		 WHERE payload->>'proof' IN ('registry-missing-field','registry-unknown')
		 ORDER BY reason`)
	if err != nil {
		t.Fatalf("reasons: %v", err)
	}
	for rows.Next() {
		var r string
		if rows.Scan(&r) == nil {
			reasons = append(reasons, r)
		}
	}
	rows.Close()

	t.Logf("rejected %d: %v", rejected, reasons)
	if published != 0 {
		t.Fatalf("a malformed event reached the log %d time(s)", published)
	}
	if len(reasons) != 2 {
		t.Fatalf("expected both events parked with a reason, got %v", reasons)
	}

	_, _ = pool.Exec(ctx, `DELETE FROM events.rejected_events
		WHERE payload->>'proof' IN ('registry-missing-field','registry-unknown')`)
	_, _ = pool.Exec(ctx, `DELETE FROM ops.outbox
		WHERE payload->>'proof' IN ('registry-missing-field','registry-unknown')`)
}

// Proof 3: a consumer that cannot process an event dead-letters it and keeps
// going. One poisoned message must not stop every message behind it.
func TestProof3_PoisonedEventDoesNotWedgeTheGroup(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	bus := events.New(pool, quietLogger())
	name := consumer(t, pool, "{trip}")

	tripID := newUUID(t, pool)
	for i := 0; i < 3; i++ {
		emit(t, pool, "trip.delayed",
			fmt.Sprintf(`{"trip_id":%q,"minutes":%d,"proof":"poison","seq":%d}`, tripID, i, i))
	}
	if _, _, err := bus.Relay(ctx, 500); err != nil {
		t.Fatalf("relay: %v", err)
	}

	var seen []int64
	var mu sync.Mutex
	bus.Subscribe(name, func(ctx context.Context, e events.Envelope) error {
		if e.Str("proof") != "poison" {
			return nil
		}
		if e.Str("seq") == "1" {
			return errors.New("this consumer cannot handle seq 1")
		}
		mu.Lock()
		seen = append(seen, e.Offset)
		mu.Unlock()
		return nil
	})

	delivered, dead, err := bus.Deliver(ctx, 100)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}

	var dl int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM events.dead_letters WHERE consumer = $1 AND resolved_at IS NULL`, name).Scan(&dl)

	t.Logf("3 events, 1 poisoned: %d delivered, %d dead-lettered, %d handled past the poison",
		delivered, dead, len(seen))
	if dl != 1 {
		t.Fatalf("expected exactly 1 dead letter, got %d", dl)
	}
	if len(seen) != 2 {
		t.Fatalf("expected the two healthy events to be handled, got %d", len(seen))
	}

	// And the group's checkpoint moved past it, so it is not stuck.
	var position, head int64
	_ = pool.QueryRow(ctx, `SELECT position FROM events.consumers WHERE consumer = $1`, name).Scan(&position)
	_ = pool.QueryRow(ctx, `SELECT max(offset_id) FROM events.event_log`).Scan(&head)
	if position < head {
		t.Fatalf("consumer stuck at %d behind head %d", position, head)
	}

	_, _ = pool.Exec(ctx, `DELETE FROM events.event_log WHERE payload->>'proof' = 'poison'`)
	_, _ = pool.Exec(ctx, `DELETE FROM ops.outbox WHERE payload->>'proof' = 'poison'`)
}

// Proof 4: two relays racing the same outbox publish each event exactly once.
// FOR UPDATE SKIP LOCKED is what makes running more than one relay safe, and
// this is the test that says so.
func TestProof4_ConcurrentRelaysPublishOnce(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()

	const events_ = 200
	tripID := newUUID(t, pool)
	for i := 0; i < events_; i++ {
		emit(t, pool, "trip.delayed",
			fmt.Sprintf(`{"trip_id":%q,"minutes":%d,"proof":"relay-race"}`, tripID, i))
	}

	var total int64
	var wg sync.WaitGroup
	for r := 0; r < 8; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus := events.New(pool, quietLogger())
			for i := 0; i < 20; i++ {
				n, _, err := bus.Relay(ctx, 25)
				if err != nil {
					t.Errorf("relay: %v", err)
					return
				}
				atomic.AddInt64(&total, int64(n))
			}
		}()
	}
	wg.Wait()

	var inLog, unpublished int
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM events.event_log WHERE payload->>'proof' = 'relay-race'`).Scan(&inLog)
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM ops.outbox
		 WHERE payload->>'proof' = 'relay-race' AND published_at IS NULL`).Scan(&unpublished)

	t.Logf("%d events, 8 concurrent relays: %d in the log, %d left unpublished", events_, inLog, unpublished)
	if inLog != events_ {
		t.Fatalf("expected %d events published exactly once, got %d", events_, inLog)
	}
	if unpublished != 0 {
		t.Fatalf("%d outbox rows were never relayed", unpublished)
	}

	_, _ = pool.Exec(ctx, `DELETE FROM events.event_log WHERE payload->>'proof' = 'relay-race'`)
	_, _ = pool.Exec(ctx, `DELETE FROM ops.outbox WHERE payload->>'proof' = 'relay-race'`)
}

func newUUID(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	return id
}

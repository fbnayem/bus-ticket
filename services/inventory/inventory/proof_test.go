package inventory

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The Phase 1 exit gate, executable.
//
// Every test here asserts an invariant that, if broken, would let the platform
// sell one seat twice or take money for a seat it does not own. These are the
// tests that gate Week 5 of the plan: until they pass, no commerce work starts.

var pool *pgxpool.Pool

func TestMain(m *testing.M) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Println("DATABASE_URL not set; database-backed proofs will skip")
		noDB = true
		os.Exit(m.Run())
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		fmt.Println("bad DATABASE_URL:", err)
		os.Exit(1)
	}
	cfg.MaxConns = int32(envInt("PROOF_POOL", 60))
	cfg.MinConns = 8
	cfg.MaxConnLifetime = time.Hour

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		fmt.Println("pool:", err)
		os.Exit(1)
	}
	for i := 0; i < 30; i++ {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		fmt.Println("ping:", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// noDB records that this run has no database behind it. It is a skip, not a
// pass: TestMain used to os.Exit(0) here, which reported the whole package as
// "ok" without running a line of it — a green suite that proved nothing, and
// the failure mode of a CI job that forgets to set DATABASE_URL. Now the tests
// that need a database say so individually and the ones that do not still run.
var noDB bool

// requireDB skips a test that cannot run without a database.
func requireDB(t *testing.T) {
	t.Helper()
	if noDB {
		t.Skip("DATABASE_URL not set; this proof needs a database")
	}
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// newTrip opens an isolated trip so tests never contend with one another.
func newTrip(t *testing.T, segments, seatCount int) (*Store, string) {
	t.Helper()
	st := New(pool)
	tripID, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	seats := make([]SeatSpec, 0, seatCount)
	for i := 0; i < seatCount; i++ {
		seats = append(seats, SeatSpec{
			SeatNo: fmt.Sprintf("%c%d", 'A'+rune(i/4), i%4+1),
			Row:    i / 4, Col: i%4 + 1,
		})
	}
	if err := st.OpenTrip(context.Background(), tripID, segments, seats); err != nil {
		t.Fatal(err)
	}
	return st, tripID
}

// ---------------------------------------------------------------------------
// PROOF 1 — the stampede.
// N concurrent buyers contend for the SAME seat on the SAME segments.
// Exactly one may win. Zero duplicate ownership. Every loser mutates nothing.
// ---------------------------------------------------------------------------
func TestProof1_StampedeOneSeat(t *testing.T) {
	requireDB(t)
	contenders := envInt("PROOF_CONTENDERS", 20000)
	workers := envInt("PROOF_WORKERS", 160)

	st, tripID := newTrip(t, 3, 40)
	ctx := context.Background()

	var won, lost, failed int64
	var wg sync.WaitGroup
	jobs := make(chan int, workers*2)

	start := time.Now()
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				_, err := st.AcquireHold(ctx, HoldRequest{
					TripID: tripID, Seats: []string{"A1"},
					BoardSeq: 0, DropSeq: 3, Channel: "WEB", TTL: 10 * time.Minute,
				})
				switch {
				case err == nil:
					atomic.AddInt64(&won, 1)
				case errors.Is(err, ErrSeatUnavailable):
					atomic.AddInt64(&lost, 1)
				default:
					atomic.AddInt64(&failed, 1)
					t.Errorf("unexpected error: %v", err)
				}
			}
		}()
	}
	for i := 0; i < contenders; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	t.Logf("contenders=%d workers=%d elapsed=%s throughput=%.0f attempts/sec",
		contenders, workers, elapsed.Round(time.Millisecond),
		float64(contenders)/elapsed.Seconds())
	t.Logf("won=%d lost=%d failed=%d", won, lost, failed)

	if won != 1 {
		t.Fatalf("INVARIANT VIOLATED: %d winners for one seat, expected exactly 1", won)
	}
	if failed != 0 {
		t.Fatalf("%d attempts failed with unexpected errors", failed)
	}
	if lost != int64(contenders-1) {
		t.Fatalf("losers=%d, expected %d", lost, contenders-1)
	}

	// Exactly one acquisition recorded in the append-only log.
	var acquisitions int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM inventory.inventory_events
		 WHERE trip_id = $1::uuid AND seat_no = 'A1' AND event_type = 'SEAT_HELD'`,
		tripID).Scan(&acquisitions); err != nil {
		t.Fatal(err)
	}
	if acquisitions != 1 {
		t.Fatalf("INVARIANT VIOLATED: %d SEAT_HELD events for A1, expected 1", acquisitions)
	}

	// Losers left nothing behind.
	var holdRows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM inventory.seat_holds WHERE trip_id = $1::uuid`, tripID).
		Scan(&holdRows); err != nil {
		t.Fatal(err)
	}
	if holdRows != 1 {
		t.Fatalf("INVARIANT VIOLATED: %d hold rows persisted, expected 1", holdRows)
	}
}

// ---------------------------------------------------------------------------
// PROOF 2 — segment resale.
// A seat sold Dhaka->Cumilla must remain sellable Cumilla->Chattogram, and must
// never be sellable on any overlapping journey. Checked exhaustively against an
// independent oracle over all journey pairs.
// ---------------------------------------------------------------------------
func TestProof2_SegmentMatrix(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	type journey struct {
		name       string
		board, drop int
	}
	journeys := []journey{
		{"Dhaka->Cumilla", 0, 1},
		{"Dhaka->Feni", 0, 2},
		{"Dhaka->Chattogram", 0, 3},
		{"Cumilla->Feni", 1, 2},
		{"Cumilla->Chattogram", 1, 3},
		{"Feni->Chattogram", 2, 3},
	}

	for _, first := range journeys {
		for _, second := range journeys {
			st, tripID := newTrip(t, 3, 4)

			h1, err := st.AcquireHold(ctx, HoldRequest{
				TripID: tripID, Seats: []string{"A1"},
				BoardSeq: first.board, DropSeq: first.drop, TTL: time.Minute,
			})
			if err != nil {
				t.Fatalf("%s: first hold failed: %v", first.name, err)
			}
			if err := st.ConfirmHold(ctx, h1.HoldID); err != nil {
				t.Fatalf("%s: confirm failed: %v", first.name, err)
			}

			m1, _ := SegmentMask(first.board, first.drop)
			m2, _ := SegmentMask(second.board, second.drop)
			expectConflict := Overlaps(m1, m2) // the independent oracle

			_, err = st.AcquireHold(ctx, HoldRequest{
				TripID: tripID, Seats: []string{"A1"},
				BoardSeq: second.board, DropSeq: second.drop, TTL: time.Minute,
			})
			gotConflict := errors.Is(err, ErrSeatUnavailable)
			if err != nil && !gotConflict {
				t.Fatalf("unexpected error: %v", err)
			}
			if gotConflict != expectConflict {
				t.Fatalf("SEGMENT LOGIC WRONG: sold %s (0b%03b) then tried %s (0b%03b): conflict=%v want=%v",
					first.name, m1, second.name, m2, gotConflict, expectConflict)
			}
		}
	}
	t.Logf("all %d journey pairs match the overlap oracle", len(journeys)*len(journeys))
}

// The headline case from the specification, called out on its own.
func TestProof2b_ResaleAfterPartialSale(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, tripID := newTrip(t, 3, 4)

	sold, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 1, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ConfirmHold(ctx, sold.HoldID); err != nil {
		t.Fatal(err)
	}

	// Same physical seat, the remainder of the corridor: must succeed.
	resale, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 1, DropSeq: 3, TTL: time.Minute})
	if err != nil {
		t.Fatalf("segment resale rejected — the seat is being wasted: %v", err)
	}
	if err := st.ConfirmHold(ctx, resale.HoldID); err != nil {
		t.Fatal(err)
	}

	// And the full corridor must now be impossible on that seat.
	if _, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3, TTL: time.Minute,
	}); !errors.Is(err, ErrSeatUnavailable) {
		t.Fatalf("INVARIANT VIOLATED: full-corridor sale allowed on a fully sold seat: %v", err)
	}

	avail, err := st.CountAvailable(ctx, tripID, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("A1 resold across two non-overlapping journeys; %d seats still free Dhaka->Cumilla", avail)
}

// ---------------------------------------------------------------------------
// PROOF 3 — two holds owning different segments of one seat concurrently.
// This is the case a single current_hold_id column cannot represent.
// ---------------------------------------------------------------------------
func TestProof3_ConcurrentDisjointHoldsOnOneSeat(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, tripID := newTrip(t, 3, 4)

	a, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 1, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 2, DropSeq: 3, TTL: time.Minute})
	if err != nil {
		t.Fatalf("second disjoint hold on the same seat rejected: %v", err)
	}

	// Releasing one must not disturb the other.
	if err := st.ReleaseHold(ctx, a.HoldID, "USER_ABANDONED"); err != nil {
		t.Fatal(err)
	}
	if err := st.ConfirmHold(ctx, b.HoldID); err != nil {
		t.Fatalf("releasing hold A destroyed hold B: %v", err)
	}

	hold, sold, err := st.LiveMasks(ctx, tripID)
	if err != nil {
		t.Fatal(err)
	}
	if hold["A1"] != 0 {
		t.Fatalf("expected no residual hold bits on A1, got 0b%03b", hold["A1"])
	}
	if sold["A1"] != 0b100 {
		t.Fatalf("expected A1 sold mask 0b100 (Feni->Chattogram), got 0b%03b", sold["A1"])
	}
	t.Logf("two holds coexisted on one seat; release of A left B intact")
}

// ---------------------------------------------------------------------------
// PROOF 4 — the expiry race.
// A confirm arriving at the same instant as the sweeper must resolve to exactly
// one outcome. Never "paid but seat released"; never "seat sold but hold gone".
// ---------------------------------------------------------------------------
func TestProof4_ExpiryRace(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	iterations := envInt("PROOF_RACE_ITERS", 300)

	var confirmed, expired int
	for i := 0; i < iterations; i++ {
		st, tripID := newTrip(t, 3, 1)
		h, err := st.AcquireHold(ctx, HoldRequest{
			TripID: tripID, Seats: []string{"A1"},
			BoardSeq: 0, DropSeq: 3,
			TTL:      40 * time.Millisecond, // expires almost immediately
		})
		if err != nil {
			t.Fatal(err)
		}

		var wg sync.WaitGroup
		var confirmErr error
		wg.Add(2)
		go func() { defer wg.Done(); time.Sleep(40 * time.Millisecond); confirmErr = st.ConfirmHold(ctx, h.HoldID) }()
		go func() {
			defer wg.Done()
			time.Sleep(40 * time.Millisecond)
			for j := 0; j < 5; j++ {
				if _, err := st.SweepExpired(ctx, 10); err != nil {
					t.Errorf("sweep: %v", err)
					return
				}
				time.Sleep(2 * time.Millisecond)
			}
		}()
		wg.Wait()

		hold, sold, err := st.LiveMasks(ctx, tripID)
		if err != nil {
			t.Fatal(err)
		}
		var status string
		if err := pool.QueryRow(ctx,
			`SELECT status FROM inventory.seat_holds WHERE hold_id = $1::uuid`, h.HoldID).
			Scan(&status); err != nil {
			t.Fatal(err)
		}

		// Exactly two outcomes are permissible, and each pins a complete state.
		// There is deliberately no third branch: "payment taken, seat released"
		// and "seat sold, nobody paid" both have to be unreachable.
		switch {
		case confirmErr == nil:
			// Confirm won the row lock: seat SOLD, hold CONFIRMED.
			if sold["A1"] != 0b111 || hold["A1"] != 0 || status != "CONFIRMED" {
				t.Fatalf("iter %d: confirm succeeded but state is sold=0b%03b hold=0b%03b status=%s",
					i, sold["A1"], hold["A1"], status)
			}
			confirmed++

		// Sweeper won. Two distinguishable ways, both safe:
		//   ErrHoldNotActive — sweeper committed first, confirm saw EXPIRED and refused.
		//   ErrHoldLost      — defensive guard: the segment bits were already gone.
		// Either way the seat must be fully free and the hold settled EXPIRED.
		case errors.Is(confirmErr, ErrHoldNotActive), errors.Is(confirmErr, ErrHoldLost):
			if sold["A1"] != 0 || hold["A1"] != 0 || status != "EXPIRED" {
				t.Fatalf("iter %d: confirm lost (%v) but state is sold=0b%03b hold=0b%03b status=%s",
					i, confirmErr, sold["A1"], hold["A1"], status)
			}
			expired++

		default:
			t.Fatalf("iter %d: unexpected confirm error: %v", i, confirmErr)
		}
	}
	t.Logf("%d iterations resolved cleanly: %d confirmed, %d expired, 0 ambiguous",
		iterations, confirmed, expired)
}

// ---------------------------------------------------------------------------
// PROOF 5 — idempotent confirm.
// This is the seat-side half of the duplicated-payment-webhook guarantee: the
// same confirm delivered 100 times concurrently produces exactly one effect.
// ---------------------------------------------------------------------------
func TestProof5_IdempotentConfirm(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, tripID := newTrip(t, 3, 4)

	h, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1", "A2"}, BoardSeq: 0, DropSeq: 3, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}

	const replays = 100
	var wg sync.WaitGroup
	errs := make([]error, replays)
	for i := 0; i < replays; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); errs[i] = st.ConfirmHold(ctx, h.HoldID) }(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("replay %d failed: %v", i, err)
		}
	}

	var bookedEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM inventory.inventory_events
		 WHERE trip_id = $1::uuid AND event_type = 'SEAT_BOOKED'`, tripID).
		Scan(&bookedEvents); err != nil {
		t.Fatal(err)
	}
	if bookedEvents != 2 { // two seats, one event each
		t.Fatalf("INVARIANT VIOLATED: %d SEAT_BOOKED events from %d replays, expected 2",
			bookedEvents, replays)
	}
	t.Logf("%d concurrent confirm replays produced exactly 2 booking events", replays)
}

// ---------------------------------------------------------------------------
// PROOF 6 — all-or-nothing multi-seat holds, and no deadlocks.
// Two buyers each want overlapping seat sets in opposite order. Exactly one may
// win, the loser must leave zero seats taken, and neither may deadlock.
// ---------------------------------------------------------------------------
func TestProof6_MultiSeatAtomicity(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	rounds := envInt("PROOF_MULTISEAT_ROUNDS", 200)

	for i := 0; i < rounds; i++ {
		st, tripID := newTrip(t, 3, 8)
		var wg sync.WaitGroup
		results := make([]error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, results[0] = st.AcquireHold(ctx, HoldRequest{
				TripID: tripID, Seats: []string{"A1", "A2", "A3"}, BoardSeq: 0, DropSeq: 3, TTL: time.Minute})
		}()
		go func() {
			defer wg.Done()
			_, results[1] = st.AcquireHold(ctx, HoldRequest{
				TripID: tripID, Seats: []string{"A3", "A2", "B1"}, BoardSeq: 0, DropSeq: 3, TTL: time.Minute})
		}()
		wg.Wait()

		wins := 0
		for _, err := range results {
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrSeatUnavailable):
			default:
				t.Fatalf("round %d: unexpected error (deadlock?): %v", i, err)
			}
		}
		if wins != 1 {
			t.Fatalf("round %d: %d winners for overlapping seat sets, expected 1", i, wins)
		}

		// The loser must not have stranded a seat it failed to fully acquire.
		hold, _, err := st.LiveMasks(ctx, tripID)
		if err != nil {
			t.Fatal(err)
		}
		if len(hold) != 3 {
			t.Fatalf("round %d: %d seats held after one winning 3-seat hold, expected 3", i, len(hold))
		}
	}
	t.Logf("%d rounds of contended multi-seat holds: always exactly 1 winner, no partial holds, no deadlocks", rounds)
}

// ---------------------------------------------------------------------------
// PROOF 7 — event-log reconciliation.
// The live masks must equal the masks replayed from the append-only event log.
// If these ever diverge, a mutation lost or invented a fact.
// ---------------------------------------------------------------------------
func TestProof7_EventLogReconciles(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, tripID := newTrip(t, 3, 12)

	// A representative mix: confirmed, released, expired and live holds.
	mix := []struct {
		seat        string
		board, drop int
		action      string
	}{
		{"A1", 0, 1, "confirm"},
		{"A1", 1, 3, "confirm"},
		{"A2", 0, 3, "release"},
		{"A3", 1, 2, "confirm"},
		{"A4", 0, 2, "hold"},
		{"B1", 2, 3, "expire"},
		{"B2", 0, 3, "confirm"},
	}
	for _, m := range mix {
		ttl := time.Minute
		if m.action == "expire" {
			ttl = 20 * time.Millisecond
		}
		h, err := st.AcquireHold(ctx, HoldRequest{
			TripID: tripID, Seats: []string{m.seat},
			BoardSeq: m.board, DropSeq: m.drop, TTL: ttl})
		if err != nil {
			t.Fatalf("%s %s: %v", m.seat, m.action, err)
		}
		switch m.action {
		case "confirm":
			if err := st.ConfirmHold(ctx, h.HoldID); err != nil {
				t.Fatal(err)
			}
		case "release":
			if err := st.ReleaseHold(ctx, h.HoldID, "USER_ABANDONED"); err != nil {
				t.Fatal(err)
			}
		case "expire":
			time.Sleep(60 * time.Millisecond)
			if _, err := st.SweepExpired(ctx, 100); err != nil {
				t.Fatal(err)
			}
		}
	}

	liveHold, liveSold, err := st.LiveMasks(ctx, tripID)
	if err != nil {
		t.Fatal(err)
	}
	repHold, repSold, err := st.ReplayMasksFromEvents(ctx, tripID)
	if err != nil {
		t.Fatal(err)
	}
	for _, seat := range []string{"A1", "A2", "A3", "A4", "B1", "B2"} {
		if liveHold[seat] != repHold[seat] {
			t.Fatalf("seat %s hold mask diverged: live=0b%03b replayed=0b%03b", seat, liveHold[seat], repHold[seat])
		}
		if liveSold[seat] != repSold[seat] {
			t.Fatalf("seat %s sold mask diverged: live=0b%03b replayed=0b%03b", seat, liveSold[seat], repSold[seat])
		}
	}
	t.Logf("live table and replayed event log agree on every seat")
}

// ---------------------------------------------------------------------------
// PROOF 8 — the sweeper is the safety net when the cache is gone.
// Redis holds expiry timers for latency, but PostgreSQL is the authority. With
// no cache at all, expired holds must still free their seats.
// ---------------------------------------------------------------------------
func TestProof8_ExpirySweeperFreesSeats(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, tripID := newTrip(t, 3, 40)

	for i := 0; i < 10; i++ {
		if _, err := st.AcquireHold(ctx, HoldRequest{
			TripID: tripID, Seats: []string{fmt.Sprintf("%c%d", 'A'+rune(i/4), i%4+1)},
			BoardSeq: 0, DropSeq: 3, TTL: 30 * time.Millisecond,
		}); err != nil {
			t.Fatal(err)
		}
	}

	before, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if before != 30 {
		t.Fatalf("expected 30 free seats while 10 are held, got %d", before)
	}

	time.Sleep(80 * time.Millisecond)
	n, err := st.SweepExpired(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	after, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if n != 10 || after != 40 {
		t.Fatalf("sweeper released %d holds leaving %d free seats, expected 10 and 40", n, after)
	}
	t.Logf("sweeper reclaimed all %d expired holds with no cache involved", n)
}

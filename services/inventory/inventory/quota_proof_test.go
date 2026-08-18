package inventory

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

// Counter quota proofs.
//
// The plan's rule: a counter may sell offline ONLY from seats it exclusively
// owns. These tests assert that the rule is enforced by inventory-service and
// not by the point-of-sale terminal — because the terminal is the component
// that, by definition, cannot be reached when it matters.

func newCounter(t *testing.T) string {
	t.Helper()
	var operatorID string
	if err := pool.QueryRow(context.Background(),
		`SELECT operator_id::text FROM catalog.operators LIMIT 1`).Scan(&operatorID); err != nil {
		t.Fatal(err)
	}
	var counterID string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO counter.counters (operator_id, name)
		VALUES ($1::uuid, 'Proof Counter ' || gen_random_uuid()::text)
		RETURNING counter_id::text`, operatorID).Scan(&counterID); err != nil {
		t.Fatal(err)
	}
	return counterID
}

// Proof A — a quota seat leaves general sale.
//
// This is what makes offline selling safe. If a reserved seat stayed visible to
// the website, the counter and the website would both be able to sell it, and
// the counter would find out at the bus door.
func TestQuotaRemovesSeatFromGeneralSale(t *testing.T) {
	requireDB(t)
	st, tripID := newTrip(t, 3, 12)
	counterID := newCounter(t)
	ctx := context.Background()

	before, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := st.AllocateQuota(ctx, counterID, tripID, []string{"A1", "A2"}, 0, 3); err != nil {
		t.Fatal(err)
	}

	after, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if after != before-2 {
		t.Fatalf("quota did not remove seats from sale: %d available before, %d after", before, after)
	}

	// And a passenger cannot hold one.
	if _, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3, Channel: "WEB",
	}); !errors.Is(err, ErrSeatUnavailable) {
		t.Fatalf("the website was able to hold a seat the counter owns: %v", err)
	}

	// Releasing puts it back, exactly.
	mask, _ := SegmentMask(0, 3)
	if err := st.ReleaseQuota(ctx, counterID, tripID, []string{"A1", "A2"}, mask); err != nil {
		t.Fatal(err)
	}
	restored, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if restored != before {
		t.Fatalf("released quota did not return to sale: %d vs %d", restored, before)
	}
}

// Proof B — an offline sale outside the quota is impossible.
//
// The single most important assertion in the counter workstream. A terminal
// that has been offline for an hour will happily replay whatever its operator
// typed; the seat it did not own must be refused here, by the service.
func TestOfflineSaleOutsideQuotaIsRefused(t *testing.T) {
	requireDB(t)
	st, tripID := newTrip(t, 3, 12)
	counterID := newCounter(t)
	other := newCounter(t)
	ctx := context.Background()

	if _, err := st.AllocateQuota(ctx, counterID, tripID, []string{"A1"}, 0, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AllocateQuota(ctx, other, tripID, []string{"A2"}, 0, 3); err != nil {
		t.Fatal(err)
	}

	// Its own seat: fine.
	if _, err := st.SellQuota(ctx, counterID, tripID, []string{"A1"}, 0, 3, nil); err != nil {
		t.Fatalf("a counter could not sell its own quota seat: %v", err)
	}

	// A seat that was never reserved: refused.
	if _, err := st.SellQuota(ctx, counterID, tripID, []string{"B1"}, 0, 3, nil); !errors.Is(err, ErrNotInQuota) {
		t.Fatalf("a counter sold a seat outside its quota: %v", err)
	}

	// Another counter's reserved seat: also refused. Owning *a* quota is not
	// the same as owning *this* seat.
	if _, err := st.SellQuota(ctx, counterID, tripID, []string{"A2"}, 0, 3, nil); !errors.Is(err, ErrNotInQuota) {
		t.Fatalf("a counter sold another counter's quota seat: %v", err)
	}

	// B1 must still be sellable by everyone else — the refused attempt changed
	// nothing.
	if _, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"B1"}, BoardSeq: 0, DropSeq: 3, Channel: "WEB",
	}); err != nil {
		t.Fatalf("a refused quota sale left seat B1 damaged: %v", err)
	}
}

// Proof C — replaying an offline sale sells once.
//
// A terminal on a bad line flushes its queue repeatedly. The seat bits move
// blocked → sold exactly once, so every replay after the first is refused
// rather than producing a second booking.
func TestQuotaSaleSurvivesReplayStorm(t *testing.T) {
	requireDB(t)
	st, tripID := newTrip(t, 3, 12)
	counterID := newCounter(t)
	ctx := context.Background()

	if _, err := st.AllocateQuota(ctx, counterID, tripID, []string{"C1"}, 0, 3); err != nil {
		t.Fatal(err)
	}

	const replays = 40
	var sold, refused int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < replays; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := st.SellQuota(ctx, counterID, tripID, []string{"C1"}, 0, 3, nil); err == nil {
				atomic.AddInt64(&sold, 1)
			} else {
				atomic.AddInt64(&refused, 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if sold != 1 {
		t.Fatalf("%d replays produced %d sales; expected exactly 1", replays, sold)
	}
	t.Logf("%d concurrent replays → 1 sale, %d refused", replays, refused)

	var soldMask, blockedMask int64
	if err := pool.QueryRow(ctx, `
		SELECT segment_sold_mask, blocked_mask FROM inventory.trip_seats
		 WHERE trip_id = $1::uuid AND seat_no = 'C1'`, tripID).Scan(&soldMask, &blockedMask); err != nil {
		t.Fatal(err)
	}
	want, _ := SegmentMask(0, 3)
	if soldMask != want {
		t.Fatalf("sold mask is %b, expected %b", soldMask, want)
	}
	if blockedMask != 0 {
		t.Fatalf("seat is still blocked after being sold: %b", blockedMask)
	}
}

// Proof D — quota respects segments.
//
// A counter holding Dhaka→Cumilla must not thereby own Feni→Chattogram. The
// segment arithmetic that makes multi-stop selling work has to apply to quota
// exactly as it applies to a passenger hold.
func TestQuotaIsSegmentScoped(t *testing.T) {
	requireDB(t)
	st, tripID := newTrip(t, 3, 12)
	counterID := newCounter(t)
	ctx := context.Background()

	// Reserve the first leg only.
	if _, err := st.AllocateQuota(ctx, counterID, tripID, []string{"B2"}, 0, 1); err != nil {
		t.Fatal(err)
	}

	// The last leg of the same physical seat is still free for the website.
	if _, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"B2"}, BoardSeq: 2, DropSeq: 3, Channel: "WEB",
	}); err != nil {
		t.Fatalf("counter quota on leg 1 wrongly blocked leg 3: %v", err)
	}

	// But an overlapping journey is blocked.
	if _, err := st.AcquireHold(ctx, HoldRequest{
		TripID: tripID, Seats: []string{"B2"}, BoardSeq: 0, DropSeq: 2, Channel: "WEB",
	}); !errors.Is(err, ErrSeatUnavailable) {
		t.Fatalf("an overlapping journey was sold over the counter's quota: %v", err)
	}

	// And the counter cannot stretch its quota to a leg it did not reserve.
	if _, err := st.SellQuota(ctx, counterID, tripID, []string{"B2"}, 0, 3, nil); !errors.Is(err, ErrNotInQuota) {
		t.Fatalf("a counter sold a longer journey than it reserved: %v", err)
	}
}

// Proof E — the quota ceiling holds.
//
// Without a cap, a counter could quietly take an entire bus out of general sale.
func TestQuotaIsCapped(t *testing.T) {
	requireDB(t)
	st, tripID := newTrip(t, 3, 40)
	counterID := newCounter(t)
	ctx := context.Background()

	tooMany := make([]string, 0, MaxQuotaSeats+1)
	for i := 0; i <= MaxQuotaSeats; i++ {
		tooMany = append(tooMany, seatName(i))
	}
	if _, err := st.AllocateQuota(ctx, counterID, tripID, tooMany, 0, 3); !errors.Is(err, ErrQuotaTooLarge) {
		t.Fatalf("a counter reserved more than the cap: %v", err)
	}

	// And nothing was reserved — the refusal is all-or-nothing.
	before, err := st.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if before != 40 {
		t.Fatalf("a rejected over-cap request still blocked seats: %d of 40 available", before)
	}
}

func seatName(i int) string {
	return string(rune('A'+i/4)) + string(rune('1'+i%4))
}

package commerce

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/inventory/inventory"
)

// The second half of the Phase 1 exit gate: money.
//
// The spec's requirement is blunt — fire the same payment webhook 100 times and
// the system must produce 1 payment, 1 booking confirmation, 1 ticket. These
// tests execute that against a real database.

var (
	pool *pgxpool.Pool
	inv  *inventory.Store
	svc  *Service
)

func TestMain(m *testing.M) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Println("DATABASE_URL not set; skipping commerce proof suite")
		os.Exit(0)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.MaxConns = 40
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var err error
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
	inv = inventory.New(pool)
	svc = New(pool, inv, []byte("qr-signing-key-v1"), []byte("provider-webhook-secret"))
	os.Exit(m.Run())
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

const operatorID = "11111111-1111-1111-1111-111111111111"

// bookedTrip opens a trip, holds two seats and creates a PAYMENT_PENDING booking.
func bookedTrip(t *testing.T) (tripID, bookingID, holdID string, total int64) {
	t.Helper()
	ctx := context.Background()

	tripID = mustUUID(t)
	seats := []inventory.SeatSpec{
		{SeatNo: "A1", Row: 0, Col: 1}, {SeatNo: "A2", Row: 0, Col: 2},
		{SeatNo: "A3", Row: 0, Col: 3}, {SeatNo: "A4", Row: 0, Col: 4},
	}
	if err := inv.OpenTrip(ctx, tripID, 3, seats); err != nil {
		t.Fatal(err)
	}
	h, err := inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: tripID, Seats: []string{"A1", "A2"},
		BoardSeq: 0, DropSeq: 3, Channel: "WEB", TTL: 10 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	total = 120000 // 1200.00 BDT, the worked example from the plan
	bookingID, _, err = svc.CreateBooking(ctx, BookingRequest{
		HoldID: h.HoldID, TripID: tripID, OperatorID: operatorID,
		Seats: []string{"A1", "A2"}, BoardSeq: 0, DropSeq: 3,
		Channel: "WEB", TotalPoisha: total,
	})
	if err != nil {
		t.Fatal(err)
	}
	return tripID, bookingID, h.HoldID, total
}

func mustUUID(t *testing.T) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(), `SELECT gen_random_uuid()::text`).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// ---------------------------------------------------------------------------
// PROOF 9 — the webhook storm.
// The same signed webhook delivered N times concurrently must produce exactly
// one payment, one confirmation, one ticket per seat, and one balanced journal.
// ---------------------------------------------------------------------------
func TestProof9_WebhookStorm(t *testing.T) {
	ctx := context.Background()
	replays := envInt("PROOF_WEBHOOK_REPLAYS", 100)

	_, bookingID, _, total := bookedTrip(t)
	w := Webhook{
		Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
		BookingID: bookingID, AmountPoisha: total, Currency: "BDT",
	}
	w.Signature = svc.Sign(w)

	var accepted, duplicate, failed int64
	var wg sync.WaitGroup
	for i := 0; i < replays; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := svc.HandleWebhook(ctx, w)
			switch {
			case err != nil:
				atomic.AddInt64(&failed, 1)
				t.Errorf("webhook error: %v", err)
			case ok:
				atomic.AddInt64(&accepted, 1)
			default:
				atomic.AddInt64(&duplicate, 1)
			}
		}()
	}
	wg.Wait()

	t.Logf("replays=%d accepted=%d duplicate=%d failed=%d", replays, accepted, duplicate, failed)
	if failed != 0 {
		t.Fatalf("%d webhook deliveries errored", failed)
	}
	if accepted != 1 {
		t.Fatalf("INVARIANT VIOLATED: %d webhooks accepted, expected exactly 1", accepted)
	}

	assertCount(t, `SELECT count(*) FROM commerce.payments WHERE booking_id=$1::uuid`, bookingID, 1, "payment rows")
	assertCount(t, `SELECT count(*) FROM commerce.tickets WHERE booking_id=$1::uuid`, bookingID, 2, "tickets")
	assertCount(t, `SELECT count(*) FROM commerce.booking_status_history
	                 WHERE booking_id=$1::uuid AND to_status='TICKETED'`, bookingID, 1, "confirmations")

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM commerce.bookings WHERE booking_id=$1::uuid`, bookingID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "TICKETED" {
		t.Fatalf("booking status = %s, expected TICKETED", status)
	}
	t.Logf("%d duplicate deliveries produced 1 payment, 1 confirmation, 2 tickets", replays)
}

// ---------------------------------------------------------------------------
// PROOF 10 — the verification chain rejects tampering.
// Bad signature, wrong amount, wrong currency and unknown booking must each be
// refused, and none may move a seat or a taka.
// ---------------------------------------------------------------------------
func TestProof10_WebhookVerificationChain(t *testing.T) {
	ctx := context.Background()
	_, bookingID, _, total := bookedTrip(t)

	good := Webhook{Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
		BookingID: bookingID, AmountPoisha: total, Currency: "BDT"}

	cases := []struct {
		name  string
		mutate func(Webhook) Webhook
	}{
		{"tampered signature", func(w Webhook) Webhook { w.Signature = "not-a-real-signature"; return w }},
		{"wrong amount", func(w Webhook) Webhook {
			w.AmountPoisha = 1
			w.Signature = svc.Sign(w) // correctly signed, but disagrees with the booking
			return w
		}},
		{"wrong currency", func(w Webhook) Webhook { w.Currency = "USD"; w.Signature = svc.Sign(w); return w }},
		{"unknown booking", func(w Webhook) Webhook {
			w.BookingID = mustUUID(t)
			w.Signature = svc.Sign(w)
			return w
		}},
	}

	for _, tc := range cases {
		w := tc.mutate(good)
		ok, err := svc.HandleWebhook(ctx, w)
		if ok || err == nil {
			t.Fatalf("%s: webhook was accepted (ok=%v err=%v)", tc.name, ok, err)
		}
	}

	assertCount(t, `SELECT count(*) FROM commerce.payments WHERE booking_id=$1::uuid`, bookingID, 0, "payments")
	assertCount(t, `SELECT count(*) FROM commerce.tickets WHERE booking_id=$1::uuid`, bookingID, 0, "tickets")

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM commerce.bookings WHERE booking_id=$1::uuid`, bookingID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "PAYMENT_PENDING" {
		t.Fatalf("rejected webhooks changed booking status to %s", status)
	}
	t.Logf("all 4 tampering cases rejected; no payment, no ticket, no state change")
}

// ---------------------------------------------------------------------------
// PROOF 11 — the ledger balances.
// Every ticketed booking posts a balanced journal, and the platform-wide trial
// balance is exactly zero. This is what makes Phase 2's finance work possible
// without a backfill.
// ---------------------------------------------------------------------------
func TestProof11_LedgerBalances(t *testing.T) {
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		_, bookingID, _, total := bookedTrip(t)
		w := Webhook{Provider: "NAGAD", ProviderTxnID: "TXN-" + randomHex(8),
			BookingID: bookingID, AmountPoisha: total, Currency: "BDT"}
		w.Signature = svc.Sign(w)
		if ok, err := svc.HandleWebhook(ctx, w); err != nil || !ok {
			t.Fatalf("webhook %d rejected: ok=%v err=%v", i, ok, err)
		}
	}

	var variance int64
	if err := pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).Scan(&variance); err != nil {
		t.Fatal(err)
	}
	if variance != 0 {
		t.Fatalf("INVARIANT VIOLATED: trial balance is %d poisha, expected 0", variance)
	}

	t.Logf("trial balance variance = %d poisha", variance)

	// Every journal balances on its own, not merely in aggregate. A platform
	// where two opposite errors cancel out still has a zero trial balance and
	// two wrong journals, so this is the stronger assertion.
	var unbalanced int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		  SELECT journal_id
		    FROM finance.ledger_entries
		   GROUP BY journal_id
		  HAVING COALESCE(sum(amount_poisha) FILTER (WHERE side='DR'),0)
		      <> COALESCE(sum(amount_poisha) FILTER (WHERE side='CR'),0)
		) x`).Scan(&unbalanced); err != nil {
		t.Fatal(err)
	}
	if unbalanced != 0 {
		t.Fatalf("INVARIANT VIOLATED: %d journals do not balance on their own", unbalanced)
	}

	// The worked example from the plan, checked on ONE gateway sale.
	//
	// Deliberately scoped to a single journal. These four accounts are no
	// longer gateway-only — a counter cash sale credits Operator Payable while
	// debiting Cash, and an agent sale debits Agent Payable — so summing them
	// platform-wide asserts an equation that was only ever true when the
	// website was the sole channel.
	_, bookingID, _, total := bookedTrip(t)
	w := Webhook{Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
		BookingID: bookingID, AmountPoisha: total, Currency: "BDT"}
	w.Signature = svc.Sign(w)
	if ok, err := svc.HandleWebhook(ctx, w); err != nil || !ok {
		t.Fatalf("worked-example webhook rejected: ok=%v err=%v", ok, err)
	}

	var dr1101, dr5102, cr2101, cr4101 int64
	if err := pool.QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(amount_poisha) FILTER (WHERE account_code='1101' AND side='DR'),0),
		  COALESCE(SUM(amount_poisha) FILTER (WHERE account_code='5102' AND side='DR'),0),
		  COALESCE(SUM(amount_poisha) FILTER (WHERE account_code='2101' AND side='CR'),0),
		  COALESCE(SUM(amount_poisha) FILTER (WHERE account_code='4101' AND side='CR'),0)
		  FROM finance.ledger_entries
		 WHERE journal_id = (
		   SELECT j.journal_id FROM finance.journal_entries j
		     JOIN commerce.bookings b ON j.description = 'booking ticketed ' || b.pnr
		    WHERE b.booking_id = $1::uuid)`, bookingID).
		Scan(&dr1101, &dr5102, &cr2101, &cr4101); err != nil {
		t.Fatal(err)
	}
	t.Logf("one gateway sale of %d poisha: clearing DR=%d fee DR=%d operator CR=%d platform CR=%d",
		total, dr1101, dr5102, cr2101, cr4101)

	want := GatewayPostings(total, "BKASH", "")
	byAccount := map[string]int64{}
	for _, p := range want {
		byAccount[p.Account] = p.Amount
	}
	for acct, got := range map[string]int64{"1101": dr1101, "5102": dr5102, "2101": cr2101, "4101": cr4101} {
		if got != byAccount[acct] {
			t.Fatalf("account %s posted %d, the plan's split says %d", acct, got, byAccount[acct])
		}
	}
	if dr1101+dr5102 != cr2101+cr4101 {
		t.Fatalf("the sale's own journal does not balance: DR=%d CR=%d",
			dr1101+dr5102, cr2101+cr4101)
	}
}

// ---------------------------------------------------------------------------
// PROOF 12 — end to end.
// hold -> booking -> webhook -> confirm -> ticket, with the seat provably sold
// in the inventory service afterwards. One run of the whole Phase 1 chain.
// ---------------------------------------------------------------------------
func TestProof12_EndToEnd(t *testing.T) {
	ctx := context.Background()
	tripID, bookingID, holdID, total := bookedTrip(t)

	before, err := inv.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}

	w := Webhook{Provider: "BKASH", ProviderTxnID: "TXN-" + randomHex(8),
		BookingID: bookingID, AmountPoisha: total, Currency: "BDT"}
	w.Signature = svc.Sign(w)
	if ok, err := svc.HandleWebhook(ctx, w); err != nil || !ok {
		t.Fatalf("webhook rejected: ok=%v err=%v", ok, err)
	}

	after, err := inv.CountAvailable(ctx, tripID, 0, 3)
	if err != nil {
		t.Fatal(err)
	}

	var holdStatus string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM inventory.seat_holds WHERE hold_id=$1::uuid`, holdID).Scan(&holdStatus); err != nil {
		t.Fatal(err)
	}
	if holdStatus != "CONFIRMED" {
		t.Fatalf("hold status = %s, expected CONFIRMED", holdStatus)
	}

	// The seats are now SOLD, not merely held: a fresh buyer cannot take them.
	if _, err := inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: tripID, Seats: []string{"A1"}, BoardSeq: 0, DropSeq: 3, TTL: time.Minute,
	}); err == nil {
		t.Fatal("INVARIANT VIOLATED: a sold seat was acquired again")
	}

	var qr string
	if err := pool.QueryRow(ctx,
		`SELECT qr_token FROM commerce.tickets WHERE booking_id=$1::uuid AND seat_no='A1'`, bookingID).
		Scan(&qr); err != nil {
		t.Fatal(err)
	}
	if len(qr) < 10 || qr[:3] != "k1." {
		t.Fatalf("QR token not key-id prefixed: %q", qr)
	}
	t.Logf("search->hold->book->pay->confirm->ticket complete; free seats %d->%d, QR=%s...",
		before, after, qr[:12])
}

func assertCount(t *testing.T, q, arg string, want int, label string) {
	t.Helper()
	var got int
	if err := pool.QueryRow(context.Background(), q, arg).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("INVARIANT VIOLATED: %s = %d, expected %d", label, got, want)
	}
}

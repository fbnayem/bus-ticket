package wallet

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

// Agent wallet proofs.
//
// An agent wallet is money the platform holds on someone else's behalf, spent
// concurrently from a portal, and backed by a credit line. Every failure mode
// here costs real taka:
//
//   - overselling a credit limit is an unsecured loan nobody approved
//   - a cached balance that drifts from its log is a number no auditor accepts
//   - a hold that is captured twice charges an agent twice for one ticket
//   - a self-approved recharge is money invented by the person who benefits
//
// Each of these is asserted below under concurrency, not in the happy path.

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

// newWallet creates an isolated agency and wallet so tests never contend.
func newWallet(t *testing.T, available, credit int64) (*Store, string, string) {
	t.Helper()
	ctx := context.Background()
	var agencyID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent.agencies (name, kyc_status)
		VALUES ('Proof Agency ' || gen_random_uuid()::text, 'VERIFIED')
		RETURNING agency_id::text`).Scan(&agencyID); err != nil {
		t.Fatal(err)
	}
	var walletID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent.wallets (agency_id, available_poisha, credit_limit_poisha)
		VALUES ($1::uuid, $2, $3) RETURNING wallet_id::text`,
		agencyID, available, credit).Scan(&walletID); err != nil {
		t.Fatal(err)
	}
	// The opening balance exists as a transaction, not just a number, so the
	// wallet can be rebuilt from its log and still match.
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent.wallet_transactions (wallet_id, kind, delta_poisha, ref)
		VALUES ($1::uuid, 'RECHARGE', $2, 'proof-opening')`, walletID, available); err != nil {
		t.Fatal(err)
	}
	return New(pool), agencyID, walletID
}

// Proof 1 — an agent wallet cannot be oversold.
//
// The Phase 2 exit gate asks for exactly this: a wallet with balance and credit
// for ten tickets, a thousand concurrent purchase attempts, at most ten sales
// and zero negative equity.
func TestWalletCannotOversell(t *testing.T) {
	requireDB(t)
	const (
		ticket    = 120000 // ৳1,200
		capacity  = 10
		attempts  = 1000
		available = ticket * 4
		credit    = ticket * 6 // exactly ten tickets of spending power
	)
	st, agencyID, walletID := newWallet(t, available, credit)
	ctx := context.Background()

	var won, refused, other int64
	var wg sync.WaitGroup
	start := make(chan struct{})

	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := st.Hold(ctx, agencyID, ticket, "")
			switch {
			case err == nil:
				atomic.AddInt64(&won, 1)
			case errors.Is(err, ErrInsufficient):
				atomic.AddInt64(&refused, 1)
			default:
				atomic.AddInt64(&other, 1)
				t.Error("unexpected error:", err)
			}
		}()
	}
	began := time.Now()
	close(start)
	wg.Wait()
	elapsed := time.Since(began)

	t.Logf("%d attempts in %s — %d held, %d refused, %d errors",
		attempts, elapsed.Round(time.Millisecond), won, refused, other)

	if won > capacity {
		t.Fatalf("wallet oversold: %d holds against capacity for %d", won, capacity)
	}
	if won != capacity {
		// Fewer than capacity would mean the check is too strict and the agent
		// is being denied money they actually have.
		t.Fatalf("expected exactly %d holds, got %d", capacity, won)
	}
	if refused != attempts-capacity {
		t.Fatalf("expected %d clean refusals, got %d", attempts-capacity, refused)
	}
	if other != 0 {
		t.Fatalf("%d attempts failed with something other than a clean refusal", other)
	}

	// Spending power must be exactly zero, never negative.
	w, err := st.Get(ctx, agencyID)
	if err != nil {
		t.Fatal(err)
	}
	if w.Spendable != 0 {
		t.Fatalf("spendable power should be exactly 0, got %d", w.Spendable)
	}
	if w.Available-w.Held < -w.CreditLimit {
		t.Fatalf("wallet is beyond its credit limit: available %d held %d limit %d",
			w.Available, w.Held, w.CreditLimit)
	}

	// And the cache must agree with the log.
	recAvail, recHeld, err := st.Recompute(ctx, walletID)
	if err != nil {
		t.Fatal(err)
	}
	if recAvail != w.Available || recHeld != w.Held {
		t.Fatalf("cache drifted from the log: cached (%d,%d) recomputed (%d,%d)",
			w.Available, w.Held, recAvail, recHeld)
	}
}

// Proof 2 — capture is idempotent.
//
// A retried capture must charge once. Without this, any retry anywhere in the
// sale path — a timeout, a redelivered message, an impatient clerk — charges an
// agent twice for one ticket.
func TestCaptureIsIdempotent(t *testing.T) {
	requireDB(t)
	const amount = 50000
	st, agencyID, walletID := newWallet(t, 500000, 0)
	ctx := context.Background()

	holdID, err := st.Hold(ctx, agencyID, amount, "")
	if err != nil {
		t.Fatal(err)
	}

	// Fire 50 concurrent captures of the same hold.
	var wg sync.WaitGroup
	var failures int64
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := st.Capture(ctx, holdID, ""); err != nil {
				atomic.AddInt64(&failures, 1)
			}
		}()
	}
	wg.Wait()
	if failures != 0 {
		t.Fatalf("%d captures returned an error; replays must be no-ops", failures)
	}

	var saleCount int
	var totalSale int64
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(delta_poisha),0) FROM agent.wallet_transactions
		 WHERE wallet_id = $1::uuid AND kind = 'SALE'`, walletID).Scan(&saleCount, &totalSale); err != nil {
		t.Fatal(err)
	}
	if saleCount != 1 {
		t.Fatalf("50 captures produced %d sale rows; expected exactly 1", saleCount)
	}
	if totalSale != -amount {
		t.Fatalf("charged %d, expected %d", -totalSale, amount)
	}

	w, err := st.Get(ctx, agencyID)
	if err != nil {
		t.Fatal(err)
	}
	if w.Held != 0 {
		t.Fatalf("hold not cleared after capture: %d still held", w.Held)
	}
	recAvail, recHeld, err := st.Recompute(ctx, walletID)
	if err != nil {
		t.Fatal(err)
	}
	if recAvail != w.Available || recHeld != w.Held {
		t.Fatalf("cache drifted: cached (%d,%d) recomputed (%d,%d)",
			w.Available, w.Held, recAvail, recHeld)
	}
}

// Proof 3 — a released hold returns the money and nothing else.
//
// Release runs on every failed sale, and it runs more than once when a retry
// races a cleanup. Releasing twice must not hand the agent free credit.
func TestReleaseIsIdempotentAndRestoresPower(t *testing.T) {
	requireDB(t)
	const amount = 75000
	st, agencyID, walletID := newWallet(t, 300000, 100000)
	ctx := context.Background()

	before, err := st.Get(ctx, agencyID)
	if err != nil {
		t.Fatal(err)
	}
	holdID, err := st.Hold(ctx, agencyID, amount, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if err := st.Release(ctx, holdID, "PROOF"); err != nil {
			t.Fatalf("release %d failed: %v", i, err)
		}
	}
	after, err := st.Get(ctx, agencyID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Spendable != before.Spendable {
		t.Fatalf("spending power changed after hold+release: %d → %d",
			before.Spendable, after.Spendable)
	}
	if after.Held != 0 {
		t.Fatalf("%d still held after release", after.Held)
	}

	// A released hold must leave no SALE transaction behind.
	var sales int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM agent.wallet_transactions WHERE wallet_id=$1::uuid AND kind='SALE'`,
		walletID).Scan(&sales); err != nil {
		t.Fatal(err)
	}
	if sales != 0 {
		t.Fatalf("a released hold produced %d sale rows", sales)
	}
}

// Proof 4 — a recharge cannot be approved by the person who requested it.
//
// Asserted against the database, not the service: even if a future caller
// forgets the check, the CHECK constraint refuses the row.
func TestRechargeRequiresASecondPerson(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	st, agencyID, walletID := newWallet(t, 0, 0)

	maker, checker := proofStaff(t, "maker"), proofStaff(t, "checker")

	rid, err := st.RequestRecharge(ctx, agencyID, 250000, "BKASH", "PROOF-TRX", maker)
	if err != nil {
		t.Fatal(err)
	}

	// Requesting must not move the balance.
	w, _ := st.Get(ctx, agencyID)
	if w.Available != 0 {
		t.Fatalf("balance moved on request alone: %d", w.Available)
	}

	if err := st.ApproveRecharge(ctx, rid, maker); err == nil {
		t.Fatal("the requester was allowed to approve their own recharge")
	}
	w, _ = st.Get(ctx, agencyID)
	if w.Available != 0 {
		t.Fatalf("a refused self-approval still moved the balance: %d", w.Available)
	}

	// The constraint, directly. This is the backstop behind the service check.
	_, err = pool.Exec(ctx, `
		UPDATE agent.recharges SET approved_by = requested_by, approved_at = now()
		 WHERE recharge_id = $1::uuid`, rid)
	if err == nil {
		t.Fatal("the database accepted a self-approval; the CHECK constraint is missing")
	}

	if err := st.ApproveRecharge(ctx, rid, checker); err != nil {
		t.Fatalf("a legitimate approval was refused: %v", err)
	}
	w, _ = st.Get(ctx, agencyID)
	if w.Available != 250000 {
		t.Fatalf("approved recharge did not credit the wallet: %d", w.Available)
	}

	// Approving twice must not credit twice.
	_ = st.ApproveRecharge(ctx, rid, checker)
	w, _ = st.Get(ctx, agencyID)
	if w.Available != 250000 {
		t.Fatalf("a replayed approval credited again: %d", w.Available)
	}

	recAvail, _, err := st.Recompute(ctx, walletID)
	if err != nil {
		t.Fatal(err)
	}
	if recAvail != w.Available {
		t.Fatalf("cache %d disagrees with the log %d", w.Available, recAvail)
	}

	// The money movement must have landed in the ledger, balanced.
	var variance float64
	if err := pool.QueryRow(ctx, `SELECT variance_poisha FROM finance.trial_balance`).
		Scan(&variance); err != nil {
		t.Fatal(err)
	}
	if variance != 0 {
		t.Fatalf("trial balance is off by %v poisha after a recharge", variance)
	}
}

func proofStaff(t *testing.T, role string) string {
	t.Helper()
	salt, hash, iter, err := NewProofPassword()
	if err != nil {
		t.Fatal(err)
	}
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO staff.staff_users (email, full_name, password_hash, password_salt, password_iter)
		VALUES ('proof-' || $1 || '-' || gen_random_uuid()::text || '@test', $1, $2, $3, $4)
		RETURNING staff_id::text`, role, hash, salt, iter).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// NewProofPassword avoids importing staff-service here — the wallet has no
// business knowing how passwords are hashed, and these fixtures never sign in.
func NewProofPassword() (salt, hash string, iter int, err error) {
	return "proofsalt", "unusable-hash", 1, nil
}

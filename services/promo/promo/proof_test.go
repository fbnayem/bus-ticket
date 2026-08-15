package promo_test

// Proof: a limited campaign cannot over-redeem.
//
// This is the same class of bug as a double-sold seat, and it gets the same
// treatment. A coupon capped at 25 that redeems 137 times because a thousand
// people checked out inside the same second is not a rounding error — it is
// money the platform pays out and cannot get back.
//
// Run against the compose database:
//   docker compose run --rm proof

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/promo/promo"
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
	cfg.MaxConns = 60
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	return pool
}

// newCampaign creates a campaign with a hard cap and returns its code.
func newCampaign(t *testing.T, pool *pgxpool.Pool, cap_, perUser int) string {
	t.Helper()
	code := fmt.Sprintf("PROOF%d", time.Now().UnixNano()%100000000)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO promo.campaigns
			(code, title, kind, discount_pct, max_discount_poisha, min_amount_poisha,
			 max_redemptions, per_user_limit, ends_at)
		VALUES ($1, 'concurrency proof', 'LIMITED', 10, 20000, 0, $2, $3, now() + interval '1 day')`,
		code, cap_, perUser); err != nil {
		t.Fatalf("create campaign: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM promo.redemptions WHERE campaign_id IN
			(SELECT campaign_id FROM promo.campaigns WHERE code = $1)`, code)
		_, _ = pool.Exec(ctx, `DELETE FROM promo.user_usage WHERE campaign_id IN
			(SELECT campaign_id FROM promo.campaigns WHERE code = $1)`, code)
		_, _ = pool.Exec(ctx, `DELETE FROM promo.campaigns WHERE code = $1`, code)
	})
	return code
}

// Proof 1: 1,000 different people redeem a coupon capped at 25, all at once.
// Exactly 25 succeed. Nothing partially redeems.
func TestProof1_CouponCannotOverRedeem(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	store := promo.New(pool)

	const contenders = 1000
	const cap_ = 25
	code := newCampaign(t, pool, cap_, 1)

	var claimed, refused, errs int64
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(contenders)

	for i := 0; i < contenders; i++ {
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := store.Claim(ctx, code, "", promo.Context{
				UserKey:      fmt.Sprintf("+8801%09d", i),
				AmountPoisha: 150000,
				Channel:      "WEB",
			})
			switch {
			case err == nil:
				atomic.AddInt64(&claimed, 1)
			case err == promo.ErrExhausted || err == promo.ErrPerUserLimit:
				atomic.AddInt64(&refused, 1)
			default:
				atomic.AddInt64(&errs, 1)
				t.Logf("unexpected: %v", err)
			}
		}(i)
	}

	began := time.Now()
	close(start)
	wg.Wait()
	took := time.Since(began)

	var redeemed, rows int
	if err := pool.QueryRow(ctx, `
		SELECT c.redeemed, (SELECT count(*) FROM promo.redemptions r WHERE r.campaign_id = c.campaign_id)
		  FROM promo.campaigns c WHERE c.code = $1`, code).Scan(&redeemed, &rows); err != nil {
		t.Fatalf("read campaign: %v", err)
	}

	t.Logf("%d contenders, cap %d: %d claimed, %d refused, %d errors in %v",
		contenders, cap_, claimed, refused, errs, took.Round(time.Millisecond))

	if claimed != cap_ {
		t.Fatalf("expected exactly %d successful claims, got %d", cap_, claimed)
	}
	if redeemed != cap_ {
		t.Fatalf("campaign counter says %d redeemed, expected %d", redeemed, cap_)
	}
	if errs != 0 {
		t.Fatalf("expected clean refusals, got %d errors", errs)
	}
	if int64(refused) != contenders-cap_ {
		t.Fatalf("expected %d refusals, got %d", contenders-cap_, refused)
	}
}

// Proof 2: the per-user limit holds under concurrency too. One person, 200
// simultaneous attempts, a limit of 3.
func TestProof2_PerUserLimitHoldsUnderConcurrency(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	store := promo.New(pool)

	const attempts = 200
	const perUser = 3
	code := newCampaign(t, pool, 1000, perUser)

	var claimed, refused int64
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(attempts)
	for i := 0; i < attempts; i++ {
		go func() {
			defer wg.Done()
			<-start
			if _, err := store.Claim(ctx, code, "", promo.Context{
				UserKey: "+8801711111111", AmountPoisha: 150000, Channel: "WEB",
			}); err == nil {
				atomic.AddInt64(&claimed, 1)
			} else {
				atomic.AddInt64(&refused, 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	t.Logf("one person, %d simultaneous attempts, limit %d: %d claimed, %d refused",
		attempts, perUser, claimed, refused)
	if claimed != perUser {
		t.Fatalf("expected exactly %d claims for one person, got %d", perUser, claimed)
	}
}

// Proof 3: releasing a redemption returns it to the pool exactly once, so an
// abandoned checkout does not quietly burn a coupon and a double release does
// not hand out a free one.
func TestProof3_ReleaseIsIdempotent(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()
	store := promo.New(pool)

	code := newCampaign(t, pool, 5, 5)

	var bookingID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&bookingID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := store.Claim(ctx, code, bookingID, promo.Context{
		UserKey: "+8801722222222", AmountPoisha: 150000, Channel: "WEB",
	}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	var afterClaim int
	_ = pool.QueryRow(ctx, `SELECT redeemed FROM promo.campaigns WHERE code = $1`, code).Scan(&afterClaim)
	if afterClaim != 1 {
		t.Fatalf("expected 1 redemption after claim, got %d", afterClaim)
	}

	for i := 0; i < 5; i++ {
		if err := store.Release(ctx, bookingID); err != nil {
			t.Fatalf("release %d: %v", i, err)
		}
	}

	var afterRelease, usage int
	_ = pool.QueryRow(ctx, `SELECT redeemed FROM promo.campaigns WHERE code = $1`, code).Scan(&afterRelease)
	_ = pool.QueryRow(ctx, `
		SELECT COALESCE(sum(used),0) FROM promo.user_usage u
		  JOIN promo.campaigns c USING (campaign_id) WHERE c.code = $1`, code).Scan(&usage)

	t.Logf("claimed once, released five times: campaign counter %d, user usage %d", afterRelease, usage)
	if afterRelease != 0 {
		t.Fatalf("expected the redemption returned exactly once, counter is %d", afterRelease)
	}
	if usage != 0 {
		t.Fatalf("expected the user's allowance restored exactly once, usage is %d", usage)
	}
}

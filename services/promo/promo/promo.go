// Package promo is promotions and referrals (plan workstream P2-H).
//
// The only interesting engineering problem here is the same one the seat
// inventory has: a limited-quantity coupon must not over-redeem under
// concurrency. A campaign capped at 100 that redeems 137 times because a
// thousand people checked out at once is the identical class of bug as a
// double-sold seat, and it gets the identical treatment — a conditional UPDATE
// whose rowcount is the verdict, never a SELECT followed by an INSERT.
//
// Everything a discount does to money goes through the ledger as Promotional
// Expense. A discount that only exists as a smaller number on an invoice is a
// discount nobody can account for.
package promo

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNoSuchCode   = errors.New("promo: that code is not valid")
	ErrExpired      = errors.New("promo: that offer has ended")
	ErrTooSmall     = errors.New("promo: the fare is below this offer's minimum")
	ErrExhausted    = errors.New("promo: this offer has been fully claimed")
	ErrPerUserLimit = errors.New("promo: you have already used this offer")
	ErrNotEligible  = errors.New("promo: this offer does not apply to that booking")
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Context is what a campaign's eligibility rules are evaluated against.
type Context struct {
	UserKey      string
	AmountPoisha int64
	OperatorID   string
	RouteID      string
	Channel      string
	Provider     string
	NewUser      bool
}

type Quote struct {
	CampaignID     string `json:"campaign_id"`
	Code           string `json:"code"`
	Title          string `json:"title"`
	DiscountPoisha int64  `json:"discount_poisha"`
	Remaining      *int   `json:"remaining,omitempty"`
}

type campaign struct {
	id, code, title, kind        string
	pct                          int
	flat, maxDiscount, minAmount int64
	operatorID, routeID          *string
	channel, provider            *string
	maxRedemptions               *int
	redeemed, perUserLimit       int
	startsAt                     time.Time
	endsAt                       *time.Time
	active                       bool
}

func (s *Store) load(ctx context.Context, code string) (*campaign, error) {
	var c campaign
	err := s.pool.QueryRow(ctx, `
		SELECT campaign_id::text, COALESCE(code,''), title, kind, discount_pct,
		       discount_poisha, max_discount_poisha, min_amount_poisha,
		       operator_id::text, route_id::text, channel, payment_provider,
		       max_redemptions, redeemed, per_user_limit, starts_at, ends_at, active
		  FROM promo.campaigns WHERE upper(code) = upper($1)`, strings.TrimSpace(code)).
		Scan(&c.id, &c.code, &c.title, &c.kind, &c.pct, &c.flat, &c.maxDiscount, &c.minAmount,
			&c.operatorID, &c.routeID, &c.channel, &c.provider,
			&c.maxRedemptions, &c.redeemed, &c.perUserLimit, &c.startsAt, &c.endsAt, &c.active)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSuchCode
	}
	return &c, err
}

func (c *campaign) discountFor(amount int64) int64 {
	d := c.flat
	if c.pct > 0 {
		d += amount * int64(c.pct) / 100
	}
	if c.maxDiscount > 0 && d > c.maxDiscount {
		d = c.maxDiscount
	}
	if d > amount {
		d = amount
	}
	return d
}

func (c *campaign) eligible(cx Context) error {
	if !c.active {
		return ErrNoSuchCode
	}
	now := time.Now()
	if now.Before(c.startsAt) || (c.endsAt != nil && now.After(*c.endsAt)) {
		return ErrExpired
	}
	if cx.AmountPoisha < c.minAmount {
		return ErrTooSmall
	}
	if c.operatorID != nil && *c.operatorID != cx.OperatorID {
		return ErrNotEligible
	}
	if c.routeID != nil && *c.routeID != cx.RouteID {
		return ErrNotEligible
	}
	if c.channel != nil && *c.channel != cx.Channel {
		return ErrNotEligible
	}
	if c.provider != nil && !strings.EqualFold(*c.provider, cx.Provider) {
		return ErrNotEligible
	}
	if c.kind == "NEW_USER" && !cx.NewUser {
		return ErrNotEligible
	}
	if c.maxRedemptions != nil && c.redeemed >= *c.maxRedemptions {
		return ErrExhausted
	}
	return nil
}

// Preview prices a code without claiming it. The checkout page uses this; it
// deliberately reserves nothing, because a passenger typing a code into a box
// has not committed to anything yet.
func (s *Store) Preview(ctx context.Context, code string, cx Context) (*Quote, error) {
	c, err := s.load(ctx, code)
	if err != nil {
		return nil, err
	}
	if err := c.eligible(cx); err != nil {
		return nil, err
	}
	q := &Quote{CampaignID: c.id, Code: c.code, Title: c.title, DiscountPoisha: c.discountFor(cx.AmountPoisha)}
	if c.maxRedemptions != nil {
		left := *c.maxRedemptions - c.redeemed
		q.Remaining = &left
	}
	return q, nil
}

// Claim takes the redemption for real. Both counters — the campaign's cap and
// this user's allowance — move under conditions, inside one transaction, so a
// thousand simultaneous checkouts against a cap of 100 produce exactly 100
// redemptions and 900 clean refusals.
func (s *Store) Claim(ctx context.Context, code, bookingID string, cx Context) (*Quote, error) {
	c, err := s.load(ctx, code)
	if err != nil {
		return nil, err
	}
	if err := c.eligible(cx); err != nil {
		return nil, err
	}
	discount := c.discountFor(cx.AmountPoisha)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var used int
	err = tx.QueryRow(ctx, `
		INSERT INTO promo.user_usage (campaign_id, user_key, used) VALUES ($1::uuid, $2, 1)
		ON CONFLICT (campaign_id, user_key) DO UPDATE
		   SET used = promo.user_usage.used + 1
		 WHERE promo.user_usage.used < $3
		RETURNING used`, c.id, cx.UserKey, c.perUserLimit).Scan(&used)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPerUserLimit
	}
	if err != nil {
		return nil, err
	}

	ct, err := tx.Exec(ctx, `
		UPDATE promo.campaigns SET redeemed = redeemed + 1
		 WHERE campaign_id = $1::uuid AND active
		   AND (max_redemptions IS NULL OR redeemed < max_redemptions)
		   AND now() >= starts_at AND (ends_at IS NULL OR now() <= ends_at)`, c.id)
	if err != nil {
		return nil, err
	}
	if ct.RowsAffected() != 1 {
		return nil, ErrExhausted
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO promo.redemptions (campaign_id, booking_id, user_key, discount_poisha)
		VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4)
		ON CONFLICT (campaign_id, booking_id) DO NOTHING`,
		c.id, bookingID, cx.UserKey, discount); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO commerce.outbox (aggregate_id, event_type, payload)
		VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), 'promotion.redeemed',
		        jsonb_build_object('code', $2::text, 'discount_poisha', $3::bigint,
		                           'booking_id', $1::text))`,
		bookingID, c.code, discount); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	q := &Quote{CampaignID: c.id, Code: c.code, Title: c.title, DiscountPoisha: discount}
	if c.maxRedemptions != nil {
		left := *c.maxRedemptions - c.redeemed - 1
		q.Remaining = &left
	}
	return q, nil
}

// Release gives a redemption back when the booking it was claimed for never
// completed. Without it a cancelled checkout would quietly burn a coupon.
func (s *Store) Release(ctx context.Context, bookingID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		DELETE FROM promo.redemptions WHERE booking_id = $1::uuid
		RETURNING campaign_id::text, user_key`, bookingID)
	if err != nil {
		return err
	}
	type row struct{ campaign, user string }
	var freed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.campaign, &r.user); err != nil {
			rows.Close()
			return err
		}
		freed = append(freed, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, r := range freed {
		if _, err := tx.Exec(ctx,
			`UPDATE promo.campaigns SET redeemed = GREATEST(redeemed - 1, 0) WHERE campaign_id = $1::uuid`,
			r.campaign); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE promo.user_usage SET used = GREATEST(used - 1, 0)
			  WHERE campaign_id = $1::uuid AND user_key = $2`, r.campaign, r.user); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------- listing --

type Offer struct {
	Code  string `json:"code"`
	Title string `json:"title"`
	// Campaign copy in Bangla, empty when a campaign was created without it.
	// The reader's side decides which to show; the server does not guess a
	// language from a request it may be serving to a cache.
	TitleBn           string     `json:"title_bn,omitempty"`
	Kind              string     `json:"kind"`
	DiscountPct       int        `json:"discount_pct"`
	DiscountPoisha    int64      `json:"discount_poisha"`
	MaxDiscountPoisha int64      `json:"max_discount_poisha"`
	MinAmountPoisha   int64      `json:"min_amount_poisha"`
	Remaining         *int       `json:"remaining"`
	Redeemed          int        `json:"redeemed"`
	EndsAt            *time.Time `json:"ends_at"`
}

func (s *Store) Offers(ctx context.Context) ([]Offer, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(code,''), title, COALESCE(title_bn,''), kind, discount_pct, discount_poisha,
		       max_discount_poisha, min_amount_poisha,
		       CASE WHEN max_redemptions IS NULL THEN NULL ELSE max_redemptions - redeemed END,
		       redeemed, ends_at
		  FROM promo.campaigns
		 WHERE active AND (ends_at IS NULL OR ends_at > now())
		 ORDER BY min_amount_poisha, title`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Offer{}
	for rows.Next() {
		var o Offer
		if err := rows.Scan(&o.Code, &o.Title, &o.TitleBn, &o.Kind, &o.DiscountPct, &o.DiscountPoisha,
			&o.MaxDiscountPoisha, &o.MinAmountPoisha, &o.Remaining, &o.Redeemed, &o.EndsAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// -------------------------------------------------------------- referrals --

type Referral struct {
	Code         string     `json:"code"`
	ReferrerKey  string     `json:"referrer"`
	InviteeKey   string     `json:"invitee,omitempty"`
	Status       string     `json:"status"`
	RewardPoisha int64      `json:"reward_poisha"`
	RewardCode   string     `json:"reward_code,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	RewardedAt   *time.Time `json:"rewarded_at"`
}

// Invite mints (or returns) a referral code for one passenger.
func (s *Store) Invite(ctx context.Context, referrerKey string) (Referral, error) {
	var r Referral
	err := s.pool.QueryRow(ctx, `
		SELECT code, referrer_key, COALESCE(invitee_key,''), status, reward_poisha,
		       COALESCE(reward_code,''), created_at, rewarded_at
		  FROM promo.referrals
		 WHERE referrer_key = $1 AND status = 'INVITED' LIMIT 1`, referrerKey).
		Scan(&r.Code, &r.ReferrerKey, &r.InviteeKey, &r.Status, &r.RewardPoisha,
			&r.RewardCode, &r.CreatedAt, &r.RewardedAt)
	if err == nil {
		return r, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return r, err
	}
	code, err := shortCode(8)
	if err != nil {
		return r, err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO promo.referrals (code, referrer_key) VALUES ($1, $2)
		RETURNING code, referrer_key, COALESCE(invitee_key,''), status, reward_poisha,
		          COALESCE(reward_code,''), created_at, rewarded_at`, code, referrerKey).
		Scan(&r.Code, &r.ReferrerKey, &r.InviteeKey, &r.Status, &r.RewardPoisha,
			&r.RewardCode, &r.CreatedAt, &r.RewardedAt)
	return r, err
}

// Accept records that an invitee signed up under a code. A referral cannot be
// accepted twice, and nobody can refer themselves.
func (s *Store) Accept(ctx context.Context, code, inviteeKey string) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE promo.referrals SET invitee_key = $2, status = 'REGISTERED'
		 WHERE upper(code) = upper($1) AND status = 'INVITED' AND referrer_key <> $2`,
		code, inviteeKey)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return errors.New("promo: that referral code cannot be accepted")
	}
	return nil
}

// Qualify fires when the invitee completes a paid booking. The reward is a
// coupon issued to the referrer, created as a real campaign row so it redeems
// through exactly the same path — and lands in the ledger — as any other offer.
func (s *Store) Qualify(ctx context.Context, inviteeKey, bookingID string) (*Referral, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var referralID, referrer string
	var reward int64
	err = tx.QueryRow(ctx, `
		UPDATE promo.referrals SET status = 'QUALIFIED', qualified_at = now(),
		       qualifying_booking_id = NULLIF($2,'')::uuid
		 WHERE invitee_key = $1 AND status = 'REGISTERED'
		 RETURNING referral_id::text, referrer_key, reward_poisha`, inviteeKey, bookingID).
		Scan(&referralID, &referrer, &reward)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil // no referral in flight; not an error
	}
	if err != nil {
		return nil, err
	}

	rewardCode, err := shortCode(6)
	if err != nil {
		return nil, err
	}
	rewardCode = "REF" + rewardCode
	if _, err := tx.Exec(ctx, `
		INSERT INTO promo.campaigns
			(code, title, kind, discount_poisha, max_discount_poisha, min_amount_poisha,
			 max_redemptions, per_user_limit, ends_at)
		VALUES ($1, 'Referral reward', 'REFERRAL', $2, $2, 0, 1, 1, now() + interval '180 days')`,
		rewardCode, reward); err != nil {
		return nil, err
	}
	var r Referral
	if err := tx.QueryRow(ctx, `
		UPDATE promo.referrals SET status = 'REWARDED', reward_code = $2, rewarded_at = now()
		 WHERE referral_id = $1::uuid
		 RETURNING code, referrer_key, COALESCE(invitee_key,''), status, reward_poisha,
		           COALESCE(reward_code,''), created_at, rewarded_at`, referralID, rewardCode).
		Scan(&r.Code, &r.ReferrerKey, &r.InviteeKey, &r.Status, &r.RewardPoisha,
			&r.RewardCode, &r.CreatedAt, &r.RewardedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) Referrals(ctx context.Context, referrerKey string) ([]Referral, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT code, referrer_key, COALESCE(invitee_key,''), status, reward_poisha,
		       COALESCE(reward_code,''), created_at, rewarded_at
		  FROM promo.referrals
		 WHERE ($1 = '' OR referrer_key = $1)
		 ORDER BY created_at DESC LIMIT 100`, referrerKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Referral{}
	for rows.Next() {
		var r Referral
		if err := rows.Scan(&r.Code, &r.ReferrerKey, &r.InviteeKey, &r.Status,
			&r.RewardPoisha, &r.RewardCode, &r.CreatedAt, &r.RewardedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func shortCode(n int) (string, error) {
	const alphabet = "ACDEFGHJKLMNPQRTUVWXY3479"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out), nil
}

// PostingsFor returns the ledger lines a discount produces. A promotion is an
// expense the platform carries, not a smaller number typed onto an invoice.
func PostingsFor(discountPoisha int64) string {
	return fmt.Sprintf("DR 5201 Promotional Expense %d / CR 4101 Platform Revenue %d",
		discountPoisha, discountPoisha)
}

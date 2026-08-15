// Package identity is passenger authentication (plan workstream P1-C).
//
// Staff authentication already exists in services/staff and is deliberately
// stricter. This is the passenger half: phone plus a one-time code, an optional
// password, guest checkout that can be promoted into a real account, rotating
// refresh tokens with reuse detection, and device/session management.
//
// Two rules shape everything here:
//
//   - The OTP code is never stored, only its hash, and neither is a session
//     token. A dump of these tables lets nobody sign in as anybody.
//   - Rate limiting is enforced against PostgreSQL, which is the authority. A
//     Redis counter in front of it makes the common case fast; losing Redis
//     costs latency and never correctness.
package identity

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	iterations = 210_000
	otpTTL     = 5 * time.Minute
	accessTTL  = 30 * time.Minute
	refreshTTL = 30 * 24 * time.Hour
)

// The OTP limits. Five codes an hour to one number is right for a live service
// and wrong for a test harness that signs in repeatedly, so they are tunable —
// but they are tunable UP from a safe default, never off. A zero or negative
// value is ignored.
var (
	otpPerPhone = envInt("OTP_PER_PHONE_PER_HOUR", 5)
	otpPerIP    = envInt("OTP_PER_IP_PER_HOUR", 20)
)

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

var (
	ErrRateLimited   = errors.New("identity: too many codes requested")
	ErrBadCode       = errors.New("identity: wrong or expired code")
	ErrNoSuchUser    = errors.New("identity: no account for those details")
	ErrBadPassword   = errors.New("identity: wrong password")
	ErrUnauthorised  = errors.New("identity: not signed in")
	ErrTokenReplayed = errors.New("identity: refresh token replayed")
)

// Limiter is the fast path for rate limiting. Redis satisfies it; a nil Limiter
// simply means every check falls through to PostgreSQL.
type Limiter interface {
	// Allow returns false when key has already been used limit times in window.
	Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error)
}

// Courier sends the code. In practice this is the notification platform; the
// interface keeps identity from importing it and from knowing about templates.
type Courier interface {
	SendOTP(ctx context.Context, phone, code, lang string) error
}

type Service struct {
	pool    *pgxpool.Pool
	limiter Limiter
	courier Courier
}

func New(pool *pgxpool.Pool, limiter Limiter, courier Courier) *Service {
	return &Service{pool: pool, limiter: limiter, courier: courier}
}

// Identity is a signed-in passenger.
type Identity struct {
	UserID    string `json:"user_id"`
	Phone     string `json:"phone"`
	Email     string `json:"email,omitempty"`
	Name      string `json:"display_name,omitempty"`
	IsGuest   bool   `json:"is_guest"`
	SessionID string `json:"-"`
}

// Tokens is what a successful sign-in hands back.
type Tokens struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	Identity     Identity  `json:"identity"`
}

// ---------------------------------------------------------------- OTP flow --

// RequestOTP mints a code, stores only its hash, and hands it to the courier.
//
// The returned code is non-empty only when SHOW_OTP is on, which the local
// harness uses so a browser test can sign in without an SMS gateway. It is
// never returned when the courier succeeded in a real deployment.
func (s *Service) RequestOTP(ctx context.Context, phone, ip, lang string, reveal bool) (string, error) {
	phone = NormalisePhone(phone)
	if len(phone) < 11 {
		return "", fmt.Errorf("identity: %q is not a Bangladeshi mobile number", phone)
	}
	if err := s.checkRate(ctx, rateKey("otp:phone:"+phone, otpPerPhone), otpPerPhone, phone, "phone"); err != nil {
		return "", err
	}
	if ip != "" {
		if err := s.checkRate(ctx, rateKey("otp:ip:"+ip, otpPerIP), otpPerIP, ip, "ip"); err != nil {
			return "", err
		}
	}

	code, err := numericCode(6)
	if err != nil {
		return "", err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO identity.otp_challenges (phone, code_hash, ip, expires_at)
		VALUES ($1, $2, NULLIF($3,'')::inet, now() + $4::interval)`,
		phone, hashToken(code), ip, otpTTL.String()); err != nil {
		return "", err
	}
	if s.courier != nil {
		if err := s.courier.SendOTP(ctx, phone, code, lang); err != nil {
			// The challenge stays valid: an SMS that failed to send is a delivery
			// problem, and the passenger may still have an earlier code in hand.
			return "", fmt.Errorf("identity: could not send the code: %w", err)
		}
	}
	if reveal {
		return code, nil
	}
	return "", nil
}

// rateKey folds the configured limit into the cache key.
//
// Without this, raising a limit would leave the old counter in place with an
// hour still to run and the new limit would not take effect until it expired —
// which is a confusing way to discover that a cache is holding policy.
func rateKey(prefix string, limit int) string {
	return prefix + ":" + strconv.Itoa(limit)
}

// checkRate asks Redis first and PostgreSQL always. The fast path can be wrong
// in the cheap direction (a cache miss costs a query); it cannot let more codes
// through than the database says are allowed.
//
// The asymmetry is deliberate. Redis can refuse EARLIER than the database
// would, which under a flood is the point: the rejections stop costing queries.
// It can never let one through that the database would refuse, because the
// database is checked on every request that gets past it.
func (s *Service) checkRate(ctx context.Context, key string, limit int, value, column string) error {
	if s.limiter != nil {
		ok, err := s.limiter.Allow(ctx, key, limit, time.Hour)
		if err == nil && !ok {
			return ErrRateLimited
		}
	}
	var n int
	q := `SELECT count(*) FROM identity.otp_challenges
	       WHERE created_at > now() - interval '1 hour' AND phone = $1`
	if column == "ip" {
		q = `SELECT count(*) FROM identity.otp_challenges
		      WHERE created_at > now() - interval '1 hour' AND ip = $1::inet`
	}
	if err := s.pool.QueryRow(ctx, q, value).Scan(&n); err != nil {
		return err
	}
	if n >= limit {
		return ErrRateLimited
	}
	return nil
}

// VerifyOTP consumes a code and signs the passenger in, creating the account on
// first use. A wrong code burns an attempt; five wrong attempts kill the
// challenge rather than the phone number, so nobody can lock a stranger out by
// guessing at their number.
func (s *Service) VerifyOTP(ctx context.Context, phone, code, device, ip string) (*Tokens, error) {
	phone = NormalisePhone(phone)

	var challengeID string
	var attempts, maxAttempts int
	var storedHash string
	err := s.pool.QueryRow(ctx, `
		SELECT challenge_id::text, code_hash, attempts, max_attempts
		  FROM identity.otp_challenges
		 WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC LIMIT 1`, phone).
		Scan(&challengeID, &storedHash, &attempts, &maxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrBadCode
	}
	if err != nil {
		return nil, err
	}
	if attempts >= maxAttempts {
		return nil, ErrBadCode
	}
	if !hmac.Equal([]byte(storedHash), []byte(hashToken(code))) {
		_, _ = s.pool.Exec(ctx,
			`UPDATE identity.otp_challenges SET attempts = attempts + 1 WHERE challenge_id = $1::uuid`,
			challengeID)
		return nil, ErrBadCode
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE identity.otp_challenges SET consumed_at = now() WHERE challenge_id = $1::uuid`,
		challengeID); err != nil {
		return nil, err
	}

	userID, err := s.upsertUser(ctx, phone)
	if err != nil {
		return nil, err
	}
	return s.issue(ctx, userID, device, ip)
}

func (s *Service) upsertUser(ctx context.Context, phone string) (string, error) {
	var userID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO catalog.users (phone, is_guest) VALUES ($1, false)
		ON CONFLICT (phone) DO UPDATE SET is_guest = false
		RETURNING user_id::text`, phone).Scan(&userID)
	return userID, err
}

// ----------------------------------------------------------------- password --

func (s *Service) SetPassword(ctx context.Context, userID, password string) error {
	if len(password) < 8 {
		return errors.New("identity: a password needs at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO identity.credentials (user_id, password_hash, password_salt, iterations)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE
		   SET password_hash = EXCLUDED.password_hash,
		       password_salt = EXCLUDED.password_salt,
		       iterations    = EXCLUDED.iterations,
		       updated_at    = now()`,
		userID, hex.EncodeToString(hash), hex.EncodeToString(salt), iterations)
	return err
}

// LoginPassword accepts either a phone number or an email address.
//
// It spends the same PBKDF2 work whether or not the account exists, so response
// time cannot be used to enumerate which phone numbers have accounts.
func (s *Service) LoginPassword(ctx context.Context, login, password, device, ip string) (*Tokens, error) {
	ident := strings.TrimSpace(login)
	var userID, storedHash, salt string
	var iters int
	err := s.pool.QueryRow(ctx, `
		SELECT u.user_id::text, c.password_hash, c.password_salt, c.iterations
		  FROM catalog.users u
		  JOIN identity.credentials c ON c.user_id = u.user_id
		 WHERE u.phone = $1 OR lower(u.email) = lower($2)`,
		NormalisePhone(ident), ident).Scan(&userID, &storedHash, &salt, &iters)
	if errors.Is(err, pgx.ErrNoRows) {
		decoy, _ := hex.DecodeString(strings.Repeat("ab", 16))
		_, _ = pbkdf2.Key(sha256.New, password, decoy, iterations, 32)
		return nil, ErrNoSuchUser
	}
	if err != nil {
		return nil, err
	}
	saltBytes, err := hex.DecodeString(salt)
	if err != nil {
		return nil, err
	}
	got, err := pbkdf2.Key(sha256.New, password, saltBytes, iters, 32)
	if err != nil {
		return nil, err
	}
	if !hmac.Equal([]byte(hex.EncodeToString(got)), []byte(storedHash)) {
		return nil, ErrBadPassword
	}
	return s.issue(ctx, userID, device, ip)
}

// ------------------------------------------------------------------ tokens --

func (s *Service) issue(ctx context.Context, userID, device, ip string) (*Tokens, error) {
	access, err := randomToken()
	if err != nil {
		return nil, err
	}
	refresh, err := randomToken()
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var sessionID string
	var expires time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO identity.sessions (user_id, token_hash, device, ip, expires_at)
		VALUES ($1::uuid, $2, NULLIF($3,''), NULLIF($4,'')::inet, now() + $5::interval)
		RETURNING session_id::text, expires_at`,
		userID, hashToken(access), device, ip, accessTTL.String()).Scan(&sessionID, &expires); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO identity.refresh_tokens (token_hash, family_id, user_id, session_id, expires_at)
		VALUES ($1, gen_random_uuid(), $2::uuid, $3::uuid, now() + $4::interval)`,
		hashToken(refresh), userID, sessionID, refreshTTL.String()); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	id, err := s.load(ctx, userID)
	if err != nil {
		return nil, err
	}
	id.SessionID = sessionID
	return &Tokens{AccessToken: access, RefreshToken: refresh, ExpiresAt: expires, Identity: *id}, nil
}

// Refresh rotates a refresh token.
//
// The interesting case is the second use of a token that has already been
// rotated. That means somebody else has a copy, so the whole family is revoked
// — every session descended from that original sign-in — rather than just
// declining the request and leaving the thief with a working token.
func (s *Service) Refresh(ctx context.Context, refresh, device, ip string) (*Tokens, error) {
	h := hashToken(refresh)

	var familyID, userID string
	var used, revoked *time.Time
	var expires time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT family_id::text, user_id::text, used_at, revoked_at, expires_at
		  FROM identity.refresh_tokens WHERE token_hash = $1`, h).
		Scan(&familyID, &userID, &used, &revoked, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnauthorised
	}
	if err != nil {
		return nil, err
	}
	if used != nil {
		if _, err := s.pool.Exec(ctx, `
			UPDATE identity.refresh_tokens
			   SET revoked_at = now(), revoke_reason = 'token reuse detected'
			 WHERE family_id = $1::uuid AND revoked_at IS NULL`, familyID); err != nil {
			return nil, err
		}
		_, _ = s.pool.Exec(ctx, `
			UPDATE identity.sessions SET revoked_at = now()
			 WHERE session_id IN (SELECT session_id FROM identity.refresh_tokens
			                       WHERE family_id = $1::uuid AND session_id IS NOT NULL)
			   AND revoked_at IS NULL`, familyID)
		return nil, ErrTokenReplayed
	}
	if revoked != nil || expires.Before(time.Now()) {
		return nil, ErrUnauthorised
	}

	access, err := randomToken()
	if err != nil {
		return nil, err
	}
	next, err := randomToken()
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Mark used only if it is still unused — two concurrent refreshes with the
	// same token must not both succeed.
	ct, err := tx.Exec(ctx,
		`UPDATE identity.refresh_tokens SET used_at = now()
		  WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL`, h)
	if err != nil {
		return nil, err
	}
	if ct.RowsAffected() != 1 {
		return nil, ErrUnauthorised
	}

	var sessionID string
	var accessExpires time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO identity.sessions (user_id, token_hash, device, ip, expires_at)
		VALUES ($1::uuid, $2, NULLIF($3,''), NULLIF($4,'')::inet, now() + $5::interval)
		RETURNING session_id::text, expires_at`,
		userID, hashToken(access), device, ip, accessTTL.String()).Scan(&sessionID, &accessExpires); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO identity.refresh_tokens (token_hash, family_id, user_id, session_id, expires_at)
		VALUES ($1, $2::uuid, $3::uuid, $4::uuid, now() + $5::interval)`,
		hashToken(next), familyID, userID, sessionID, refreshTTL.String()); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	id, err := s.load(ctx, userID)
	if err != nil {
		return nil, err
	}
	id.SessionID = sessionID
	return &Tokens{AccessToken: access, RefreshToken: next, ExpiresAt: accessExpires, Identity: *id}, nil
}

// Authenticate resolves a bearer token to a passenger.
func (s *Service) Authenticate(ctx context.Context, token string) (*Identity, error) {
	if token == "" {
		return nil, ErrUnauthorised
	}
	var id Identity
	var email, name *string
	err := s.pool.QueryRow(ctx, `
		UPDATE identity.sessions SET last_seen_at = now()
		 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
		 RETURNING session_id::text, user_id::text`, hashToken(token)).
		Scan(&id.SessionID, &id.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnauthorised
	}
	if err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(phone,''), email, display_name, is_guest
		  FROM catalog.users WHERE user_id = $1::uuid`, id.UserID).
		Scan(&id.Phone, &email, &name, &id.IsGuest); err != nil {
		return nil, err
	}
	if email != nil {
		id.Email = *email
	}
	if name != nil {
		id.Name = *name
	}
	return &id, nil
}

func (s *Service) load(ctx context.Context, userID string) (*Identity, error) {
	var id Identity
	var email, name *string
	id.UserID = userID
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(phone,''), email, display_name, is_guest
		  FROM catalog.users WHERE user_id = $1::uuid`, userID).
		Scan(&id.Phone, &email, &name, &id.IsGuest); err != nil {
		return nil, err
	}
	if email != nil {
		id.Email = *email
	}
	if name != nil {
		id.Name = *name
	}
	return &id, nil
}

// Logout revokes one session. SignOutEverywhere revokes all of them plus every
// refresh family, which is what a passenger who lost a phone actually wants.
func (s *Service) Logout(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE identity.sessions SET revoked_at = now()
		  WHERE token_hash = $1 AND revoked_at IS NULL`, hashToken(token))
	return err
}

func (s *Service) SignOutEverywhere(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx,
		`UPDATE identity.sessions SET revoked_at = now()
		  WHERE user_id = $1::uuid AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE identity.refresh_tokens SET revoked_at = now(), revoke_reason = 'signed out everywhere'
		  WHERE user_id = $1::uuid AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type Session struct {
	SessionID  string    `json:"session_id"`
	Device     string    `json:"device"`
	IP         string    `json:"ip,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	Current    bool      `json:"current"`
}

func (s *Service) Sessions(ctx context.Context, userID, currentSession string) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id::text, COALESCE(device,'unknown device'), COALESCE(host(ip),''),
		       created_at, last_seen_at
		  FROM identity.sessions
		 WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY last_seen_at DESC LIMIT 25`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var v Session
		if err := rows.Scan(&v.SessionID, &v.Device, &v.IP, &v.CreatedAt, &v.LastSeenAt); err != nil {
			return nil, err
		}
		v.Current = v.SessionID == currentSession
		out = append(out, v)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------- guest checkout --

// Guest creates (or finds) the throwaway account a checkout without sign-in
// runs under. It is a real row from the start, so the booking has an owner and
// can be promoted later without rewriting history.
func (s *Service) Guest(ctx context.Context, phone, email, name string) (string, error) {
	phone = NormalisePhone(phone)
	var userID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO catalog.users (phone, email, display_name, is_guest)
		VALUES ($1, NULLIF($2,''), NULLIF($3,''), true)
		ON CONFLICT (phone) DO UPDATE
		   SET display_name = COALESCE(catalog.users.display_name, EXCLUDED.display_name)
		RETURNING user_id::text`, phone, email, name).Scan(&userID)
	return userID, err
}

// Promote attaches the bookings a guest made to the account they have now
// signed into. The guest row is kept and the link recorded, so support can
// still explain where an old booking came from.
func (s *Service) Promote(ctx context.Context, userID, phone string) (int, error) {
	phone = NormalisePhone(phone)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var guestID string
	err = tx.QueryRow(ctx, `
		SELECT user_id::text FROM catalog.users
		 WHERE phone = $1 AND is_guest AND user_id <> $2::uuid`, phone, userID).Scan(&guestID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The common case: the guest row IS this account, already un-guested by
		// the OTP sign-in. Claim its bookings by contact phone instead.
		ct, err := tx.Exec(ctx, `
			UPDATE commerce.bookings b SET user_id = $1::uuid
			  FROM commerce.booking_contacts c
			 WHERE c.booking_id = b.booking_id AND c.phone = $2 AND b.user_id IS NULL`, userID, phone)
		if err != nil {
			return 0, err
		}
		if err := tx.Commit(ctx); err != nil {
			return 0, err
		}
		return int(ct.RowsAffected()), nil
	}
	if err != nil {
		return 0, err
	}

	ct, err := tx.Exec(ctx,
		`UPDATE commerce.bookings SET user_id = $1::uuid WHERE user_id = $2::uuid`, userID, guestID)
	if err != nil {
		return 0, err
	}
	moved := int(ct.RowsAffected())
	if _, err := tx.Exec(ctx, `
		INSERT INTO identity.guest_promotions (guest_user_id, user_id, bookings_moved)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (guest_user_id) DO UPDATE SET bookings_moved = EXCLUDED.bookings_moved`,
		guestID, userID, moved); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return moved, nil
}

// UpdateProfile lets a passenger set a name and an email on their account.
func (s *Service) UpdateProfile(ctx context.Context, userID, name, email string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE catalog.users
		   SET display_name = COALESCE(NULLIF($2,''), display_name),
		       email        = COALESCE(NULLIF($3,''), email)
		 WHERE user_id = $1::uuid`, userID, name, email)
	return err
}

// ----------------------------------------------------------------- helpers --

// NormalisePhone turns everything a Bangladeshi passenger might type into one
// canonical +8801XXXXXXXXX form, so one person is one account.
func NormalisePhone(in string) string {
	var digits []rune
	for _, r := range in {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	d := string(digits)
	switch {
	case strings.HasPrefix(d, "880") && len(d) == 13:
		return "+" + d
	case strings.HasPrefix(d, "0") && len(d) == 11:
		return "+880" + d[1:]
	case len(d) == 10 && strings.HasPrefix(d, "1"):
		return "+880" + d
	}
	if d == "" {
		return ""
	}
	return "+" + d
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func numericCode(n int) (string, error) {
	out := make([]byte, n)
	for i := range out {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + v.Int64())
	}
	return string(out), nil
}

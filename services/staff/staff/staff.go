// Package staff is authentication and authorisation for everyone who works
// here: platform admins, operator staff, counter clerks, agents, drivers.
//
// Two rules shape this package.
//
// Roles are data. There is no `if role == "ADMIN"` anywhere in the platform.
// A permission is a string of the form resource.action, roles are rows, and
// role_permissions is a join table — so creating "Regional Supervisor" with
// exactly the rights it needs is an INSERT, not a deploy.
//
// The session token is never stored. Only its SHA-256 hash reaches the
// database, so a stolen dump does not hand the reader a working session.
package staff

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrBadCredentials = errors.New("staff: email or password is wrong")
	ErrSuspended      = errors.New("staff: account is not active")
	ErrNoSession      = errors.New("staff: session is missing, expired or revoked")
	ErrForbidden      = errors.New("staff: permission denied")
)

const (
	sessionTTL      = 12 * time.Hour // one working day, then log in again
	hashIter        = 210000
	hashKeyLen      = 32
	lockoutAfter    = 8
	lockoutCooldown = 15 * time.Minute // a lock lifts itself after this quiet window
)

// Identity is who the caller is and what they may do. It is assembled once per
// request from the session token and passed down; no handler re-queries roles.
type Identity struct {
	StaffID    string   `json:"staff_id"`
	Email      string   `json:"email"`
	FullName   string   `json:"full_name"`
	Phone      string   `json:"phone,omitempty"`
	OperatorID string   `json:"operator_id,omitempty"`
	CounterID  string   `json:"counter_id,omitempty"`
	AgencyID   string   `json:"agency_id,omitempty"`
	Roles      []string `json:"roles"`
	Perms      []string `json:"permissions"`

	perms map[string]struct{}
}

// Can is the only authorisation question the rest of the platform asks.
func (i *Identity) Can(perm string) bool {
	if i == nil {
		return false
	}
	_, ok := i.perms[perm]
	return ok
}

// IsPlatform reports whether this identity sees across operators. Operator
// staff have an operator_id and every query they make is filtered by it.
func (i *Identity) IsPlatform() bool { return i != nil && i.OperatorID == "" && i.AgencyID == "" }

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ------------------------------------------------------------------- login --

// Login verifies a password and issues a bearer token.
//
// The password comparison is constant-time and runs even when the account does
// not exist, so response timing does not disclose which emails are registered.
func (s *Service) Login(ctx context.Context, email, password, ip, ua string) (string, *Identity, error) {
	return s.LoginWithCode(ctx, email, password, "", ip, ua)
}

// LoginWithCode is Login plus the second factor. The password is checked first
// and identically either way, so a wrong password and a missing code cannot be
// told apart by timing — but they ARE told apart in the response, because a
// person who typed their password correctly needs to know it was the code that
// was missing.
func (s *Service) LoginWithCode(ctx context.Context, email, password, totp, ip, ua string) (string, *Identity, error) {
	email = strings.ToLower(strings.TrimSpace(email))

	var staffID, storedHash, salt, status string
	var iter, failed int
	var lockedAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT staff_id::text, password_hash, password_salt, password_iter, status, failed_logins, locked_at
		  FROM staff.staff_users WHERE lower(email) = $1`, email).
		Scan(&staffID, &storedHash, &salt, &iter, &status, &failed, &lockedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Spend the same work an existing account would, then fail identically.
		_, _ = derive(password, "00000000000000000000000000000000", hashIter)
		return "", nil, ErrBadCredentials
	}
	if err != nil {
		return "", nil, err
	}

	// Lift a lock that has served its cooldown, so a locked-out clerk recovers on
	// their own after the quiet window instead of waiting for an administrator —
	// the guess limit still bites within the window, but it is no longer a
	// standing denial of service against anyone whose email is known.
	if status == "LOCKED" && lockedAt != nil && time.Since(*lockedAt) >= lockoutCooldown {
		if _, err := s.pool.Exec(ctx, `
			UPDATE staff.staff_users SET status='ACTIVE', failed_logins=0, locked_at=NULL
			 WHERE staff_id=$1::uuid AND status='LOCKED'`, staffID); err != nil {
			return "", nil, err
		}
		status, failed = "ACTIVE", 0
	}

	got, err := derive(password, salt, iter)
	if err != nil {
		return "", nil, err
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(storedHash)) != 1 {
		_, _ = s.pool.Exec(ctx, `
			UPDATE staff.staff_users
			   SET failed_logins = failed_logins + 1,
			       status = CASE WHEN failed_logins + 1 >= $2 AND status = 'ACTIVE'
			                     THEN 'LOCKED' ELSE status END,
			       locked_at = CASE WHEN failed_logins + 1 >= $2 AND status = 'ACTIVE'
			                        THEN now() ELSE locked_at END
			 WHERE staff_id = $1::uuid`, staffID, lockoutAfter)
		return "", nil, ErrBadCredentials
	}
	if status != "ACTIVE" {
		return "", nil, ErrSuspended
	}

	// The second factor, for accounts that have one.
	if err := s.checkSecondFactor(ctx, staffID, totp); err != nil {
		return "", nil, err
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO staff.sessions (staff_id, token_hash, expires_at, ip, user_agent)
		VALUES ($1::uuid, $2, now() + make_interval(secs => $3), NULLIF($4,'')::inet, $5)`,
		staffID, tokenHash(token), sessionTTL.Seconds(), ip, ua); err != nil {
		return "", nil, err
	}
	_, _ = s.pool.Exec(ctx,
		`UPDATE staff.staff_users SET failed_logins = 0, last_login_at = now() WHERE staff_id = $1::uuid`,
		staffID)

	id, err := s.load(ctx, staffID)
	if err != nil {
		return "", nil, err
	}
	s.Audit(ctx, id, "staff.login", "session", nil)
	return token, id, nil
}

// Authenticate resolves a bearer token to an identity, or fails closed.
func (s *Service) Authenticate(ctx context.Context, token string) (*Identity, error) {
	if token == "" {
		return nil, ErrNoSession
	}
	var staffID string
	err := s.pool.QueryRow(ctx, `
		SELECT staff_id::text FROM staff.sessions
		 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
		tokenHash(token)).Scan(&staffID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, err
	}
	return s.load(ctx, staffID)
}

func (s *Service) Logout(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE staff.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
		tokenHash(token))
	return err
}

// load assembles roles and the flattened permission set in one round trip.
func (s *Service) load(ctx context.Context, staffID string) (*Identity, error) {
	id := &Identity{StaffID: staffID, perms: map[string]struct{}{}}
	var operatorID, counterID, agencyID, phone *string
	if err := s.pool.QueryRow(ctx, `
		SELECT email, full_name, phone,
		       operator_id::text, counter_id::text, agency_id::text
		  FROM staff.staff_users WHERE staff_id = $1::uuid AND status = 'ACTIVE'`, staffID).
		Scan(&id.Email, &id.FullName, &phone, &operatorID, &counterID, &agencyID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSuspended
		}
		return nil, err
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	id.Phone, id.OperatorID, id.CounterID, id.AgencyID =
		deref(phone), deref(operatorID), deref(counterID), deref(agencyID)

	rows, err := s.pool.Query(ctx, `
		SELECT r.role_key, coalesce(p.permission, '')
		  FROM staff.user_roles ur
		  JOIN catalog.roles r ON r.role_id = ur.role_id
		  LEFT JOIN catalog.role_permissions p ON p.role_id = r.role_id
		 WHERE ur.staff_id = $1::uuid`, staffID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seenRole := map[string]bool{}
	for rows.Next() {
		var role, perm string
		if err := rows.Scan(&role, &perm); err != nil {
			return nil, err
		}
		if !seenRole[role] {
			seenRole[role] = true
			id.Roles = append(id.Roles, role)
		}
		if perm != "" {
			if _, dup := id.perms[perm]; !dup {
				id.perms[perm] = struct{}{}
				id.Perms = append(id.Perms, perm)
			}
		}
	}
	return id, rows.Err()
}

// ------------------------------------------------------------------- audit --

// Audit writes to the append-only log. UPDATE and DELETE are revoked on that
// table at the grant level, so this is a record, not a draft.
func (s *Service) Audit(ctx context.Context, id *Identity, action, resource string, after any) {
	var actor, role *string
	if id != nil {
		actor = &id.StaffID
		if len(id.Roles) > 0 {
			role = &id.Roles[0]
		}
	}
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO audit.audit_log (actor_id, actor_role, action, resource, after_val)
		VALUES ($1::uuid, $2, $3, $4, to_jsonb($5::text))`,
		actor, role, action, resource, describe(after))
}

func describe(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return ""
	}
}

// ------------------------------------------------------------------ hashing --

func derive(password, salt string, iter int) (string, error) {
	if iter <= 0 {
		iter = hashIter
	}
	key, err := pbkdf2.Key(sha256.New, password, []byte(salt), iter, hashKeyLen)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// NewPassword produces the (salt, hash, iterations) triple for a new password.
func NewPassword(password string) (salt, hash string, iter int, err error) {
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return "", "", 0, err
	}
	salt = hex.EncodeToString(b)
	hash, err = derive(password, salt, hashIter)
	return salt, hash, hashIter, err
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

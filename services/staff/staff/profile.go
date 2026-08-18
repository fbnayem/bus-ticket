package staff

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// What a member of staff can do to their own account.
//
// Passengers got all of this a release ago — edit your details, set a password,
// see where you are signed in, sign out everywhere. Staff never had any of it,
// which meant a conductor who thought somebody had their phone had no way to
// act on it except telephoning the office.

var ErrWeakPassword = errors.New("staff: that password is too short")

// UpdateProfile changes the things a person owns about themselves.
//
// Email is deliberately not here. It is the login identifier and it is issued
// by the operator; letting somebody change it from a phone on a bus is how an
// account quietly stops belonging to the person the operator hired.
func (s *Service) UpdateProfile(ctx context.Context, staffID, fullName, phone string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE staff.staff_users
		   SET full_name = COALESCE(NULLIF($2,''), full_name),
		       phone     = COALESCE(NULLIF($3,''), phone)
		 WHERE staff_id = $1::uuid`, staffID, fullName, phone)
	return err
}

// ChangePassword requires the current one.
//
// Not because the session is untrusted — it is authenticated — but because a
// phone left unlocked on a seat is the threat this actually defends against,
// and the current password is the one thing the person who put it down knows
// and the person who picked it up does not.
//
// Every other session is revoked on success. If the reason for changing a
// password is that somebody else has it, leaving their session alive would make
// the whole exercise decorative.
func (s *Service) ChangePassword(ctx context.Context, staffID, current, next, keepToken string) error {
	if len(next) < 8 {
		return ErrWeakPassword
	}
	var storedHash, salt string
	var iter int
	err := s.pool.QueryRow(ctx, `
		SELECT password_hash, password_salt, password_iter
		  FROM staff.staff_users WHERE staff_id = $1::uuid`, staffID).
		Scan(&storedHash, &salt, &iter)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBadCredentials
	}
	if err != nil {
		return err
	}
	got, err := derive(current, salt, iter)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(storedHash)) != 1 {
		return ErrBadCredentials
	}

	// A new salt with the new password. Reusing the old one would leak that the
	// password changed to anybody holding an old database dump.
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	newSalt := hex.EncodeToString(raw)
	newHash, err := derive(next, newSalt, hashIter)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE staff.staff_users
		   SET password_hash = $2, password_salt = $3, password_iter = $4, failed_logins = 0
		 WHERE staff_id = $1::uuid`, staffID, newHash, newSalt, hashIter); err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE staff.sessions SET revoked_at = now()
		 WHERE staff_id = $1::uuid AND revoked_at IS NULL AND token_hash <> $2`,
		staffID, tokenHash(keepToken))
	return err
}

// StaffSession is one place this account is signed in.
type StaffSession struct {
	SessionID string     `json:"session_id"`
	Current   bool       `json:"current"`
	IssuedAt  time.Time  `json:"issued_at"`
	ExpiresAt time.Time  `json:"expires_at"`
	IP        string     `json:"ip,omitempty"`
	UserAgent string     `json:"user_agent,omitempty"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
}

// Sessions lists where this account is signed in, marking the one asking.
//
// Marking the current session is the difference between a list somebody can act
// on and a list they are afraid to touch.
func (s *Service) Sessions(ctx context.Context, staffID, currentToken string) ([]StaffSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id::text, token_hash = $2, issued_at, expires_at,
		       COALESCE(host(ip),''), COALESCE(user_agent,''), revoked_at
		  FROM staff.sessions
		 WHERE staff_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY issued_at DESC LIMIT 20`, staffID, tokenHash(currentToken))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StaffSession{}
	for rows.Next() {
		var v StaffSession
		if err := rows.Scan(&v.SessionID, &v.Current, &v.IssuedAt, &v.ExpiresAt,
			&v.IP, &v.UserAgent, &v.RevokedAt); err != nil {
			continue
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// RevokeOtherSessions signs out everywhere except here.
//
// Everywhere-except-here rather than everywhere: somebody acting on a lost
// phone should not also lock themselves out of the device they are holding.
func (s *Service) RevokeOtherSessions(ctx context.Context, staffID, keepToken string) (int64, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE staff.sessions SET revoked_at = now()
		 WHERE staff_id = $1::uuid AND revoked_at IS NULL AND token_hash <> $2`,
		staffID, tokenHash(keepToken))
	if err != nil {
		return 0, err
	}
	return ct.RowsAffected(), nil
}

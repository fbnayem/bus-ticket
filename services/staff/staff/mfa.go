package staff

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP for staff accounts (plan workstream P1-C: "staff auth: email/password +
// TOTP MFA mandatory").
//
// RFC 6238 in about eighty lines of standard library, rather than a dependency.
// The whole algorithm is: HMAC-SHA1 over a 30-second counter, take four bytes
// from a position the last nibble points at, mod a million. SHA-1 is not a
// choice here — it is what every authenticator app implements.
//
// Two properties that matter more than the arithmetic:
//
//   - A one-step window either side, so a clock a few seconds out still works
//     and a code is not valid for a minute and a half.
//   - A used code cannot be used again inside its own window. Without that,
//     anyone who watches a clerk type six digits has thirty seconds to reuse
//     them, which is most of the value of the second factor gone.

var (
	ErrMFARequired = errors.New("staff: this account requires a one-time code")
	ErrMFAInvalid  = errors.New("staff: that one-time code is not right")
	ErrMFAReplayed = errors.New("staff: that code has already been used")
)

const totpStep = 30 * time.Second

// NewTOTPSecret mints a base32 secret and the otpauth:// URI an authenticator
// app scans. The secret is returned exactly once, at enrolment.
func NewTOTPSecret(email string) (secret, uri string, err error) {
	raw := make([]byte, 20) // 160 bits, the RFC 4226 recommendation
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = strings.TrimRight(base32.StdEncoding.EncodeToString(raw), "=")
	uri = fmt.Sprintf("otpauth://totp/Jatra:%s?secret=%s&issuer=Jatra&algorithm=SHA1&digits=6&period=30",
		url.PathEscape(email), secret)
	return secret, uri, nil
}

// totpAt computes the six-digit code for one time step.
func totpAt(secret string, t time.Time) (string, error) {
	pad := strings.ToUpper(secret)
	if n := len(pad) % 8; n != 0 {
		pad += strings.Repeat("=", 8-n)
	}
	key, err := base32.StdEncoding.DecodeString(pad)
	if err != nil {
		return "", fmt.Errorf("staff: malformed TOTP secret: %w", err)
	}

	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(t.Unix()/int64(totpStep.Seconds())))

	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset]&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])) % 1_000_000
	return fmt.Sprintf("%06d", code), nil
}

// verifyTOTP checks a code against the current step and one step either side.
func verifyTOTP(secret, code string) bool {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return false
	}
	now := time.Now()
	for _, skew := range []time.Duration{0, -totpStep, totpStep} {
		want, err := totpAt(secret, now.Add(skew))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

// BeginMFASetup issues a secret for an account that does not have MFA on yet.
// It is stored but not activated: an account is only committed to MFA once the
// person has proved they can produce a code, so nobody locks themselves out by
// scanning a QR and closing the tab.
func (s *Service) BeginMFASetup(ctx context.Context, staffID, email string) (secret, uri string, err error) {
	var enabled bool
	if err := s.pool.QueryRow(ctx,
		`SELECT mfa_enabled FROM staff.staff_users WHERE staff_id = $1::uuid`, staffID).
		Scan(&enabled); err != nil {
		return "", "", err
	}
	if enabled {
		return "", "", errors.New("staff: one-time codes are already switched on for this account")
	}
	secret, uri, err = NewTOTPSecret(email)
	if err != nil {
		return "", "", err
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE staff.staff_users SET mfa_secret = $2 WHERE staff_id = $1::uuid`, staffID, secret)
	return secret, uri, err
}

// EnableMFA commits the account to one-time codes, but only against a code the
// person just produced.
func (s *Service) EnableMFA(ctx context.Context, id *Identity, code string) error {
	var secret *string
	if err := s.pool.QueryRow(ctx,
		`SELECT mfa_secret FROM staff.staff_users WHERE staff_id = $1::uuid`, id.StaffID).
		Scan(&secret); err != nil {
		return err
	}
	if secret == nil || *secret == "" {
		return errors.New("staff: start the setup first")
	}
	if !verifyTOTP(*secret, code) {
		return ErrMFAInvalid
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE staff.staff_users SET mfa_enabled = true WHERE staff_id = $1::uuid`, id.StaffID); err != nil {
		return err
	}
	s.Audit(ctx, id, "staff.mfa.enable", id.Email, nil)
	return nil
}

// DisableMFA turns it off, and requires a current code to do so. Otherwise a
// stolen session could quietly remove the second factor it could not defeat.
func (s *Service) DisableMFA(ctx context.Context, id *Identity, code string) error {
	var secret *string
	if err := s.pool.QueryRow(ctx,
		`SELECT mfa_secret FROM staff.staff_users WHERE staff_id = $1::uuid`, id.StaffID).
		Scan(&secret); err != nil {
		return err
	}
	if secret == nil || !verifyTOTP(*secret, code) {
		return ErrMFAInvalid
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE staff.staff_users SET mfa_enabled = false, mfa_secret = NULL
		  WHERE staff_id = $1::uuid`, id.StaffID); err != nil {
		return err
	}
	s.Audit(ctx, id, "staff.mfa.disable", id.Email, nil)
	return nil
}

// checkSecondFactor is called from Login once the password is known good.
func (s *Service) checkSecondFactor(ctx context.Context, staffID, code string) error {
	var enabled bool
	var secret *string
	if err := s.pool.QueryRow(ctx,
		`SELECT mfa_enabled, mfa_secret FROM staff.staff_users WHERE staff_id = $1::uuid`, staffID).
		Scan(&enabled, &secret); err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	if secret == nil || *secret == "" {
		// Enabled with no secret is a broken account, not an open door.
		return ErrMFAInvalid
	}
	if code == "" {
		return ErrMFARequired
	}
	if !verifyTOTP(*secret, code) {
		return ErrMFAInvalid
	}

	// One code, one use. The insert IS the check, so two logins racing with the
	// same six digits cannot both succeed.
	ct, err := s.pool.Exec(ctx, `
		INSERT INTO staff.mfa_used (staff_id, code, step)
		VALUES ($1::uuid, $2, floor(extract(epoch from now()) / 30)::bigint)
		ON CONFLICT DO NOTHING`, staffID, code)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrMFAReplayed
	}
	return nil
}

// MFAStatus reports whether an account has a second factor, for the console.
func (s *Service) MFAStatus(ctx context.Context, staffID string) (enabled bool, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT mfa_enabled FROM staff.staff_users WHERE staff_id = $1::uuid`, staffID).Scan(&enabled)
	return enabled, err
}

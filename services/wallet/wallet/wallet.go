// Package wallet is the agent wallet.
//
// The wallet is a LEDGER, not a balance column. agent.wallet_transactions is
// append-only and is the truth; agent.wallets.available_poisha and
// held_poisha are a cache that exists so a sale can be authorised in one
// statement. Recompute() rebuilds both from the log, and the proof suite
// asserts that cache and recomputation agree even after the process is killed
// mid-sale.
//
// Spending power is  available + credit_limit - held.  A sale is authorised by
// exactly one conditional UPDATE whose WHERE clause asks whether that number
// covers the price. The rowcount is the lock — the same discipline the seat
// inventory uses, for the same reason: a SELECT-then-UPDATE would let a
// thousand concurrent sales all read the same balance and all decide yes.
package wallet

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInsufficient = errors.New("wallet: not enough balance or credit")
	ErrNotFound     = errors.New("wallet: no wallet for that agency")
	ErrHoldNotFound = errors.New("wallet: hold not found")
	ErrHoldSettled  = errors.New("wallet: hold already captured or released")
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

type Wallet struct {
	WalletID    string `json:"wallet_id"`
	AgencyID    string `json:"agency_id"`
	AgencyName  string `json:"agency_name"`
	Available   int64  `json:"available_poisha"`
	Held        int64  `json:"held_poisha"`
	CreditLimit int64  `json:"credit_limit_poisha"`
	// Spendable is what the agent can actually commit right now. It is the
	// number the portal shows, because "balance" alone misleads whenever a
	// hold or a credit line is in play.
	Spendable int64 `json:"spendable_poisha"`
}

func (s *Store) Get(ctx context.Context, agencyID string) (*Wallet, error) {
	var w Wallet
	err := s.pool.QueryRow(ctx, `
		SELECT w.wallet_id::text, w.agency_id::text, a.name,
		       w.available_poisha, w.held_poisha, w.credit_limit_poisha
		  FROM agent.wallets w
		  JOIN agent.agencies a ON a.agency_id = w.agency_id
		 WHERE w.agency_id = $1::uuid`, agencyID).
		Scan(&w.WalletID, &w.AgencyID, &w.AgencyName, &w.Available, &w.Held, &w.CreditLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	w.Spendable = w.Available + w.CreditLimit - w.Held
	return &w, nil
}

// Hold reserves spending power for a sale in flight.
//
// This is the whole concurrency control for agent money. A thousand
// simultaneous sales against a wallet with credit for ten tickets produce at
// most ten successful holds, because each one must win the same conditional
// UPDATE and each winner shrinks the pool for the next.
func (s *Store) Hold(ctx context.Context, agencyID string, amount int64, seatHoldID string) (string, error) {
	if amount <= 0 {
		return "", errors.New("wallet: hold amount must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var walletID string
	err = tx.QueryRow(ctx,
		`SELECT wallet_id::text FROM agent.wallets WHERE agency_id = $1::uuid`, agencyID).Scan(&walletID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}

	ct, err := tx.Exec(ctx, `
		UPDATE agent.wallets
		   SET held_poisha = held_poisha + $2,
		       updated_at  = now()
		 WHERE wallet_id = $1::uuid
		   AND (available_poisha + credit_limit_poisha - held_poisha) >= $2`,
		walletID, amount)
	if err != nil {
		return "", err
	}
	if ct.RowsAffected() != 1 {
		return "", ErrInsufficient
	}

	var holdID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent.wallet_holds (wallet_id, amount_poisha, seat_hold_id)
		VALUES ($1::uuid, $2, NULLIF($3,'')::uuid)
		RETURNING wallet_hold_id::text`, walletID, amount, seatHoldID).Scan(&holdID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return holdID, nil
}

// Capture turns a hold into a spend when the ticket is issued.
// Idempotent on the hold: the status transition is itself a conditional
// UPDATE, so a retried capture is a no-op rather than a double charge.
func (s *Store) Capture(ctx context.Context, holdID, bookingID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var walletID string
	var amount int64
	ct, err := tx.Exec(ctx, `
		UPDATE agent.wallet_holds
		   SET status = 'CAPTURED', settled_at = now(), booking_id = NULLIF($2,'')::uuid
		 WHERE wallet_hold_id = $1::uuid AND status = 'HELD'`, holdID, bookingID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		// Either already captured (fine — replay) or never existed.
		var st string
		if e := tx.QueryRow(ctx,
			`SELECT status FROM agent.wallet_holds WHERE wallet_hold_id = $1::uuid`, holdID).Scan(&st); e != nil {
			return ErrHoldNotFound
		}
		if st == "CAPTURED" {
			return tx.Commit(ctx)
		}
		return ErrHoldSettled
	}
	if err := tx.QueryRow(ctx,
		`SELECT wallet_id::text, amount_poisha FROM agent.wallet_holds WHERE wallet_hold_id = $1::uuid`,
		holdID).Scan(&walletID, &amount); err != nil {
		return err
	}

	// The money leaves. held shrinks and available shrinks together, so
	// spending power is unchanged by the capture itself — it was already
	// committed at hold time. That is the point of holding.
	if _, err := tx.Exec(ctx, `
		UPDATE agent.wallets
		   SET held_poisha = held_poisha - $2,
		       available_poisha = available_poisha - $2,
		       updated_at = now()
		 WHERE wallet_id = $1::uuid`, walletID, amount); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent.wallet_transactions (wallet_id, kind, delta_poisha, booking_id, ref, note)
		VALUES ($1::uuid, 'SALE', $2, NULLIF($3,'')::uuid, $4, 'ticket issued')`,
		walletID, -amount, bookingID, holdID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Release returns held spending power when a sale does not complete.
func (s *Store) Release(ctx context.Context, holdID, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var walletID string
	var amount int64
	ct, err := tx.Exec(ctx, `
		UPDATE agent.wallet_holds SET status = 'RELEASED', settled_at = now()
		 WHERE wallet_hold_id = $1::uuid AND status = 'HELD'`, holdID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return tx.Commit(ctx) // already settled — releasing twice is harmless
	}
	if err := tx.QueryRow(ctx,
		`SELECT wallet_id::text, amount_poisha FROM agent.wallet_holds WHERE wallet_hold_id = $1::uuid`,
		holdID).Scan(&walletID, &amount); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE agent.wallets SET held_poisha = held_poisha - $2, updated_at = now()
		  WHERE wallet_id = $1::uuid`, walletID, amount); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Credit posts money INTO a wallet: commission earned, a sale refunded, an
// approved recharge. Always a transaction row, never a bare balance bump.
func (s *Store) Credit(ctx context.Context, walletID, kind string, amount int64, bookingID, note string) error {
	if amount <= 0 {
		return errors.New("wallet: credit must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx,
		`UPDATE agent.wallets SET available_poisha = available_poisha + $2, updated_at = now()
		  WHERE wallet_id = $1::uuid`, walletID, amount); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent.wallet_transactions (wallet_id, kind, delta_poisha, booking_id, note)
		VALUES ($1::uuid, $2, $3, NULLIF($4,'')::uuid, $5)`,
		walletID, kind, amount, bookingID, note); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Recompute rebuilds available and held from the append-only log. If this
// disagrees with the cached columns, the cache is wrong and the log is right.
func (s *Store) Recompute(ctx context.Context, walletID string) (available, held int64, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT COALESCE(sum(delta_poisha),0) FROM agent.wallet_transactions WHERE wallet_id = $1::uuid),
		  (SELECT COALESCE(sum(amount_poisha),0) FROM agent.wallet_holds
		    WHERE wallet_id = $1::uuid AND status = 'HELD')`, walletID).Scan(&available, &held)
	return available, held, err
}

// ---------------------------------------------------------------- recharges --

// RequestRecharge records money the agent says they have sent. It does not
// move the balance — approval does. Maker and checker are different people,
// and the database enforces that with a CHECK constraint rather than trusting
// this function to remember.
func (s *Store) RequestRecharge(ctx context.Context, agencyID string, amount int64, method, reference, requestedBy string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO agent.recharges (wallet_id, amount_poisha, method, reference, requested_by)
		SELECT wallet_id, $2, $3, $4, $5::uuid FROM agent.wallets WHERE agency_id = $1::uuid
		RETURNING recharge_id::text`, agencyID, amount, method, reference, requestedBy).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

func (s *Store) ApproveRecharge(ctx context.Context, rechargeID, approvedBy string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var walletID, method string
	var amount int64
	// The WHERE clause carries the maker-checker rule so a self-approval never
	// even reaches the CHECK constraint; the constraint is the backstop.
	err = tx.QueryRow(ctx, `
		UPDATE agent.recharges
		   SET status = 'APPROVED', approved_by = $2::uuid, approved_at = now()
		 WHERE recharge_id = $1::uuid AND status = 'REQUESTED' AND requested_by <> $2::uuid
		RETURNING wallet_id::text, amount_poisha, method`, rechargeID, approvedBy).
		Scan(&walletID, &amount, &method)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("recharge is not pending, or you are the person who requested it")
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE agent.wallets SET available_poisha = available_poisha + $2, updated_at = now()
		  WHERE wallet_id = $1::uuid`, walletID, amount); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent.wallet_transactions (wallet_id, kind, delta_poisha, ref, note)
		VALUES ($1::uuid,'RECHARGE',$2,$3,'approved recharge')`,
		walletID, amount, rechargeID); err != nil {
		return err
	}

	// Cash in, liability to the agent up. Balanced by construction.
	var journalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.journal_entries (description)
		VALUES ('agent wallet recharge ' || $1) RETURNING journal_id::text`, rechargeID).
		Scan(&journalID); err != nil {
		return err
	}
	for _, e := range []struct {
		acct, side string
	}{{"1001", "DR"}, {"2102", "CR"}} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.ledger_entries (journal_id, account_code, side, amount_poisha, party_ref)
			VALUES ($1::uuid, $2, $3, $4, $5)`, journalID, e.acct, e.side, amount, walletID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `SELECT finance.assert_journal_balanced($1::uuid)`, journalID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

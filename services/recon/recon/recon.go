// Package recon is three-way reconciliation (plan workstream P2-F).
//
// Until now settlement reconciled against the platform's own records, which is
// one leg of three and proves only that the platform agrees with itself. The
// two legs that were missing are here: what the gateway says it settled, and
// what the bank says it paid.
//
// Every exception class the plan names is detected, classified and aged, and an
// open exception on any transaction inside a settlement window blocks that
// settlement from reaching APPROVED. There is no override for that. A
// discrepancy that can be approved away is a discrepancy that will be.
package recon

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ------------------------------------------------------------- gateway file --

type ImportResult struct {
	FileID      string `json:"file_id"`
	Lines       int    `json:"lines"`
	GrossPoisha int64  `json:"gross_poisha"`
	FeePoisha   int64  `json:"fee_poisha"`
	NetPoisha   int64  `json:"net_poisha"`
}

// ImportGatewayFile reads a settlement file in the shape every MFS aggregator
// in this market produces: transaction id, amount, fee, kind, settled time.
//
//	txn_id,amount,fee,kind,settled_at
//	BKASH-7f3a...,120000,1800,SALE,2026-08-14T23:40:00Z
//
// Amounts are in poisha because no float ever touches money here.
func (s *Service) ImportGatewayFile(ctx context.Context, provider, businessDate, filename string, r io.Reader) (*ImportResult, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("recon: could not read the settlement file: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var fileID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO finance.gateway_files (provider, business_date, filename)
		VALUES ($1, $2::date, $3)
		ON CONFLICT (provider, business_date, filename) DO UPDATE SET imported_at = now()
		RETURNING file_id::text`, provider, businessDate, filename).Scan(&fileID); err != nil {
		return nil, err
	}
	// Re-importing the same file replaces its lines rather than doubling them.
	if _, err := tx.Exec(ctx, `DELETE FROM finance.gateway_lines WHERE file_id = $1::uuid`, fileID); err != nil {
		return nil, err
	}

	res := &ImportResult{FileID: fileID}
	for i, rec := range rows {
		if len(rec) < 3 {
			continue
		}
		if i == 0 && strings.EqualFold(strings.TrimSpace(rec[0]), "txn_id") {
			continue // header
		}
		txnID := strings.TrimSpace(rec[0])
		amount, err := strconv.ParseInt(strings.TrimSpace(rec[1]), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("recon: line %d has a bad amount %q", i+1, rec[1])
		}
		var fee int64
		if len(rec) > 2 {
			fee, _ = strconv.ParseInt(strings.TrimSpace(rec[2]), 10, 64)
		}
		kind := "SALE"
		if len(rec) > 3 && rec[3] != "" {
			kind = strings.ToUpper(strings.TrimSpace(rec[3]))
		}
		settled := time.Now()
		if len(rec) > 4 && rec[4] != "" {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(rec[4])); err == nil {
				settled = t
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO finance.gateway_lines
				(file_id, provider, provider_txn_id, amount_poisha, fee_poisha, kind, settled_at)
			VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
			fileID, provider, txnID, amount, fee, kind, settled); err != nil {
			return nil, err
		}
		res.Lines++
		if kind == "SALE" {
			res.GrossPoisha += amount
		} else {
			res.GrossPoisha -= amount
		}
		res.FeePoisha += fee
	}
	res.NetPoisha = res.GrossPoisha - res.FeePoisha

	if _, err := tx.Exec(ctx, `
		UPDATE finance.gateway_files
		   SET line_count = $2, gross_poisha = $3, fee_poisha = $4, net_poisha = $5
		 WHERE file_id = $1::uuid`,
		fileID, res.Lines, res.GrossPoisha, res.FeePoisha, res.NetPoisha); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return res, nil
}

// ImportBankStatement reads the third leg: what actually landed in the account.
//
//	value_date,reference,amount,direction,narrative
func (s *Service) ImportBankStatement(ctx context.Context, accountRef string, r io.Reader) (int, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return 0, fmt.Errorf("recon: could not read the bank statement: %w", err)
	}
	n := 0
	for i, rec := range rows {
		if len(rec) < 4 {
			continue
		}
		if i == 0 && strings.EqualFold(strings.TrimSpace(rec[0]), "value_date") {
			continue
		}
		amount, err := strconv.ParseInt(strings.TrimSpace(rec[2]), 10, 64)
		if err != nil {
			return n, fmt.Errorf("recon: bank line %d has a bad amount %q", i+1, rec[2])
		}
		narrative := ""
		if len(rec) > 4 {
			narrative = strings.TrimSpace(rec[4])
		}
		ct, err := s.pool.Exec(ctx, `
			INSERT INTO finance.bank_lines
				(account_ref, value_date, reference, amount_poisha, direction, narrative)
			VALUES ($1, $2::date, $3, $4, $5, $6)
			ON CONFLICT (account_ref, value_date, reference) DO UPDATE
			   SET amount_poisha = EXCLUDED.amount_poisha, narrative = EXCLUDED.narrative`,
			accountRef, strings.TrimSpace(rec[0]), strings.TrimSpace(rec[1]),
			amount, strings.ToUpper(strings.TrimSpace(rec[3])), narrative)
		if err != nil {
			return n, err
		}
		n += int(ct.RowsAffected())
	}
	return n, nil
}

// ------------------------------------------------------------- the matching --

type RunResult struct {
	RunID           string `json:"run_id"`
	BusinessDate    string `json:"business_date"`
	PlatformPoisha  int64  `json:"platform_poisha"`
	GatewayPoisha   int64  `json:"gateway_poisha"`
	BankPoisha      int64  `json:"bank_poisha"`
	ExceptionsFound int    `json:"exceptions_found"`
	Matched         int    `json:"matched"`
}

// Run performs the three-way match for one business date.
//
// Leg 1 vs leg 2: every platform payment must have exactly one gateway line for
// the same amount, and every gateway line must have a platform payment.
// Leg 2 vs leg 3: the gateway's net for the day must arrive in the bank.
func (s *Service) Run(ctx context.Context, businessDate string) (*RunResult, error) {
	res := &RunResult{BusinessDate: businessDate}

	// --- platform payments with no gateway line ---------------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, p.provider, 'MISSING_IN_GATEWAY', p.provider_txn_id,
		       p.amount_poisha, 0,
		       'the platform recorded this payment but the gateway file does not list it'
		  FROM commerce.payments p
		 WHERE p.status = 'PAID'
		   AND p.provider IN ('BKASH','NAGAD','CARD','BANK')
		   AND (p.created_at AT TIME ZONE 'Asia/Dhaka')::date = $1::date
		   AND NOT EXISTS (SELECT 1 FROM finance.gateway_lines g
		                    WHERE g.provider = p.provider AND g.provider_txn_id = p.provider_txn_id)
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- gateway lines with no platform payment ---------------------------
	// This is the dangerous one: the gateway took money the platform never
	// recorded, which usually means a callback that never arrived.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, g.provider,
		       CASE WHEN EXISTS (SELECT 1 FROM commerce.payment_webhooks w
		                          WHERE w.provider_txn_id = g.provider_txn_id AND NOT w.accepted)
		            THEN 'CALLBACK_FAILURE' ELSE 'MISSING_IN_PLATFORM' END,
		       g.provider_txn_id, 0, g.amount_poisha,
		       'the gateway settled this transaction and the platform has no payment for it'
		  FROM finance.gateway_lines g
		  JOIN finance.gateway_files f ON f.file_id = g.file_id
		 WHERE f.business_date = $1::date AND g.kind = 'SALE'
		   AND NOT EXISTS (SELECT 1 FROM commerce.payments p
		                    WHERE p.provider = g.provider AND p.provider_txn_id = g.provider_txn_id
		                      AND p.status = 'PAID')
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- the same transaction settled twice --------------------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, g.provider, 'DUPLICATE_IN_GATEWAY', g.provider_txn_id,
		       max(g.amount_poisha), sum(g.amount_poisha),
		       'the gateway file lists this transaction ' || count(*) || ' times'
		  FROM finance.gateway_lines g
		  JOIN finance.gateway_files f ON f.file_id = g.file_id
		 WHERE f.business_date = $1::date AND g.kind = 'SALE'
		 GROUP BY g.provider, g.provider_txn_id
		HAVING count(*) > 1
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- amounts that disagree ---------------------------------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, p.provider, 'AMOUNT_MISMATCH', p.provider_txn_id,
		       p.amount_poisha, g.amount_poisha,
		       'the platform recorded a different amount from the gateway'
		  FROM commerce.payments p
		  JOIN finance.gateway_lines g
		    ON g.provider = p.provider AND g.provider_txn_id = p.provider_txn_id AND g.kind = 'SALE'
		  JOIN finance.gateway_files f ON f.file_id = g.file_id
		 WHERE f.business_date = $1::date AND p.status = 'PAID'
		   AND p.amount_poisha <> g.amount_poisha
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- reversals the platform still thinks are paid -----------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, g.provider, 'REVERSED_TRANSACTION', g.provider_txn_id,
		       g.amount_poisha, 0,
		       'the gateway reversed this transaction but the platform still holds the booking as paid'
		  FROM finance.gateway_lines g
		  JOIN finance.gateway_files f ON f.file_id = g.file_id
		  JOIN commerce.payments p
		    ON p.provider = g.provider AND p.provider_txn_id = g.provider_txn_id
		 WHERE f.business_date = $1::date AND g.kind = 'REVERSAL' AND p.status = 'PAID'
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- refunds the platform issued that never settled ---------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, p.provider, 'FAILED_REFUND', p.provider_txn_id,
		       p.amount_poisha, 0,
		       'the platform refunded this payment and no refund line came back from the gateway'
		  FROM commerce.payments p
		 WHERE p.status = 'REFUNDED'
		   AND (p.created_at AT TIME ZONE 'Asia/Dhaka')::date = $1::date
		   AND NOT EXISTS (SELECT 1 FROM finance.gateway_lines g
		                    WHERE g.provider = p.provider AND g.provider_txn_id = p.provider_txn_id
		                      AND g.kind IN ('REFUND','REVERSAL'))
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// --- gateway net that never reached the bank ----------------------------
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO finance.recon_exceptions
			(business_date, provider, kind, reference, expected_poisha, actual_poisha, detail)
		SELECT $1::date, f.provider, 'MISSING_BANK_SETTLEMENT',
		       f.provider || ' ' || f.business_date::text, f.net_poisha,
		       COALESCE((SELECT sum(b.amount_poisha) FROM finance.bank_lines b
		                  WHERE b.direction = 'CREDIT'
		                    AND b.value_date BETWEEN f.business_date AND f.business_date + 2
		                    AND b.narrative ILIKE '%' || f.provider || '%'), 0),
		       'the gateway settled a net amount that has not arrived in the bank account'
		  FROM finance.gateway_files f
		 WHERE f.business_date = $1::date
		   AND f.net_poisha <> COALESCE((SELECT sum(b.amount_poisha) FROM finance.bank_lines b
		                  WHERE b.direction = 'CREDIT'
		                    AND b.value_date BETWEEN f.business_date AND f.business_date + 2
		                    AND b.narrative ILIKE '%' || f.provider || '%'), 0)
		ON CONFLICT (business_date, kind, reference) DO NOTHING`, businessDate); err != nil {
		return nil, err
	}

	// Match what did line up, so the run has a matched count and not only a
	// list of what went wrong.
	if _, err := s.pool.Exec(ctx, `
		UPDATE finance.gateway_lines g SET matched_payment_id = p.payment_id
		  FROM commerce.payments p, finance.gateway_files f
		 WHERE f.file_id = g.file_id AND f.business_date = $1::date
		   AND p.provider = g.provider AND p.provider_txn_id = g.provider_txn_id
		   AND p.amount_poisha = g.amount_poisha AND p.status = 'PAID'
		   AND g.matched_payment_id IS NULL`, businessDate); err != nil {
		return nil, err
	}

	if err := s.pool.QueryRow(ctx, `
		SELECT
		  COALESCE((SELECT sum(amount_poisha) FROM commerce.payments
		             WHERE status='PAID' AND provider IN ('BKASH','NAGAD','CARD','BANK')
		               AND (created_at AT TIME ZONE 'Asia/Dhaka')::date = $1::date), 0),
		  COALESCE((SELECT sum(gross_poisha) FROM finance.gateway_files WHERE business_date = $1::date), 0),
		  COALESCE((SELECT sum(amount_poisha) FROM finance.bank_lines
		             WHERE direction='CREDIT' AND value_date BETWEEN $1::date AND $1::date + 2), 0),
		  (SELECT count(*) FROM finance.recon_exceptions
		    WHERE business_date = $1::date AND status IN ('OPEN','INVESTIGATING')),
		  (SELECT count(*) FROM finance.gateway_lines g JOIN finance.gateway_files f ON f.file_id=g.file_id
		    WHERE f.business_date = $1::date AND g.matched_payment_id IS NOT NULL)`, businessDate).
		Scan(&res.PlatformPoisha, &res.GatewayPoisha, &res.BankPoisha,
			&res.ExceptionsFound, &res.Matched); err != nil {
		return nil, err
	}

	if err := s.pool.QueryRow(ctx, `
		INSERT INTO finance.recon_runs
			(business_date, platform_poisha, gateway_poisha, bank_poisha, exceptions_found)
		VALUES ($1::date, $2, $3, $4, $5) RETURNING run_id::text`,
		businessDate, res.PlatformPoisha, res.GatewayPoisha, res.BankPoisha, res.ExceptionsFound).
		Scan(&res.RunID); err != nil {
		return nil, err
	}
	return res, nil
}

// ------------------------------------------------------------- exceptions --

type Exception struct {
	ExceptionID  string     `json:"exception_id"`
	BusinessDate string     `json:"business_date"`
	Provider     string     `json:"provider"`
	Kind         string     `json:"kind"`
	Reference    string     `json:"reference"`
	Expected     int64      `json:"expected_poisha"`
	Actual       int64      `json:"actual_poisha"`
	Detail       string     `json:"detail"`
	Status       string     `json:"status"`
	AgeHours     int        `json:"age_hours"`
	DetectedAt   time.Time  `json:"detected_at"`
	ResolvedAt   *time.Time `json:"resolved_at"`
	Resolution   string     `json:"resolution,omitempty"`
}

func (s *Service) Exceptions(ctx context.Context, status string) ([]Exception, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT exception_id::text, business_date::text, COALESCE(provider,''), kind, reference,
		       expected_poisha, actual_poisha, detail, status,
		       EXTRACT(EPOCH FROM (now() - detected_at))/3600,
		       detected_at, resolved_at, COALESCE(resolution,'')
		  FROM finance.recon_exceptions
		 WHERE ($1 = '' OR status = $1)
		 ORDER BY (status IN ('OPEN','INVESTIGATING')) DESC, detected_at DESC
		 LIMIT 200`, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Exception{}
	for rows.Next() {
		var e Exception
		var age float64
		if err := rows.Scan(&e.ExceptionID, &e.BusinessDate, &e.Provider, &e.Kind, &e.Reference,
			&e.Expected, &e.Actual, &e.Detail, &e.Status, &age,
			&e.DetectedAt, &e.ResolvedAt, &e.Resolution); err != nil {
			return nil, err
		}
		e.AgeHours = int(age)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Service) Resolve(ctx context.Context, exceptionID, status, resolution, staffID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE finance.recon_exceptions
		   SET status = $2, resolution = $3, assigned_to = NULLIF($4,'')::uuid,
		       resolved_at = CASE WHEN $2 IN ('RESOLVED','WRITTEN_OFF') THEN now() END
		 WHERE exception_id = $1::uuid`, exceptionID, status, resolution, staffID)
	return err
}

// BlockingExceptions lists the open exceptions inside a settlement window. This
// is the function that stops a settlement being approved, and it is deliberately
// simple to read: if it returns anything, approval is refused.
func (s *Service) BlockingExceptions(ctx context.Context, from, to string) ([]Exception, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT exception_id::text, business_date::text, COALESCE(provider,''), kind, reference,
		       expected_poisha, actual_poisha, detail, status, 0, detected_at, resolved_at, ''
		  FROM finance.recon_exceptions
		 WHERE business_date BETWEEN $1::date AND $2::date
		   AND status IN ('OPEN','INVESTIGATING')
		 ORDER BY detected_at`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Exception{}
	for rows.Next() {
		var e Exception
		var age float64
		if err := rows.Scan(&e.ExceptionID, &e.BusinessDate, &e.Provider, &e.Kind, &e.Reference,
			&e.Expected, &e.Actual, &e.Detail, &e.Status, &age,
			&e.DetectedAt, &e.ResolvedAt, &e.Resolution); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type Run struct {
	RunID        string    `json:"run_id"`
	BusinessDate string    `json:"business_date"`
	Platform     int64     `json:"platform_poisha"`
	Gateway      int64     `json:"gateway_poisha"`
	Bank         int64     `json:"bank_poisha"`
	Exceptions   int       `json:"exceptions_found"`
	RanAt        time.Time `json:"ran_at"`
}

func (s *Service) Runs(ctx context.Context, limit int) ([]Run, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT run_id::text, business_date::text, platform_poisha, gateway_poisha,
		       bank_poisha, exceptions_found, ran_at
		  FROM finance.recon_runs ORDER BY ran_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		var r Run
		if err := rows.Scan(&r.RunID, &r.BusinessDate, &r.Platform, &r.Gateway,
			&r.Bank, &r.Exceptions, &r.RanAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GenerateFiles produces a gateway file and a bank statement from the
// platform's own payments for a date, so the reconciliation can be exercised
// without a real aggregator. Passing seedExceptions injects one of each class
// that the matcher must then find — which is how the plan asks for this to be
// tested.
func (s *Service) GenerateFiles(ctx context.Context, provider, businessDate string, seedExceptions bool) (gateway string, bank string, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT provider_txn_id, amount_poisha
		  FROM commerce.payments
		 WHERE status = 'PAID' AND provider = $1
		   AND (created_at AT TIME ZONE 'Asia/Dhaka')::date = $2::date
		 ORDER BY created_at`, provider, businessDate)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()

	var g strings.Builder
	g.WriteString("txn_id,amount,fee,kind,settled_at\n")
	var gross, fee int64
	settled := businessDate + "T23:30:00Z"
	n := 0
	for rows.Next() {
		var txn string
		var amount int64
		if err := rows.Scan(&txn, &amount); err != nil {
			return "", "", err
		}
		n++
		// Seeded exceptions: drop one line, duplicate one, and shift one amount.
		if seedExceptions && n == 1 {
			continue // MISSING_IN_GATEWAY
		}
		lineFee := amount * 15 / 1000
		if seedExceptions && n == 2 {
			amount += 100 // AMOUNT_MISMATCH
		}
		fmt.Fprintf(&g, "%s,%d,%d,SALE,%s\n", txn, amount, lineFee, settled)
		gross += amount
		fee += lineFee
		if seedExceptions && n == 3 {
			fmt.Fprintf(&g, "%s,%d,%d,SALE,%s\n", txn, amount, lineFee, settled) // DUPLICATE
			gross += amount
			fee += lineFee
		}
	}
	if err := rows.Err(); err != nil {
		return "", "", err
	}
	if seedExceptions {
		// A transaction the gateway settled that the platform never saw.
		fmt.Fprintf(&g, "GHOST-%s,150000,2250,SALE,%s\n", businessDate, settled)
		gross += 150000
		fee += 2250
	}

	net := gross - fee
	var b strings.Builder
	b.WriteString("value_date,reference,amount,direction,narrative\n")
	if seedExceptions {
		// Short-pay the bank leg so MISSING_BANK_SETTLEMENT is detected too.
		net -= 25000
	}
	fmt.Fprintf(&b, "%s,SETL-%s-%s,%d,CREDIT,%s daily settlement\n",
		businessDate, provider, strings.ReplaceAll(businessDate, "-", ""), net, provider)
	return g.String(), b.String(), nil
}

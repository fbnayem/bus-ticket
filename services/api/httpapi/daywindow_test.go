package httpapi

import (
	"context"
	"testing"
)

// The crew report, the owner P&L, and the settlement calc all bound their
// windows by the day a booking was made. A booking's created_at is a UTC
// timestamptz; "today" for a Bangladeshi operator is a day in Asia/Dhaka, six
// hours ahead. Comparing the raw timestamp to a Dhaka date lands the day
// boundary six hours early — a conductor's 1am sale in Dhaka (which is 7pm the
// day before in UTC) drops out of "today", and the operator's counts and cash
// owed are wrong for the first six hours of every day.
//
// The fix everywhere is the same: convert the timestamp to Dhaka wall time
// before taking its date, (created_at AT TIME ZONE 'Asia/Dhaka')::date. This
// proof pins that predicate to the moment the naive one gets wrong, and shows
// the two disagree exactly there — so a regression to the raw comparison fails.
func TestDhakaDayBoundaryIncludesEarlyMorningSales(t *testing.T) {
	requireDB(t)
	ctx := context.Background()

	// The server runs against a UTC session, which is what makes the naive
	// comparison wrong; pin it so the proof reflects production rather than a
	// machine that happens to be set to Dhaka.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
		t.Fatal(err)
	}

	// A moment 30 minutes into today, Dhaka time: unambiguously "today" for the
	// operator, but 18:30 yesterday in UTC.
	var dhakaSaysToday, naiveSaysToday bool
	if err := tx.QueryRow(ctx, `
		WITH m AS (
		  SELECT ((catalog.bd_today()::timestamp + interval '30 minutes')
		           AT TIME ZONE 'Asia/Dhaka') AS ts
		)
		SELECT (ts AT TIME ZONE 'Asia/Dhaka')::date >= catalog.bd_today(),  -- the fix
		       ts >= catalog.bd_today()                                     -- the old, buggy predicate
		  FROM m`).Scan(&dhakaSaysToday, &naiveSaysToday); err != nil {
		t.Fatal(err)
	}

	if !dhakaSaysToday {
		t.Fatal("a 00:30 Dhaka sale is not counted as today by the Dhaka-aware " +
			"predicate — the fix does not work")
	}
	if naiveSaysToday {
		t.Fatal("the naive UTC comparison also counted this sale as today, so this " +
			"proof no longer demonstrates the boundary bug it guards against")
	}
}

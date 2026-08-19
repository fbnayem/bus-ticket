package commerce

import "testing"

// sumPostings returns the total on one account+side, and the whole journal's
// debit and credit totals.
func sumPostings(ps []Posting, account, side string) int64 {
	var v int64
	for _, p := range ps {
		if p.Account == account && p.Side == side {
			v += p.Amount
		}
	}
	return v
}

func drCr(ps []Posting) (dr, cr int64) {
	for _, p := range ps {
		if p.Side == "DR" {
			dr += p.Amount
		} else {
			cr += p.Amount
		}
	}
	return
}

// A concession is the operator's gift, not the platform's. The whole money model
// rests on one property: the platform's revenue on a sale is identical whether a
// concession was granted or not — the reduction comes out of the operator's
// payable alone. This proves it across both payment methods, and proves the
// journal still balances.
//
// It is the counter twin of the crew-discount proof, and it is what lets the
// settlement recompute the platform's cut on the full fare and still agree with
// what was posted.
func TestCounterConcessionLeavesPlatformWhole(t *testing.T) {
	const (
		full     = 85000 // ৳800 fare + ৳50 service fee
		discount = 20000 // a ৳200 concession
		op       = "11111111-1111-1111-1111-111111111111"
		counter  = "counter-1"
	)

	for _, method := range []string{"CASH", "BKASH"} {
		plain := CounterPostings(full, 0, method, op, counter)
		conc := CounterPostings(full, discount, method, op, counter)

		// The platform's revenue (4101) is untouched by the concession.
		platPlain := sumPostings(plain, "4101", "CR")
		platConc := sumPostings(conc, "4101", "CR")
		if platPlain != platConc {
			t.Fatalf("%s: platform revenue moved with the concession: %d vs %d — "+
				"the platform must not absorb an operator's concession", method, platPlain, platConc)
		}

		// The operator's payable (2101) falls by exactly the concession.
		opPlain := sumPostings(plain, "2101", "CR")
		opConc := sumPostings(conc, "2101", "CR")
		if opPlain-opConc != discount {
			t.Fatalf("%s: operator payable fell by %d, want exactly the concession %d",
				method, opPlain-opConc, discount)
		}

		// Both journals balance.
		for label, ps := range map[string][]Posting{"plain": plain, "concession": conc} {
			dr, cr := drCr(ps)
			if dr != cr {
				t.Fatalf("%s %s journal unbalanced: DR=%d CR=%d", method, label, dr, cr)
			}
		}

		// The discounted journal's cash/receivable side equals what the
		// passenger actually pays: full minus the concession.
		var received int64
		if method == "CASH" {
			received = sumPostings(conc, "1001", "DR")
		} else {
			received = sumPostings(conc, "1101", "DR") + sumPostings(conc, "5102", "DR")
		}
		if received != full-discount {
			t.Fatalf("%s: journal receives %d, want the discounted total %d", method, received, full-discount)
		}
	}
}

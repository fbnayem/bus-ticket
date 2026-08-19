package httpapi

import "testing"

// A VAT invoice must total to the exact poisha the passenger paid. The retail
// fare already contains the VAT, so the tax is backed OUT of the gross, not added
// ON TOP of it. This pins that: base + vat is the gross, always, for every rate
// and every amount — and it goes red the moment the decomposition turns additive,
// which is the one way a printed challan starts disagreeing with the money.
func TestInclusiveVATNeverLosesOrInventsAPoisha(t *testing.T) {
	cases := []struct {
		gross  int64
		rateBp int
	}{
		{80000, 1500},  // ৳800 AC fare at 15% — rounds (base 695.65)
		{45000, 1500},  // a small fare
		{100000, 750},  // 7.5%
		{85000, 1500},  // full incl. service fee shape
		{1, 1500},      // one poisha, worst rounding
		{123457, 1234}, // deliberately awkward
		{50000, 0},     // exempt / non-AC: all base, no VAT
	}
	for _, c := range cases {
		base, vat := decomposeInclusiveVAT(c.gross, c.rateBp)

		// The invariant the whole document rests on.
		if base+vat != c.gross {
			t.Fatalf("gross=%d rate=%d: base %d + vat %d = %d, not the gross — "+
				"the invoice would total to a different figure than was paid",
				c.gross, c.rateBp, base, vat, base+vat)
		}
		// VAT is never negative and never exceeds the gross.
		if vat < 0 || vat > c.gross {
			t.Fatalf("gross=%d rate=%d: vat %d is out of range", c.gross, c.rateBp, vat)
		}
		// An exempt supply carries no VAT.
		if c.rateBp == 0 && vat != 0 {
			t.Fatalf("gross=%d: exempt supply must carry no VAT, got %d", c.gross, vat)
		}
		// The base, grossed back up at the rate, must round to the original —
		// proof the split is genuinely inclusive, not additive.
		if c.rateBp > 0 {
			regrossed := (base*int64(10000+c.rateBp) + 5000) / 10000
			if regrossed != c.gross {
				t.Fatalf("gross=%d rate=%d: base %d regrosses to %d, not %d — "+
					"VAT was added on top instead of backed out",
					c.gross, c.rateBp, base, regrossed, c.gross)
			}
		}
	}
}

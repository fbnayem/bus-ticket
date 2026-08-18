package commerce

import "testing"

// The on-board money model, proved as arithmetic.
//
// These are pure-function tests on purpose: the split between platform,
// operator and crew is the part of this channel that is expensive to get
// wrong, and it should be provable without a database, a bus or a conductor.
//
// The property under test is the owner's decision, stated once:
//
//	a discount eats the crew member's own commission first,
//	and only the excess falls on the operator,
//	and the platform's cut never moves.

const (
	fare  = 80000  // ৳800 published
	seats = 1
	full  = fare*seats + platformServiceFee // ৳850
	base  = full - platformServiceFee       // ৳800
)

func sum(ps []Posting, side string) int64 {
	var t int64
	for _, p := range ps {
		if p.Side == side {
			t += p.Amount
		}
	}
	return t
}

func leg(t *testing.T, ps []Posting, account string) int64 {
	t.Helper()
	var total int64
	for _, p := range ps {
		if p.Account == account {
			total += p.Amount
		}
	}
	return total
}

// A journal that does not balance is refused by the database. Catching it here
// means never seeing that refusal in production.
func assertBalanced(t *testing.T, name string, ps []Posting) {
	t.Helper()
	if dr, cr := sum(ps, "DR"), sum(ps, "CR"); dr != cr {
		t.Fatalf("%s unbalanced: DR=%d CR=%d", name, dr, cr)
	}
	for _, p := range ps {
		if p.Amount < 0 {
			t.Fatalf("%s has a negative leg: %s %s %d", name, p.Account, p.Side, p.Amount)
		}
	}
}

// The four cases that matter, chosen around the boundary where the crew member
// stops being able to absorb the discount.
func TestCrewMoneySplit(t *testing.T) {
	rule := &CommissionRule{Kind: "PCT", ValueBP: 500} // 5% of ৳800 = ৳40
	c0 := rule.CommissionFor(base)
	if c0 != 4000 {
		t.Fatalf("fixture wrong: expected ৳40 commission, got %d", c0)
	}

	cases := []struct {
		name             string
		discount         int64
		wantCrewNet      int64 // what the conductor keeps
		wantOperatorHit  int64 // what the discount actually costs the operator
	}{
		{"no discount", 0, 4000, 0},
		{"discount below commission", 2500, 1500, 0},
		{"discount exactly commission", 4000, 0, 0},
		{"discount above commission", 6000, 0, 2000},
	}

	var platformEverywhere int64 = -1

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sale := CrewPostings(full, c.discount, "op", "duty")
			assertBalanced(t, "sale", sale)

			gross, forfeit, net := CrewCommission(rule, base, c.discount)
			comm := CrewCommissionPostings(gross, forfeit, "staff", "op")
			assertBalanced(t, "commission", comm)

			// 1. The crew member keeps what the model says, and never less than nothing.
			if net != c.wantCrewNet {
				t.Errorf("crew keeps %d, want %d", net, c.wantCrewNet)
			}
			if net < 0 {
				t.Errorf("crew commission went negative: %d", net)
			}

			// 2. The platform's cut is identical in every case. This is the
			//    property the whole model rests on: a conductor negotiating at a
			//    roadside stop cannot move a number the platform reports.
			platform := leg(t, sale, "4101")
			if platformEverywhere == -1 {
				platformEverywhere = platform
			} else if platform != platformEverywhere {
				t.Errorf("platform revenue moved with the discount: %d vs %d",
					platform, platformEverywhere)
			}

			// 3. The operator's net position across BOTH journals. The sale
			//    journal takes the whole discount off them; the commission
			//    journal hands back whatever the crew forfeited. What is left is
			//    what the discount really cost the operator.
			opSale := leg(t, sale, "2101")             // credited on the sale
			opBack := leg(t, comm, "2101")             // handed back
			noDiscount := leg(t, CrewPostings(full, 0, "op", "duty"), "2101")
			hit := noDiscount - (opSale + opBack)
			if hit != c.wantOperatorHit {
				t.Errorf("discount cost the operator %d, want %d", hit, c.wantOperatorHit)
			}

			// 4. Cash in equals the published price less the discount.
			if cash := leg(t, sale, "1002"); cash != full-c.discount {
				t.Errorf("cash collected %d, want %d", cash, full-c.discount)
			}
		})
	}
}

// The ceiling: the operator may give away their entire share of the fare and
// not a poisha more. At exactly that point the journal must still balance with
// every leg positive, and the conductor must still not be out of pocket.
//
// This case is why MaxCrewDiscount exists. Written first as a 100% discount, it
// produced an operator leg of -৳130 — a posting the database would have
// refused at the moment of sale, with an error nobody on a bus could act on.
func TestCrewMoneyAtTheCeiling(t *testing.T) {
	rule := &CommissionRule{Kind: "PCT", ValueBP: 500}
	ceiling := MaxCrewDiscount(full)
	if ceiling != base-base/10 {
		t.Fatalf("ceiling %d is not the operator's share", ceiling)
	}

	sale := CrewPostings(full, ceiling, "op", "duty")
	assertBalanced(t, "sale", sale)
	if op := leg(t, sale, "2101"); op != 0 {
		t.Errorf("at the ceiling the operator should receive exactly nothing, got %d", op)
	}
	if plat := leg(t, sale, "4101"); plat != base/10+platformServiceFee {
		t.Errorf("platform cut moved at the ceiling: %d", plat)
	}

	gross, forfeit, net := CrewCommission(rule, base, ceiling)
	assertBalanced(t, "commission", CrewCommissionPostings(gross, forfeit, "staff", "op"))
	if net != 0 {
		t.Errorf("a giveaway still paid %d commission", net)
	}
}

// One poisha past the ceiling and the sale journal cannot be written at all.
// The API refuses long before this; the assertion is that the arithmetic itself
// is what makes it impossible, not a rule somebody remembered to add.
func TestCrewMoneyPastTheCeilingIsUnpostable(t *testing.T) {
	sale := CrewPostings(full, MaxCrewDiscount(full)+1, "op", "duty")
	negative := false
	for _, p := range sale {
		if p.Amount < 0 {
			negative = true
		}
	}
	if !negative {
		t.Fatal("a discount past the ceiling produced a postable journal; " +
			"the ceiling is in the wrong place")
	}
}

// No configured rule is a valid answer, and must not be a crash or a windfall.
func TestCrewCommissionWithoutRule(t *testing.T) {
	gross, forfeit, net := CrewCommission(nil, base, 5000)
	if gross != 0 || forfeit != 0 || net != 0 {
		t.Fatalf("no rule should earn nothing: gross=%d forfeit=%d net=%d", gross, forfeit, net)
	}
	assertBalanced(t, "commission", CrewCommissionPostings(gross, forfeit, "staff", "op"))
}

// A flat rule behaves the same way at the boundary.
func TestCrewCommissionFlatRule(t *testing.T) {
	rule := &CommissionRule{Kind: "FLAT", Amount: 3000} // ৳30 a sale
	_, _, net := CrewCommission(rule, base, 1000)
	if net != 2000 {
		t.Errorf("flat rule after ৳10 discount kept %d, want 2000", net)
	}
	_, _, net = CrewCommission(rule, base, 9999)
	if net != 0 {
		t.Errorf("flat rule swamped by discount kept %d, want 0", net)
	}
}

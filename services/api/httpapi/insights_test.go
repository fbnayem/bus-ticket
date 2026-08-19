package httpapi

import "testing"

// Load factor is seats-sold over seats-offered. The whole reason it is its own
// function is the empty period: no trips means no capacity, and the honest answer
// is 0% — not a divide-by-zero panic that takes the insights page down, and not a
// fabricated number. Remove the guard and the first line goes red (panic).
func TestLoadFactorHandlesEmptyPeriodAndComputes(t *testing.T) {
	if got := loadFactorPct(0, 0); got != 0 {
		t.Fatalf("empty period load factor = %d, want 0 (no capacity, no panic)", got)
	}
	if got := loadFactorPct(50, 0); got != 0 {
		t.Fatalf("sales against zero capacity = %d, want 0", got)
	}
	if got := loadFactorPct(50, 100); got != 50 {
		t.Fatalf("50 of 100 seats = %d%%, want 50%%", got)
	}
	if got := loadFactorPct(40, 40); got != 100 {
		t.Fatalf("a full bus = %d%%, want 100%%", got)
	}
	if got := loadFactorPct(1, 3); got != 33 {
		t.Fatalf("1 of 3 = %d%%, want 33%% (integer floor)", got)
	}
}

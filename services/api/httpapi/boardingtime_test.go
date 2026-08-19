package httpapi

import (
	"testing"
	"time"
)

// A ticket is read at the stop where the passenger boards, not at the trip's
// origin. On a Dhaka -> Cumilla -> Feni -> Chattogram run that leaves Dhaka at
// 22:00, someone boarding at Feni is picked up hours later; printing 22:00 on
// their ticket sends them to the counter at the wrong hour. arrivalAt is the
// one place that turns "depart + running minutes to my stop" into a wall clock,
// and this pins the property the whole fix rests on: a mid-route boarding time
// is that stop's time and is NEVER the origin departure.
func TestArrivalAtIsThePassengersOwnStopNotTheOrigin(t *testing.T) {
	depart := time.Date(2026, 8, 20, 22, 0, 0, 0, time.FixedZone("Asia/Dhaka", 6*3600))
	// offsets[k] spans stop k -> k+1: Dhaka->Cumilla 120, Cumilla->Feni 75, Feni->Ctg 105.
	offsets := map[int]int{0: 120, 1: 75, 2: 105}

	// Origin boarder (seq 0) boards exactly at departure.
	if got := arrivalAt(depart, offsets, 0); !got.Equal(depart) {
		t.Fatalf("origin boarding time = %s, want the departure %s", got, depart)
	}

	// Feni boarder (seq 2) boards 120+75 = 195 minutes after departure.
	wantFeni := depart.Add(195 * time.Minute)
	gotFeni := arrivalAt(depart, offsets, 2)
	if !gotFeni.Equal(wantFeni) {
		t.Fatalf("Feni boarding time = %s, want %s", gotFeni, wantFeni)
	}

	// The guard, stated as its own assertion: a mid-route boarding time must not
	// collapse to the origin departure. If arrivalAt ever ignores the running
	// minutes, this is what goes red.
	if gotFeni.Equal(depart) {
		t.Fatal("mid-route boarding time collapsed to the origin departure — " +
			"a Feni passenger would be told 22:00 when the bus reaches them at 01:15")
	}

	// Arrival at the final stop (seq 3) is the whole run: 120+75+105 = 300.
	if got := arrivalAt(depart, offsets, 3); !got.Equal(depart.Add(300 * time.Minute)) {
		t.Fatalf("final arrival = %s, want %s", got, depart.Add(300*time.Minute))
	}
}

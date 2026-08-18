package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/staff/staff"
)

// The owner's profit-and-loss is only worth anything if its arithmetic holds
// against real data, so these tests run against the seeded database and refuse
// to pass without one. The one property that matters — and the one a test
// reading the handler's own `gross - platform - staff` expression could never
// catch — is that the numbers RECONCILE: every bus's profit is its net fare
// minus its costs, the totals are the sum of the buses plus overhead, and
// adding a cost moves the profit by exactly that cost and not a poisha more.

const (
	greenLineOperator = "11111111-1111-1111-1111-111111111111"
	greenLineOwner    = "f0000000-0000-0000-0000-000000000011"
)

var testPool *pgxpool.Pool
var noDB bool

func TestMain(m *testing.M) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Println("DATABASE_URL not set; database-backed owner tests will skip")
		noDB = true
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var err error
	testPool, err = pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Println("pool:", err)
		os.Exit(1)
	}
	if err := testPool.Ping(ctx); err != nil {
		fmt.Println("ping:", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func requireDB(t *testing.T) {
	t.Helper()
	if noDB {
		t.Skip("DATABASE_URL not set; this proof needs a database")
	}
}

func ownerServer() *Server {
	return &Server{
		pool: testPool,
		stf:  staff.New(testPool),
		log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// ownerID is a staff identity pinned to Green Line, as the guard would have
// produced from a real token. The handlers take it directly here so the test
// does not need to mint a session.
func ownerID() *staff.Identity {
	return &staff.Identity{StaffID: greenLineOwner, OperatorID: greenLineOperator}
}

type pnlResponse struct {
	OperatorID string `json:"operator_id"`
	Buses      []struct {
		Bus       string `json:"registration"`
		Gross     int64  `json:"gross_poisha"`
		Platform  int64  `json:"platform_commission_poisha"`
		StaffComm int64  `json:"staff_commission_poisha"`
		NetFare   int64  `json:"net_fare_poisha"`
		Costs     int64  `json:"costs_poisha"`
		Profit    int64  `json:"profit_poisha"`
	} `json:"buses"`
	Overhead struct {
		Costs int64 `json:"costs_poisha"`
	} `json:"overhead"`
	Totals struct {
		Gross     int64 `json:"gross_poisha"`
		Platform  int64 `json:"platform_commission_poisha"`
		StaffComm int64 `json:"staff_commission_poisha"`
		NetFare   int64 `json:"net_fare_poisha"`
		Costs     int64 `json:"costs_poisha"`
		Profit    int64 `json:"profit_poisha"`
	} `json:"totals"`
}

func getPnl(t *testing.T, s *Server, query string) pnlResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleOwnerPnl(rec, httptest.NewRequest("GET", "/api/v1/owner/pnl"+query, nil), ownerID())
	if rec.Code != 200 {
		t.Fatalf("pnl answered %d: %s", rec.Code, rec.Body.String())
	}
	var out pnlResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("pnl body: %v", err)
	}
	return out
}

// TestOwnerPnlReconciles is the whole point: the columns must add up, per bus
// and in the totals. If the SQL ever computes net fare or profit a different
// way from the definition, this fails — which reading the Go expression back
// could never do.
func TestOwnerPnlReconciles(t *testing.T) {
	requireDB(t)
	p := getPnl(t, ownerServer(), "")
	if len(p.Buses) == 0 {
		t.Fatal("Green Line has no buses in the P&L; seed data missing")
	}

	var sumNet, sumProfit, sumGross, sumCosts int64
	for _, b := range p.Buses {
		if got, want := b.NetFare, b.Gross-b.Platform-b.StaffComm; got != want {
			t.Errorf("%s: net fare %d, but gross-platform-staff = %d", b.Bus, got, want)
		}
		if got, want := b.Profit, b.NetFare-b.Costs; got != want {
			t.Errorf("%s: profit %d, but net-costs = %d", b.Bus, got, want)
		}
		sumNet += b.NetFare
		sumProfit += b.Profit
		sumGross += b.Gross
		sumCosts += b.Costs
	}
	// The totals are the buses summed, plus operator-wide overhead in costs and
	// profit only.
	if p.Totals.Gross != sumGross {
		t.Errorf("total gross %d != sum of buses %d", p.Totals.Gross, sumGross)
	}
	if p.Totals.Costs != sumCosts+p.Overhead.Costs {
		t.Errorf("total costs %d != bus costs %d + overhead %d", p.Totals.Costs, sumCosts, p.Overhead.Costs)
	}
	if p.Totals.Profit != sumProfit-p.Overhead.Costs {
		t.Errorf("total profit %d != sum of bus profit %d - overhead %d", p.Totals.Profit, sumProfit, p.Overhead.Costs)
	}
}

// TestOwnerPnlIsOperatorScoped proves an owner cannot widen their view by
// naming another operator in the query string. If scopeOperator ever trusts the
// request over the identity, this returns the foreign operator and fails.
func TestOwnerPnlIsOperatorScoped(t *testing.T) {
	requireDB(t)
	p := getPnl(t, ownerServer(), "?operator_id=99999999-9999-9999-9999-999999999999")
	if p.OperatorID != greenLineOperator {
		t.Fatalf("a Green Line owner naming another operator saw %s", p.OperatorID)
	}
	if len(p.Buses) == 0 {
		t.Fatal("scoping returned the foreign operator's empty fleet, not Green Line's")
	}
}

// TestOwnerCostMovesProfitByExactlyItsAmount is the strongest property here: add
// a cost, and the operator's profit falls by that cost and nothing else; remove
// it, and the profit returns to exactly where it started.
func TestOwnerCostMovesProfitByExactlyItsAmount(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	before := getPnl(t, s, "").Totals.Profit

	const amount = 123456
	today := time.Now().Format("2006-01-02")
	body := fmt.Sprintf(`{"category":"OTHER","amount_poisha":%d,"incurred_on":%q,"note":"reconciliation probe"}`, amount, today)
	rec := httptest.NewRecorder()
	s.handleOwnerCostAdd(rec, httptest.NewRequest("POST", "/api/v1/owner/costs", strings.NewReader(body)), ownerID())
	if rec.Code != 200 {
		t.Fatalf("cost add answered %d: %s", rec.Code, rec.Body.String())
	}
	var added struct {
		ExpenseID string `json:"expense_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	after := getPnl(t, s, "").Totals.Profit
	if before-after != amount {
		t.Errorf("adding a %d cost moved profit by %d", amount, before-after)
	}

	// Clean up, and confirm the profit comes all the way back.
	del := httptest.NewRecorder()
	req := httptest.NewRequest("DELETE", "/api/v1/owner/costs/"+added.ExpenseID, nil)
	req.SetPathValue("id", added.ExpenseID)
	s.handleOwnerCostDelete(del, req, ownerID())
	if del.Code != 200 {
		t.Fatalf("cost delete answered %d: %s", del.Code, del.Body.String())
	}
	if restored := getPnl(t, s, "").Totals.Profit; restored != before {
		t.Errorf("after removing the cost, profit is %d, not the original %d", restored, before)
	}
}

// TestOwnerCostRejectsBadInput proves the validation refuses rather than clamps.
func TestOwnerCostRejectsBadInput(t *testing.T) {
	requireDB(t)
	s := ownerServer()
	cases := []struct {
		name, body string
		want       int
	}{
		{"bad category", `{"category":"BRIBE","amount_poisha":100,"incurred_on":"2026-08-17"}`, 400},
		{"zero amount", `{"category":"FUEL","amount_poisha":0,"incurred_on":"2026-08-17"}`, 400},
		{"negative amount", `{"category":"FUEL","amount_poisha":-100,"incurred_on":"2026-08-17"}`, 400},
		{"no date", `{"category":"FUEL","amount_poisha":100}`, 400},
		{"foreign bus", `{"bus_id":"d0000000-0000-0000-0000-000000000002","category":"FUEL","amount_poisha":100,"incurred_on":"2026-08-17"}`, 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			s.handleOwnerCostAdd(rec, httptest.NewRequest("POST", "/api/v1/owner/costs", strings.NewReader(c.body)), ownerID())
			if rec.Code != c.want {
				t.Errorf("%s: answered %d, want %d (%s)", c.name, rec.Code, c.want, rec.Body.String())
			}
		})
	}
}

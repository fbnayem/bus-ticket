package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/staff/staff"
	"github.com/busticket/platform/services/wallet/wallet"
)

// The agent portal API.
//
// An agent sale is two atomic acquisitions that must both succeed: the seat
// (inventory-service) and the money (wallet). Order matters. Seats first,
// wallet second, because a seat that cannot be paid for is released in
// seconds by the expiry sweeper, whereas money committed against a seat that
// was never acquired is a refund and a phone call.

func (s *Server) agentRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/agent/wallet", s.guard("agent.read", s.handleAgentWallet))
	m.HandleFunc("GET /api/v1/agent/transactions", s.guard("agent.read", s.handleAgentTransactions))
	m.HandleFunc("POST /api/v1/agent/sales", s.guard("wallet.sell", s.handleAgentSale))
	m.HandleFunc("GET /api/v1/agent/bookings", s.guard("booking.read", s.handleAgentBookings))
	m.HandleFunc("GET /api/v1/agent/commissions", s.guard("agent.read", s.handleAgentCommissions))
	m.HandleFunc("GET /api/v1/agent/recharges", s.guard("agent.read", s.handleListRecharges))
	m.HandleFunc("POST /api/v1/agent/recharges", s.guard("wallet.recharge", s.handleRequestRecharge))
	m.HandleFunc("POST /api/v1/agent/recharges/{rechargeID}/approve",
		s.guard("wallet.approve", s.handleApproveRecharge))
}

func agencyOf(id *staff.Identity, requested string) (string, error) {
	if id.AgencyID != "" {
		return id.AgencyID, nil
	}
	if requested != "" && (id.Can("agent.read") || id.Can("wallet.approve")) {
		return requested, nil
	}
	return "", errors.New("this account is not attached to an agency")
}

func (s *Server) handleAgentWallet(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	agencyID, err := agencyOf(id, r.URL.Query().Get("agency_id"))
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	wal, err := s.wal.Get(r.Context(), agencyID)
	if errors.Is(err, wallet.ErrNotFound) {
		fail(w, 404, "no_wallet", "No wallet exists for this agency.")
		return
	}
	if err != nil {
		fail(w, 500, "query_failed", "Could not load the wallet.")
		return
	}

	// The cache is shown next to the recomputation. If they ever disagree, the
	// portal says so rather than quietly displaying a number nobody can defend.
	recAvail, recHeld, rerr := s.wal.Recompute(r.Context(), wal.WalletID)
	// Same reason as the counter: the agent portal was assembling the sale total
	// from its own copy of the fee, and an agent sells against a credit limit
	// off that number.
	out := map[string]any{"wallet": wal, "service_fee_poisha": serviceFeePoisha}
	if rerr == nil {
		out["recomputed"] = map[string]any{
			"available_poisha": recAvail, "held_poisha": recHeld,
			"matches": recAvail == wal.Available && recHeld == wal.Held,
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleAgentTransactions(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	agencyID, err := agencyOf(id, r.URL.Query().Get("agency_id"))
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT t.txn_id, t.kind, t.delta_poisha, COALESCE(b.pnr,''), COALESCE(t.note,''), t.created_at
		  FROM agent.wallet_transactions t
		  JOIN agent.wallets w ON w.wallet_id = t.wallet_id
		  LEFT JOIN commerce.bookings b ON b.booking_id = t.booking_id
		 WHERE w.agency_id = $1::uuid
		 ORDER BY t.txn_id DESC LIMIT 100`, agencyID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load transactions.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var txnID, delta int64
		var kind, pnr, note string
		var at time.Time
		if err := rows.Scan(&txnID, &kind, &delta, &pnr, &note, &at); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"txn_id": txnID, "kind": kind, "delta_poisha": delta,
			"pnr": pnr, "note": note, "created_at": at,
		})
	}
	writeJSON(w, 200, map[string]any{"transactions": out})
}

type agentSaleRequest struct {
	TripID     string        `json:"trip_id"`
	Seats      []string      `json:"seats"`
	BoardSeq   int           `json:"board_seq"`
	DropSeq    int           `json:"drop_seq"`
	Passengers []passengerIn `json:"passengers"`
	Phone      string        `json:"phone"`
}

func (s *Server) handleAgentSale(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	ctx := r.Context()
	agencyID, err := agencyOf(id, "")
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	var req agentSaleRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if len(req.Seats) == 0 {
		fail(w, 400, "no_seats", "Choose at least one seat.")
		return
	}
	if req.Phone == "" {
		fail(w, 400, "phone_required", "Take the passenger's mobile number.")
		return
	}

	fare, err := s.fareFor(r, req.TripID, req.BoardSeq, req.DropSeq)
	if err != nil {
		fail(w, 400, "no_fare", "No fare is published for that journey.")
		return
	}
	total := fare*int64(len(req.Seats)) + serviceFeePoisha

	// 1. Seats. The same inventory service, the same conditional UPDATE.
	hold, err := s.inv.AcquireHold(ctx, inventory.HoldRequest{
		TripID: req.TripID, Seats: req.Seats,
		BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "AGENT", SessionRef: agencyID, TTL: 5 * time.Minute,
		PriceSnapshot: []byte(fmt.Sprintf(
			`{"fare_poisha":%d,"seats":%d,"total_poisha":%d}`, fare, len(req.Seats), total)),
	})
	if errors.Is(err, inventory.ErrSeatUnavailable) {
		fail(w, 409, "seat_taken", "One of those seats has just gone. Refresh and try again.")
		return
	}
	if err != nil {
		s.log.Error("agent hold", "err", err)
		fail(w, 500, "hold_failed", "Those seats could not be held.")
		return
	}

	// 2. Money. One conditional UPDATE against spending power. If it fails the
	// seats go straight back — the passenger standing at the desk never sees a
	// seat vanish for a sale that could not be paid for.
	walletHoldID, err := s.wal.Hold(ctx, agencyID, total, hold.HoldID)
	if errors.Is(err, wallet.ErrInsufficient) {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "WALLET_INSUFFICIENT")
		fail(w, 402, "insufficient_balance",
			"Not enough balance or credit for this sale. Recharge the wallet and try again.")
		return
	}
	if err != nil {
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "WALLET_ERROR")
		s.log.Error("wallet hold", "err", err)
		fail(w, 500, "wallet_failed", "The wallet could not be charged. No seats were taken.")
		return
	}

	var operatorID string
	if err := s.pool.QueryRow(ctx,
		`SELECT operator_id::text FROM catalog.trips WHERE trip_id=$1::uuid`, req.TripID).Scan(&operatorID); err != nil {
		_ = s.wal.Release(ctx, walletHoldID, "TRIP_LOOKUP_FAILED")
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "TRIP_LOOKUP_FAILED")
		fail(w, 500, "query_failed", "Could not load the trip.")
		return
	}

	bookingID, pnr, err := s.com.CreateBooking(ctx, commerce.BookingRequest{
		HoldID: hold.HoldID, TripID: req.TripID, OperatorID: operatorID,
		Seats: hold.Seats, BoardSeq: req.BoardSeq, DropSeq: req.DropSeq,
		Channel: "AGENT", TotalPoisha: total,
	})
	if err != nil {
		_ = s.wal.Release(ctx, walletHoldID, "BOOKING_FAILED")
		_ = s.inv.ReleaseHold(ctx, hold.HoldID, "BOOKING_FAILED")
		s.log.Error("agent booking", "err", err)
		fail(w, 500, "booking_failed", "The booking could not be created.")
		return
	}
	s.attributeSale(ctx, bookingID, "", agencyID, id.StaffID)
	s.savePassengers(ctx, bookingID, req.Passengers, req.Phone, "")

	// 3. Capture, ticket, commission.
	if err := s.wal.Capture(ctx, walletHoldID, bookingID); err != nil {
		s.log.Error("wallet capture", "err", err)
		fail(w, 500, "capture_failed", "The wallet charge failed. Nothing has been issued.")
		return
	}
	commission, err := s.com.SettleAgentSale(ctx, bookingID, agencyID, walletHoldID)
	if err != nil {
		s.log.Error("agent settle", "err", err)
		failRef(w, 500, "settle_failed",
			"The ticket could not be issued. Contact support with this PNR: "+pnr, pnr)
		return
	}
	if commission > 0 {
		if wal, e := s.wal.Get(ctx, agencyID); e == nil {
			_ = s.wal.Credit(ctx, wal.WalletID, "COMMISSION", commission, bookingID, "sale commission")
		}
	}
	s.stf.Audit(ctx, id, "agent.sale", "booking:"+pnr, nil)

	wal, _ := s.wal.Get(ctx, agencyID)
	writeJSON(w, 201, map[string]any{
		"booking_id": bookingID, "pnr": pnr, "seats": hold.Seats,
		"total_poisha": total, "commission_poisha": commission,
		"wallet": wal, "tickets": s.ticketsFor(ctx, bookingID),
	})
}

func (s *Server) handleAgentBookings(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	agencyID, err := agencyOf(id, r.URL.Query().Get("agency_id"))
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, b.status, b.total_poisha, b.created_at, t.depart_at, o.brand,
		       (SELECT string_agg(seat_no, ',' ORDER BY seat_no)
		          FROM commerce.booking_seats bs WHERE bs.booking_id = b.booking_id),
		       COALESCE(c.amount_poisha, 0),
		       COALESCE((SELECT full_name FROM commerce.booking_passengers p
		                  WHERE p.booking_id = b.booking_id LIMIT 1), '')
		  FROM commerce.bookings b
		  JOIN catalog.trips t ON t.trip_id = b.trip_id
		  JOIN catalog.operators o ON o.operator_id = b.operator_id
		  LEFT JOIN agent.commissions c ON c.booking_id = b.booking_id
		 WHERE b.agency_id = $1::uuid
		 ORDER BY b.created_at DESC LIMIT 60`, agencyID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load bookings.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pnr, status, brand, passenger string
		var seats *string
		var total, commission int64
		var created, depart time.Time
		if err := rows.Scan(&pnr, &status, &total, &created, &depart, &brand,
			&seats, &commission, &passenger); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"pnr": pnr, "status": status, "total_poisha": total, "created_at": created,
			"depart_at": depart, "operator": brand, "seats": deref(seats),
			"commission_poisha": commission, "passenger": passenger,
		})
	}
	writeJSON(w, 200, map[string]any{"bookings": out})
}

func (s *Server) handleAgentCommissions(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	agencyID, err := agencyOf(id, r.URL.Query().Get("agency_id"))
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	var total, count int64
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(sum(amount_poisha),0), count(*) FROM agent.commissions
		 WHERE agency_id = $1::uuid`, agencyID).Scan(&total, &count)

	rows, err := s.pool.Query(r.Context(), `
		SELECT b.pnr, c.amount_poisha, c.created_at,
		       COALESCE(cr.kind,''), COALESCE(cr.value_bp,0)
		  FROM agent.commissions c
		  JOIN commerce.bookings b ON b.booking_id = c.booking_id
		  LEFT JOIN agent.commission_rules cr ON cr.rule_id = c.rule_id
		 WHERE c.agency_id = $1::uuid ORDER BY c.created_at DESC LIMIT 60`, agencyID)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load commissions.")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var pnr, kind string
		var amount int64
		var bp int
		var at time.Time
		if err := rows.Scan(&pnr, &amount, &at, &kind, &bp); err != nil {
			continue
		}
		items = append(items, map[string]any{
			"pnr": pnr, "amount_poisha": amount, "created_at": at,
			"rule_kind": kind, "rule_bp": bp,
		})
	}
	writeJSON(w, 200, map[string]any{
		"total_poisha": total, "count": count, "commissions": items,
	})
}

type rechargeRequest struct {
	AmountPoisha int64  `json:"amount_poisha"`
	Method       string `json:"method"`
	Reference    string `json:"reference"`
}

func (s *Server) handleRequestRecharge(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	agencyID, err := agencyOf(id, "")
	if err != nil {
		fail(w, 403, "no_agency", "This account is not attached to an agency.")
		return
	}
	var req rechargeRequest
	if err := decode(r, &req); err != nil {
		fail(w, 400, "bad_request", "That request could not be read.")
		return
	}
	if req.AmountPoisha <= 0 {
		fail(w, 400, "bad_amount", "Enter the amount you have sent.")
		return
	}
	rid, err := s.wal.RequestRecharge(r.Context(), agencyID, req.AmountPoisha, req.Method, req.Reference, id.StaffID)
	if err != nil {
		s.log.Error("recharge request", "err", err)
		fail(w, 500, "recharge_failed", "The recharge could not be recorded.")
		return
	}
	s.stf.Audit(r.Context(), id, "agent.recharge.request", "recharge:"+rid, nil)
	// Deliberately explicit: the balance has not moved yet.
	writeJSON(w, 201, map[string]any{
		"recharge_id": rid, "status": "REQUESTED",
		"message": "Recorded. The balance updates when finance approves it.",
	})
}

func (s *Server) handleListRecharges(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	// Finance staff see every pending recharge; an agent sees only their own.
	agencyFilter := id.AgencyID
	rows, err := s.pool.Query(r.Context(), `
		SELECT rc.recharge_id::text, a.name, rc.amount_poisha, rc.method,
		       COALESCE(rc.reference,''), rc.status, rc.created_at,
		       req.full_name, COALESCE(app.full_name,'')
		  FROM agent.recharges rc
		  JOIN agent.wallets wl ON wl.wallet_id = rc.wallet_id
		  JOIN agent.agencies a ON a.agency_id = wl.agency_id
		  JOIN staff.staff_users req ON req.staff_id = rc.requested_by
		  LEFT JOIN staff.staff_users app ON app.staff_id = rc.approved_by
		 WHERE ($1 = '' OR wl.agency_id = $1::uuid)
		 ORDER BY rc.created_at DESC LIMIT 50`, agencyFilter)
	if err != nil {
		fail(w, 500, "query_failed", "Could not load recharges.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, agency, method, reference, status, requester, approver string
		var amount int64
		var at time.Time
		if err := rows.Scan(&rid, &agency, &amount, &method, &reference,
			&status, &at, &requester, &approver); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"recharge_id": rid, "agency": agency, "amount_poisha": amount,
			"method": method, "reference": reference, "status": status,
			"created_at": at, "requested_by": requester, "approved_by": approver,
		})
	}
	writeJSON(w, 200, map[string]any{"recharges": out})
}

func (s *Server) handleApproveRecharge(w http.ResponseWriter, r *http.Request, id *staff.Identity) {
	rid := r.PathValue("rechargeID")
	if err := s.wal.ApproveRecharge(r.Context(), rid, id.StaffID); err != nil {
		// The most common cause is the maker trying to be the checker.
		fail(w, 409, "approval_refused", err.Error())
		return
	}
	s.stf.Audit(r.Context(), id, "agent.recharge.approve", "recharge:"+rid, nil)
	writeJSON(w, 200, map[string]any{"recharge_id": rid, "status": "APPROVED"})
}

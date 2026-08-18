// Package httpapi is the public REST surface under /api/v1/.
//
// Every mutation accepts an Idempotency-Key, every request carries a request_id
// that is echoed back and logged, and errors are a single machine-readable
// shape so the web app never has to parse prose.
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/analytics/analytics"
	"github.com/busticket/platform/services/api/eventwire"
	"github.com/busticket/platform/services/commerce/commerce"
	"github.com/busticket/platform/services/events/events"
	"github.com/busticket/platform/services/identity/identity"
	"github.com/busticket/platform/services/inventory/inventory"
	"github.com/busticket/platform/services/notify/notify"
	"github.com/busticket/platform/services/ops/ops"
	"github.com/busticket/platform/services/partner/partner"
	"github.com/busticket/platform/services/platform/cache"
	"github.com/busticket/platform/services/promo/promo"
	"github.com/busticket/platform/services/recon/recon"
	"github.com/busticket/platform/services/risk/risk"
	"github.com/busticket/platform/services/searchidx/searchidx"
	"github.com/busticket/platform/services/staff/staff"
	"github.com/busticket/platform/services/wallet/wallet"
)

// Deps is every service this process fronts. It is a struct rather than a
// fifteen-argument constructor because the list only grows, and because a
// mis-ordered pair of same-typed arguments is a bug the compiler cannot see.
type Deps struct {
	Pool      *pgxpool.Pool
	Inventory *inventory.Store
	Commerce  *commerce.Service
	Staff     *staff.Service
	Wallet    *wallet.Store
	Identity  *identity.Service
	Search    *searchidx.Indexer
	Notify    *notify.Service
	Events    *events.Bus
	Wire      *eventwire.Wiring
	Analytics *analytics.Store
	Ops       *ops.Service
	Partner   *partner.Service
	Promo     *promo.Store
	Risk      *risk.Service
	Recon     *recon.Service
	Cache     *cache.Client
	Log       *slog.Logger
}

type Server struct {
	pool  *pgxpool.Pool
	inv   *inventory.Store
	com   *commerce.Service
	stf   *staff.Service
	wal   *wallet.Store
	ident *identity.Service
	idx   *searchidx.Indexer
	ntf   *notify.Service
	bus   *events.Bus
	wire  *eventwire.Wiring
	stats *analytics.Store
	occ   *ops.Service
	prt   *partner.Service
	promo *promo.Store
	risk  *risk.Service
	recon *recon.Service
	cache *cache.Client
	log   *slog.Logger
	mux   *http.ServeMux
}

func NewServer(d Deps) *Server {
	s := &Server{
		pool: d.Pool, inv: d.Inventory, com: d.Commerce, stf: d.Staff, wal: d.Wallet,
		ident: d.Identity, idx: d.Search, ntf: d.Notify, bus: d.Events, wire: d.Wire,
		stats: d.Analytics, occ: d.Ops, prt: d.Partner, promo: d.Promo, risk: d.Risk,
		recon: d.Recon, cache: d.Cache, log: d.Log, mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /api/v1/health", s.handleHealth)

	// discovery
	m.HandleFunc("GET /api/v1/locations", s.handleLocations)
	m.HandleFunc("GET /api/v1/search", s.handleSearch)
	m.HandleFunc("GET /api/v1/trips/{tripID}", s.handleTrip)
	m.HandleFunc("GET /api/v1/trips/{tripID}/seatmap", s.handleSeatMap)
	m.HandleFunc("GET /api/v1/offers", s.handleOffers)

	// booking flow
	m.HandleFunc("POST /api/v1/holds", s.handleCreateHold)
	m.HandleFunc("GET /api/v1/holds/{holdID}", s.handleGetHold)
	m.HandleFunc("DELETE /api/v1/holds/{holdID}", s.handleReleaseHold)
	m.HandleFunc("POST /api/v1/bookings", s.handleCreateBooking)
	m.HandleFunc("GET /api/v1/bookings/{pnr}", s.handleGetBooking)

	// payment — the browser never confirms; the webhook does
	m.HandleFunc("POST /api/v1/payments/intent", s.handlePaymentIntent)
	m.HandleFunc("POST /api/v1/payments/sandbox/complete", s.handleSandboxComplete)
	m.HandleFunc("POST /api/v1/payments/webhooks/{provider}", s.handleWebhook)

	// post-booking
	m.HandleFunc("GET /api/v1/bookings/{pnr}/cancellation-quote", s.handleCancellationQuote)
	m.HandleFunc("POST /api/v1/bookings/{pnr}/cancel", s.handleCancel)
	m.HandleFunc("POST /api/v1/bookings/{pnr}/settle-refund", s.handleSettleRefund)
	m.HandleFunc("GET /api/v1/bookings/{pnr}/reschedule-options", s.handleRescheduleOptions)
	m.HandleFunc("POST /api/v1/bookings/{pnr}/reschedule", s.handleReschedule)
	m.HandleFunc("GET /api/v1/tracking/{pnr}", s.handleTracking)

	// account — now behind real passenger authentication
	m.HandleFunc("GET /api/v1/account/bookings", s.handleAccountBookings)
	m.HandleFunc("GET /api/v1/account/passengers", s.handleSavedPassengers)
	m.HandleFunc("POST /api/v1/account/passengers", s.handleAddSavedPassenger)
	m.HandleFunc("PATCH /api/v1/account/passengers/{id}", s.handleUpdateSavedPassenger)
	m.HandleFunc("DELETE /api/v1/account/passengers/{id}", s.handleDeleteSavedPassenger)
	m.HandleFunc("GET /api/v1/account/profile", s.handleProfile)

	s.authRoutes(m)
	s.staffRoutes(m)
	s.counterRoutes(m)
	s.agentRoutes(m)
	s.operatorRoutes(m)
	s.adminRoutes(m)
	s.helpdeskRoutes(m)
	s.driverRoutes(m)
	s.crewRoutes(m)
	s.platformRoutes(m)
	s.clientErrorRoutes(m)
	s.partnerRoutes(m)
}

// ------------------------------------------------------------------- guard --

// authed is a handler that has already been given a verified identity, so it
// never has to parse a token or re-check a role.
type authed func(http.ResponseWriter, *http.Request, *staff.Identity)

// guard authenticates the bearer token and checks one permission.
//
// Authorisation is a single call here and a row in catalog.role_permissions
// there. No handler in this package tests a role name — adding a role is an
// INSERT, and this function keeps it that way.
func (s *Server) guard(perm string, h authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := s.stf.Authenticate(r.Context(), bearer(r))
		if err != nil {
			fail(w, 401, "unauthenticated", "Your session has ended. Please sign in again.")
			return
		}
		if perm != "" && !id.Can(perm) {
			fail(w, 403, "forbidden", "Your role does not include permission to do that.")
			return
		}
		h(w, r, id)
	}
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return h[7:]
	}
	return ""
}

// scopeOperator returns the operator a staff member may act for. Platform
// staff may name one; operator staff are pinned to their own and cannot widen
// it by passing a query parameter.
func scopeOperator(id *staff.Identity, requested string) string {
	if id.OperatorID != "" {
		return id.OperatorID
	}
	return requested
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	reqID := r.Header.Get("X-Request-Id")
	if reqID == "" {
		reqID = randomID()
	}
	w.Header().Set("X-Request-Id", reqID)

	// The web app is served from a different origin in development.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key,X-Request-Id,Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rec := &statusRecorder{ResponseWriter: w, status: 200}

	// A panic in one handler used to take the whole API down with it: a nil map
	// on an admin screen nobody visits, and every passenger mid-checkout loses
	// their seat hold. One request failing is a bug; one request killing the
	// process is an outage, and they should not be the same event.
	//
	// The recovery is deliberately narrow. It does not pretend the request
	// succeeded — the caller gets a 500 with the request id, which is the same
	// id in the log line carrying the stack — and it does not swallow anything:
	// the stack is logged at error level with the route that produced it.
	defer func() {
		v := recover()
		if v == nil {
			s.log.Info("request",
				"method", r.Method, "path", r.URL.Path, "status", rec.status,
				"ms", time.Since(start).Milliseconds(), "request_id", reqID)
			return
		}
		s.log.Error("panic",
			"method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(v),
			"stack", string(debug.Stack()), "request_id", reqID,
			"ms", time.Since(start).Milliseconds())
		// If the handler already began writing, the status is on the wire and a
		// second WriteHeader would only log a superfluous-call warning over the
		// top of the real one.
		if !rec.wrote {
			failRef(w, http.StatusInternalServerError, "internal_error",
				"Something went wrong at our end. Quote this reference if you contact us.",
				reqID)
		}
	}()

	s.mux.ServeHTTP(rec, r)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	// wrote records that a status has actually reached the client, so the panic
	// handler above knows whether a 500 can still be sent or would just be
	// shouting after the response has left.
	wrote bool
}

func (r *statusRecorder) WriteHeader(c int) {
	r.status = c
	r.wrote = true
	r.ResponseWriter.WriteHeader(c)
}

// Write marks the response as begun even when a handler never called
// WriteHeader explicitly — net/http sends an implicit 200 on the first write,
// and a panic after that point cannot be turned into a 500 either.
func (r *statusRecorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.ResponseWriter.Write(b)
}

// ------------------------------------------------------------------ helpers --

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
	// A datum the reader has to act on, carried as data rather than buried in
	// the prose. Message is written in one language and the interface speaks
	// two; a PNR somebody must quote to support is needed in both.
	Ref string `json:"ref,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fail returns a machine-readable code plus a message written for a passenger,
// not for a log file. The web app shows the message verbatim.
func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: code, Message: msg})
}

// failRef is fail for refusals that carry something the reader needs to keep —
// a PNR to quote, a reference to chase. The interface translates by code, so
// anything left only inside msg is lost the moment the reader is not English.
func failRef(w http.ResponseWriter, status int, code, msg, ref string) {
	writeJSON(w, status, apiError{Error: code, Message: msg, Ref: ref})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func randomID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.pool.Ping(r.Context()); err != nil {
		fail(w, http.StatusServiceUnavailable, "db_unavailable", "The database is not reachable.")
		return
	}
	writeJSON(w, 200, map[string]any{"status": "ok", "time": time.Now().UTC()})
}

// normalise lowercases and trims a user-typed place name so it can be matched
// against catalog.location_aliases. "CTG", " Chittagong " and "chattogram" all
// resolve to one canonical location id.
func normalise(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

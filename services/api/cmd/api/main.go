// Command api serves the public REST surface and every staff channel.
//
// It also runs the background work the platform needs regardless of who is
// calling it: the hold-expiry sweeper (PostgreSQL is the authority on expiry),
// the rolling trip generator, the event relay and its consumer groups, the
// search indexer, the operations alert detector, the partner webhook
// dispatcher, and the live-metrics refresh.
//
// In the target topology these are separate deployables. They are goroutines
// here because there is one process; each one is a package with its own
// interface, so splitting them apart is a deployment change rather than a
// rewrite.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/busticket/platform/services/analytics/analytics"
	"github.com/busticket/platform/services/api/eventwire"
	"github.com/busticket/platform/services/api/httpapi"
	"github.com/busticket/platform/services/api/tripgen"
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

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	dsn := env("DATABASE_URL", "postgres://platform:platform@localhost:55440/platform?sslmode=disable")
	addr := env("API_ADDR", ":8080")
	redisAddr := env("REDIS_ADDR", "localhost:56390")
	horizon, _ := strconv.Atoi(env("TRIP_HORIZON_DAYS", "14"))

	// Secrets. In development these fall back to well-known values so the stack
	// runs with no configuration. In production that is a forgery kit: the QR
	// signing key opens every door, the webhook secret confirms any payment, the
	// intent secret authorises any charge. So when APP_ENV=production, a secret
	// left at its dev default is a refusal to start, not a warning to ignore —
	// the one failure mode that must never reach a passenger is the one nobody
	// noticed. The check is fail-closed and it is here, before anything binds a
	// port, so a misconfigured deploy dies loudly at boot rather than quietly
	// serving forgeable tokens.
	production := env("APP_ENV", "development") == "production"
	qrKey := requireSecret(log, production, "QR_SIGNING_KEY", "dev-qr-signing-key-v1")
	hookSecret := requireSecret(log, production, "WEBHOOK_SECRET", "provider-webhook-secret")
	intentSecret := requireSecret(log, production, "PAYMENT_INTENT_SECRET", "sandbox-intent-secret")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Error("bad DATABASE_URL", "err", err)
		os.Exit(1)
	}
	cfg.MaxConns = 40
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Error("database pool", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Wait for the database rather than crash-looping on a cold start.
	for i := 0; i < 30; i++ {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		log.Warn("waiting for database", "attempt", i+1)
		time.Sleep(time.Second)
	}
	if err != nil {
		log.Error("database unreachable", "err", err)
		os.Exit(1)
	}

	// Redis accelerates; it is never the only copy of anything. If it is not
	// there, searches get slower and rate limits fall back to counting rows.
	redis := cache.New(redisAddr)
	if err := redis.Ping(ctx); err != nil {
		log.Warn("redis unavailable — search will not be cached and rate limits fall back to PostgreSQL",
			"addr", redisAddr)
	} else {
		log.Info("redis connected", "addr", redisAddr)
	}

	inv := inventory.New(pool)
	com := commerce.New(pool, inv, qrKey, hookSecret)
	stf := staff.New(pool)
	wal := wallet.New(pool)

	idx := searchidx.New(pool, redis)
	ntf := notify.New(pool, log, eventwire.NewResolver(pool))
	ident := identity.New(pool, redis, eventwire.NewCourier(ntf))
	stats := analytics.New(pool)
	occ := ops.New(pool, seatMover{inv})
	prt := partner.New(pool, log)
	prm := promo.New(pool)
	rsk := risk.New(pool)
	rcn := recon.New(pool)

	bus := events.New(pool, log)
	wire := eventwire.New(pool, log, ntf, idx)
	wire.Attach(stats, occ, prt, prm)
	wire.Register(bus)

	// Materialise trips so search has something to return, then build the
	// projection search actually reads.
	gen := tripgen.New(pool, inv)
	if res, err := gen.Generate(ctx, horizon); err != nil {
		log.Error("trip generation failed", "err", err)
	} else {
		log.Info("trips generated", "trips", res.TripsCreated, "seats", res.SeatsOpened, "days", res.DaysAhead)
	}
	if legs, err := idx.Reindex(ctx, horizon); err != nil {
		log.Error("search reindex failed", "err", err)
	} else {
		log.Info("search index built", "legs", legs)
	}

	// The expiry sweeper. Redis mirrors hold deadlines for latency, but this is
	// what actually guarantees a seat is never stranded by cache loss.
	every(ctx, 15*time.Second, func() {
		n, err := inv.SweepExpired(ctx, 500)
		if err != nil {
			log.Warn("sweep failed", "err", err)
		} else if n > 0 {
			log.Info("holds expired", "released", n)
		}
	})

	// The event backbone: relay every producer's outbox into the log, then walk
	// each consumer group forward.
	go bus.Run(ctx, 2*time.Second, 200)

	// Operational alerting. Six of the seven alert types are about something
	// that did not happen, and absence produces no event to react to.
	every(ctx, 30*time.Second, func() {
		if _, err := occ.Scan(ctx, ops.DefaultThresholds()); err != nil {
			log.Warn("alert scan failed", "err", err)
		}
	})

	// Partner webhook delivery, with its own backoff schedule.
	every(ctx, 10*time.Second, func() {
		d, f, dead, err := prt.Dispatch(ctx, 100)
		if err != nil {
			log.Warn("webhook dispatch failed", "err", err)
		} else if d > 0 || dead > 0 {
			log.Info("partner webhooks", "delivered", d, "retrying", f, "dead", dead)
		}
	})

	// The live dashboard, recomputed once for everyone watching it.
	every(ctx, 20*time.Second, func() {
		if err := stats.Refresh(ctx); err != nil {
			log.Warn("live metrics failed", "err", err)
		}
	})

	// Extend the trip horizon, and re-project search behind it.
	every(ctx, 6*time.Hour, func() {
		if res, err := gen.Generate(ctx, horizon); err == nil && res.TripsCreated > 0 {
			log.Info("trips generated", "trips", res.TripsCreated)
		}
		if _, err := idx.Reindex(ctx, horizon); err != nil {
			log.Warn("search reindex failed", "err", err)
		}
	})

	srv := &http.Server{
		Addr: addr,
		Handler: httpapi.NewServer(httpapi.Deps{
			Pool: pool, Inventory: inv, Commerce: com, Staff: stf, Wallet: wal,
			Identity: ident, Search: idx, Notify: ntf, Events: bus, Wire: wire,
			Analytics: stats, Ops: occ, Partner: prt, Promo: prm, Risk: rsk,
			Recon: rcn, Cache: redis, Log: log, IntentSecret: intentSecret,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	go func() {
		log.Info("api listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

// every runs f on a ticker until the context ends.
func every(ctx context.Context, d time.Duration, f func()) {
	go func() {
		t := time.NewTicker(d)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				f()
			}
		}
	}()
}

// seatMover adapts the inventory store to the narrow interface the operations
// control centre is allowed to hold. The console decides which seat a displaced
// passenger should get; it never decides whether taking that seat is safe.
type seatMover struct{ inv *inventory.Store }

func (m seatMover) Reassign(ctx context.Context, holdID, oldSeat, newSeat string) error {
	return m.inv.Reassign(ctx, holdID, oldSeat, newSeat)
}

func (m seatMover) WithdrawSeat(ctx context.Context, tripID, seatNo string) error {
	return m.inv.WithdrawSeat(ctx, tripID, seatNo)
}

func (m seatMover) AddSeats(ctx context.Context, tripID string, seats []ops.SeatSpec) (int, error) {
	converted := make([]inventory.SeatSpec, 0, len(seats))
	for _, s := range seats {
		converted = append(converted, inventory.SeatSpec{
			SeatNo: s.SeatNo, SeatType: s.SeatType, FareClass: s.FareClass,
			Deck: s.Deck, Row: s.Row, Col: s.Col,
		})
	}
	return m.inv.AddSeats(ctx, tripID, converted)
}

func (m seatMover) FreeSeats(ctx context.Context, tripID string, boardSeq, dropSeq int) ([]string, error) {
	return m.inv.FreeSeats(ctx, tripID, boardSeq, dropSeq)
}

func (m seatMover) SeatsFromLayout(ctx context.Context, layoutID string) ([]ops.SeatSpec, error) {
	seats, err := m.inv.SeatsFromLayout(ctx, layoutID)
	if err != nil {
		return nil, err
	}
	out := make([]ops.SeatSpec, 0, len(seats))
	for _, s := range seats {
		out = append(out, ops.SeatSpec{
			SeatNo: s.SeatNo, SeatType: s.SeatType, FareClass: s.FareClass,
			Deck: s.Deck, Row: s.Row, Col: s.Col,
		})
	}
	return out, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// requireSecret returns the configured secret, and in production refuses to
// return a dev default. A secret left unset or at its shipped placeholder is
// not a warning to log and carry on from — it is a forgeable token generator,
// so the process exits here, at boot, before it can bind a port and start
// signing anything. In development the default is returned as-is so the stack
// runs with no setup.
func requireSecret(log *slog.Logger, production bool, key, devDefault string) []byte {
	v := os.Getenv(key)
	if production && (v == "" || v == devDefault) {
		log.Error("refusing to start: secret is unset or at its development default in production",
			"key", key)
		os.Exit(1)
	}
	if v == "" {
		v = devDefault
	}
	return []byte(v)
}

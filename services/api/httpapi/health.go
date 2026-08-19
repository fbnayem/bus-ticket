package httpapi

import (
	"context"
	"net/http"
	"runtime/debug"
	"time"
)

// Liveness and readiness are different questions, and Kubernetes asks them with
// different consequences. Liveness — "is this process wedged?" — a false answer
// gets the pod killed. Readiness — "should traffic come here right now?" — a
// false answer takes the pod out of the load-balancer but leaves it running.
// Conflating them (the old /health did, and only ever checked the database) means
// a blip in a dependency either needlessly restarts a healthy process or, worse,
// routes passengers to an instance that cannot reach the cache the seat holds and
// search both depend on.

type depCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// ready is the whole gate in one line: an instance is ready only if EVERY
// dependency it needs is reachable. One unreachable dependency is enough to pull
// it from rotation — that is the point of readiness, and the property this
// function must never soften.
func ready(checks []depCheck) bool {
	for _, c := range checks {
		if !c.OK {
			return false
		}
	}
	return true
}

// handleLive answers liveness. The process is serving HTTP, so by definition it
// is alive; this checks no dependency, because a dead database must not restart a
// perfectly healthy API pod.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"status": "live"})
}

// handleReady answers readiness by actually reaching each dependency.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	checks := []depCheck{}
	dbOK := s.pool.Ping(ctx) == nil
	checks = append(checks, depCheck{Name: "postgres", OK: dbOK})

	// The cache is a hard dependency of the hot path (seat holds, search cache),
	// so a ready instance must be able to reach it. A nil client means the API
	// was built without one, which is a misconfiguration, not readiness.
	cacheOK := s.cache != nil && s.cache.Ping(ctx) == nil
	checks = append(checks, depCheck{Name: "redis", OK: cacheOK})

	if ready(checks) {
		writeJSON(w, 200, map[string]any{"status": "ready", "checks": checks})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready", "checks": checks})
}

// handleVersion reports what is actually running: the VCS revision and build
// time Go embeds at build, and the toolchain. Ops needs to answer "which build
// is this?" without guessing, and a fabricated version string is worse than
// none — so this reports only what the binary genuinely carries.
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"go": "", "revision": "", "built_at": "", "modified": false}
	if info, ok := debug.ReadBuildInfo(); ok {
		out["go"] = info.GoVersion
		for _, kv := range info.Settings {
			switch kv.Key {
			case "vcs.revision":
				out["revision"] = kv.Value
			case "vcs.time":
				out["built_at"] = kv.Value
			case "vcs.modified":
				out["modified"] = kv.Value == "true"
			}
		}
	}
	writeJSON(w, 200, out)
}

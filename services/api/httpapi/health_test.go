package httpapi

import "testing"

// Readiness is a gate, not a vote: one unreachable dependency pulls the instance
// out of rotation. If this ever softens to "ready as long as something is up", a
// pod that cannot reach Redis keeps taking passenger traffic it cannot serve.
func TestReadyRequiresEveryDependency(t *testing.T) {
	if !ready([]depCheck{{Name: "postgres", OK: true}, {Name: "redis", OK: true}}) {
		t.Fatal("all dependencies up must be ready")
	}
	if ready([]depCheck{{Name: "postgres", OK: true}, {Name: "redis", OK: false}}) {
		t.Fatal("a down dependency must make the instance NOT ready — else traffic routes to a pod that cannot serve it")
	}
	if ready([]depCheck{{Name: "postgres", OK: false}, {Name: "redis", OK: true}}) {
		t.Fatal("a down database must make the instance NOT ready")
	}
	// An empty check set is vacuously ready; the endpoint always supplies checks.
	if !ready(nil) {
		t.Fatal("no checks is vacuously ready")
	}
}

package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A panic in one handler must not take the API down with it.
//
// Before this, it did. Go's default is to let a panic in a handler kill the
// serving goroutine, and http.Server recovers that one connection — but any
// panic raised outside the handler goroutine, and every panic in the code this
// process runs alongside the mux, ends the process. Either way the visible
// result is the same class of event: a nil map on an admin screen nobody visits
// takes out checkout for every passenger holding a seat.
//
// One request failing is a bug. One request killing the process is an outage.
// They should not be the same event.
func TestAPanicIsFiveHundredAndTheServerLivesOn(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /boom", func(w http.ResponseWriter, r *http.Request) {
		var m map[string]string
		m["this"] = "panics on a nil map write"
	})
	mux.HandleFunc("GET /fine", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	s := &Server{
		mux: mux,
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/boom", nil))

	if rec.Code != 500 {
		t.Fatalf("a panicking handler answered %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "internal_error") {
		t.Errorf("the caller got no machine-readable error: %s", body)
	}
	// The reference in the body is the request id in the log line carrying the
	// stack. Without it, "something went wrong" is unactionable for the person
	// on the phone and for the person reading the logs.
	if ref := rec.Header().Get("X-Request-Id"); ref == "" || !strings.Contains(body, ref) {
		t.Errorf("the 500 does not quote its request id: header=%q body=%s",
			rec.Header().Get("X-Request-Id"), body)
	}

	// And the server is still answering.
	after := httptest.NewRecorder()
	s.ServeHTTP(after, httptest.NewRequest("GET", "/fine", nil))
	if after.Code != 200 {
		t.Fatalf("the next request after a panic answered %d, want 200", after.Code)
	}
}

// A handler that panics halfway through writing cannot be turned into a 500 —
// the status is already on the wire. What must not happen is a second
// WriteHeader stamping a superfluous-call warning over the real failure and
// making the log harder to read than the bug.
func TestAPanicAfterWritingDoesNotWriteTwice(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /half", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partial":`))
		panic("died mid-response")
	})
	s := &Server{
		mux: mux,
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/half", nil))

	if rec.Code != 200 {
		t.Fatalf("status was rewritten to %d after the response had begun", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "internal_error") {
		t.Error("a 500 body was appended to a response that had already started")
	}
}

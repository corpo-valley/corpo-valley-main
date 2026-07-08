package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type okBackend struct{ served bool }

func (b *okBackend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.served = true
	w.WriteHeader(http.StatusOK)
}

func TestReadOnlyRejectsMutatingMethods(t *testing.T) {
	npm := &okBackend{}
	srv := New(npm, nil, nil, "test", false)
	h := srv.Handler()

	// GET is allowed and reaches the backend.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/lodash", nil))
	if !npm.served || rec.Code != http.StatusOK {
		t.Fatalf("GET should reach backend: served=%v code=%d", npm.served, rec.Code)
	}

	// Mutating methods are rejected at the router, never reaching the backend.
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		npm.served = false
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(m, "/npm/lodash/-/lodash-1.0.0.tgz", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s should be 405, got %d", m, rec.Code)
		}
		if npm.served {
			t.Errorf("%s must not reach the backend", m)
		}
	}
}

func TestHealthz(t *testing.T) {
	h := New(&okBackend{}, nil, nil, "v1", false).Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("healthz: code=%d body=%q", rec.Code, rec.Body.String())
	}
}

// /status is unregistered (404) unless explicitly enabled.
func TestStatusDisabledByDefault(t *testing.T) {
	h := New(&okBackend{}, nil, nil, "v1.2.3", false).Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/status", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("disabled /status should be 404, got %d", rec.Code)
	}
}

// When enabled, /status returns the counters and the build version.
func TestStatusEnabled(t *testing.T) {
	h := New(&okBackend{}, nil, nil, "v1.2.3", true).Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "v1.2.3") {
		t.Fatalf("enabled /status: code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Still method-restricted.
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodPost, "/status", nil))
	if rec2.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /status should be 405, got %d", rec2.Code)
	}
}

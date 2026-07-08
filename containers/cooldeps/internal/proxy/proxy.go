// Package proxy mounts the npm, PyPI, and Go-module backends under path
// prefixes behind a single HTTP server, plus /healthz and an optional /status.
// The prefix routing lets one host serve every ecosystem under /npm, /pypi, /go.
package proxy

import (
	"encoding/json"
	"net/http"
)

// Backend is anything that can serve a stripped sub-path (backend.NPM,
// backend.PyPI, backend.GoMod).
type Backend interface {
	ServeHTTP(w http.ResponseWriter, r *http.Request)
}

// Server holds the routing mux and stats.
type Server struct {
	mux   *http.ServeMux
	stats *Stats
}

// New wires the backends under /npm, /pypi and /go. statusEnabled controls the
// /status endpoint: it is unregistered (404) unless explicitly turned on, since
// it exposes the build version and traffic counters to anyone who can reach it.
func New(npm, pypi, gomod Backend, version string, statusEnabled bool) *Server {
	s := &Server{mux: http.NewServeMux(), stats: NewStats(version)}

	if npm != nil {
		s.mux.Handle("/npm/", readOnly(http.StripPrefix("/npm", s.stats.wrap("npm", npm))))
	}
	if pypi != nil {
		s.mux.Handle("/pypi/", readOnly(http.StripPrefix("/pypi", s.stats.wrap("pypi", pypi))))
	}
	if gomod != nil {
		s.mux.Handle("/go/", readOnly(http.StripPrefix("/go", s.stats.wrap("go", gomod))))
	}

	s.mux.Handle("/healthz", readOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})))
	if statusEnabled {
		s.mux.Handle("/status", readOnly(http.HandlerFunc(s.handleStatus)))
	}
	// A bare GET / returns a short human hint rather than a 404.
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("cooldeps proxy — npm at /npm, pip at /pypi/simple, go modules at /go.\n"))
	})

	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

// handleStatus serves the build version and per-backend request counters as
// JSON. Only registered when status is enabled.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.stats.Snapshot())
}

// readOnly rejects mutating HTTP methods before they reach a registry backend.
// The proxy is a read-only gate in front of public registries, so it must never
// relay POST/PUT/DELETE/PATCH to an upstream (open-relay / write-relay risk).
func readOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
		default:
			w.Header().Set("Allow", "GET, HEAD, OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

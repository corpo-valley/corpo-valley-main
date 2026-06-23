package proxy

import (
	"net/http"
	"sync/atomic"
	"time"
)

// Stats holds lightweight per-backend request counters surfaced at /status.
type Stats struct {
	Version  string
	backends map[string]*backendStat
}

type backendStat struct {
	Requests  atomic.Int64
	Status2xx atomic.Int64
	Status4xx atomic.Int64
	Status5xx atomic.Int64
}

func NewStats(version string) *Stats {
	return &Stats{
		Version: version,
		backends: map[string]*backendStat{
			"npm":  {},
			"pypi": {},
			"go":   {},
		},
	}
}

// statusRecorder captures the response status code for counting.
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.code = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *Stats) wrap(name string, next http.Handler) http.Handler {
	bs := s.backends[name]
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Backend traffic is a streaming proxy: artifacts (and large packuments)
		// can take far longer than the server's WriteTimeout, so clear the write
		// deadline here. WriteTimeout then only bounds the cheap local endpoints
		// (/status, /healthz, /). No-op where deadlines are unsupported (tests).
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		bs.Requests.Add(1)
		next.ServeHTTP(rec, r)
		switch {
		case rec.code >= 500:
			bs.Status5xx.Add(1)
		case rec.code >= 400:
			bs.Status4xx.Add(1)
		case rec.code >= 200:
			bs.Status2xx.Add(1)
		}
	})
}

// StatsSnapshot is the JSON shape of /status.
type StatsSnapshot struct {
	Version  string                     `json:"version"`
	Backends map[string]BackendSnapshot `json:"backends"`
}

type BackendSnapshot struct {
	Requests  int64 `json:"requests"`
	Status2xx int64 `json:"status_2xx"`
	Status4xx int64 `json:"status_4xx"`
	Status5xx int64 `json:"status_5xx"`
}

func (s *Stats) Snapshot() StatsSnapshot {
	out := StatsSnapshot{Version: s.Version, Backends: map[string]BackendSnapshot{}}
	for name, bs := range s.backends {
		out.Backends[name] = BackendSnapshot{
			Requests:  bs.Requests.Load(),
			Status2xx: bs.Status2xx.Load(),
			Status4xx: bs.Status4xx.Load(),
			Status5xx: bs.Status5xx.Load(),
		}
	}
	return out
}

package eval

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/model"
	"github.com/hashtagcyber/cooldeps/internal/policy"
	"github.com/hashtagcyber/cooldeps/internal/sources/osv"
)

var now = time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)

// fakeMeta / fakeVuln implement the provider interfaces and count calls so we
// can assert caching.
type fakeMeta struct {
	calls   int32
	results map[string]model.VersionMeta // version -> meta
	found   map[string]bool
	err     error
}

func (f *fakeMeta) GetVersion(_ context.Context, eco model.Ecosystem, name, version string) (model.VersionMeta, bool, error) {
	atomic.AddInt32(&f.calls, 1)
	if f.err != nil {
		return model.VersionMeta{}, false, f.err
	}
	m, ok := f.results[version]
	if !ok {
		return model.VersionMeta{Ecosystem: eco, Name: name, Version: version}, false, nil
	}
	m.Ecosystem, m.Name, m.Version = eco, name, version
	return m, f.found[version], nil
}

type fakeVuln struct {
	batchCalls int32
	sevCalls   int32
	ids        map[string][]string // version -> ids
	sev        map[string]model.Severity
	err        error
	sevErr     bool // GetSeverity returns a transient error
}

func (f *fakeVuln) QueryBatch(_ context.Context, qs []osv.Query) ([][]string, error) {
	atomic.AddInt32(&f.batchCalls, 1)
	if f.err != nil {
		return nil, f.err
	}
	out := make([][]string, len(qs))
	for i, q := range qs {
		out[i] = f.ids[q.Version]
	}
	return out, nil
}
func (f *fakeVuln) GetSeverity(_ context.Context, id string) (model.Severity, error) {
	atomic.AddInt32(&f.sevCalls, 1)
	if f.sevErr {
		return model.SeverityUnknown, context.DeadlineExceeded
	}
	if s, ok := f.sev[id]; ok {
		return s, nil
	}
	return model.SeverityUnknown, nil
}

func newEval(t *testing.T, p policy.Policy, m metaProvider, v vulnProvider) *Evaluator {
	t.Helper()
	return newEvalCfg(t, p, m, v, Config{Now: func() time.Time { return now }})
}

func newEvalCfg(t *testing.T, p policy.Policy, m metaProvider, v vulnProvider, cfg Config) *Evaluator {
	t.Helper()
	db, err := cache.OpenDB(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(policy.NewEngine(p), m, v, db, cfg)
}

func aged(days float64, lic string) model.VersionMeta {
	return model.VersionMeta{PublishedAt: now.Add(-time.Duration(days*24) * time.Hour), PublishedKnown: true, License: lic}
}

func TestEvaluateAllowsCleanAgedVersion(t *testing.T) {
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	v := &fakeVuln{}
	e := newEval(t, policy.Default(), m, v)
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Allow {
		t.Fatalf("expected allow, got %s (%+v)", got.Decision, got.Reasons)
	}
}

func TestEvaluateCachesMetadata(t *testing.T) {
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	e := newEval(t, policy.Default(), m, &fakeVuln{})
	for i := 0; i < 3; i++ {
		e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	}
	if got := atomic.LoadInt32(&m.calls); got != 1 {
		t.Fatalf("metadata should be fetched once and cached, got %d calls", got)
	}
}

func TestEvaluateBlocksHighCVE(t *testing.T) {
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	v := &fakeVuln{ids: map[string][]string{"1.0.0": {"GHSA-x"}}, sev: map[string]model.Severity{"GHSA-x": model.SeverityHigh}}
	e := newEval(t, policy.Default(), m, v)
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("expected block on HIGH cve, got %s", got.Decision)
	}
}

func TestEvaluateManyBatchesOSV(t *testing.T) {
	m := &fakeMeta{
		results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT"), "2.0.0": aged(30, "MIT"), "3.0.0": aged(30, "MIT")},
		found:   map[string]bool{"1.0.0": true, "2.0.0": true, "3.0.0": true},
	}
	v := &fakeVuln{}
	e := newEval(t, policy.Default(), m, v)
	res := e.EvaluateMany(context.Background(), model.NPM, "pkg", []string{"1.0.0", "2.0.0", "3.0.0"})
	if len(res) != 3 {
		t.Fatalf("expected 3 verdicts, got %d", len(res))
	}
	if got := atomic.LoadInt32(&v.batchCalls); got != 1 {
		t.Fatalf("expected a single batched OSV call, got %d", got)
	}
}

func TestFailClosedOnMetaError(t *testing.T) {
	m := &fakeMeta{err: context.DeadlineExceeded}
	p := policy.Default()
	p.FailOpen = false
	e := newEval(t, p, m, &fakeVuln{})
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("failClosed should block on meta error, got %s", got.Decision)
	}
}

func TestFailOpenOnMetaError(t *testing.T) {
	m := &fakeMeta{err: context.DeadlineExceeded}
	p := policy.Default()
	p.FailOpen = true
	e := newEval(t, p, m, &fakeVuln{})
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Warn {
		t.Fatalf("failOpen should warn/allow on meta error, got %s", got.Decision)
	}
}

func TestOverrideHonoredOnDegradedPath(t *testing.T) {
	m := &fakeMeta{err: context.DeadlineExceeded} // metadata API down

	// Default policy is FailOpen=false (block), but an override allow must still
	// let an emergency critical fix through even during the outage.
	p := policy.Default()
	p.Overrides.Allow = []string{"npm:critical-fix@9.9.9"}
	e := newEval(t, p, m, &fakeVuln{})
	if got := e.Evaluate(context.Background(), model.NPM, "critical-fix", "9.9.9"); got.Decision != model.Allow {
		t.Fatalf("override allow must hold when metadata API is down, got %s (%+v)", got.Decision, got.Reasons)
	}

	// An override block must hold (fail-safe) even with FailOpen=true.
	p2 := policy.Default()
	p2.FailOpen = true
	p2.Overrides.Block = []string{"npm:evil@1.0.0"}
	e2 := newEval(t, p2, m, &fakeVuln{})
	if got := e2.Evaluate(context.Background(), model.NPM, "evil", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("override block must hold when metadata API is down, got %s", got.Decision)
	}

	// A non-overridden version still falls back to the degraded (block) verdict.
	if got := e.Evaluate(context.Background(), model.NPM, "other", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("non-overridden version should degrade to block, got %s", got.Decision)
	}
}

func TestTransientSeverityFailureNotCached(t *testing.T) {
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	// QueryBatch reports a vuln, but GetSeverity always errors (transient outage).
	v := &fakeVuln{ids: map[string][]string{"1.0.0": {"GHSA-x"}}, sevErr: true}
	e := newEval(t, policy.Default(), m, v)
	// First call: Unknown (fail-safe) -> blocks, but must NOT be cached.
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("transient severity failure should fail-safe block, got %s", got.Decision)
	}
	// Second call re-queries OSV (cache miss) rather than serving a stale Unknown.
	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if atomic.LoadInt32(&v.batchCalls) < 2 {
		t.Fatalf("transient failure must not be cached; expected re-query, batchCalls=%d", v.batchCalls)
	}
}

func TestUnknownSeverityFetchDisabledBlocks(t *testing.T) {
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	v := &fakeVuln{ids: map[string][]string{"1.0.0": {"OSV-unscored"}}}
	p := policy.Default()
	p.CVE.FetchSeverity = false // don't resolve severity -> unknown -> fail-safe block
	e := newEval(t, p, m, v)
	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Block {
		t.Fatalf("expected fail-safe block, got %s", got.Decision)
	}
	if atomic.LoadInt32(&v.sevCalls) != 0 {
		t.Fatal("severity should not be fetched when fetchSeverity=false")
	}
}

func TestVulnSeverityMemoisedAcrossVersions(t *testing.T) {
	m := &fakeMeta{
		results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT"), "2.0.0": aged(30, "MIT")},
		found:   map[string]bool{"1.0.0": true, "2.0.0": true},
	}
	// Same advisory affects both versions; severity should be fetched once.
	v := &fakeVuln{
		ids: map[string][]string{"1.0.0": {"GHSA-shared"}, "2.0.0": {"GHSA-shared"}},
		sev: map[string]model.Severity{"GHSA-shared": model.SeverityMedium},
	}
	e := newEval(t, policy.Default(), m, v)
	e.EvaluateMany(context.Background(), model.NPM, "pkg", []string{"1.0.0", "2.0.0"})
	if got := atomic.LoadInt32(&v.sevCalls); got != 1 {
		t.Fatalf("severity should be memoised per advisory id, got %d calls", got)
	}
}

// With MetaTTL=0 (default), a found row is cached forever — no refetch even far
// in the future.
func TestMetaTTLZeroCachesFoundForever(t *testing.T) {
	clock := now
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	e := newEvalCfg(t, policy.Default(), m, &fakeVuln{}, Config{Now: func() time.Time { return clock }, MetaTTL: 0})

	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	clock = now.Add(1000 * time.Hour)
	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if got := atomic.LoadInt32(&m.calls); got != 1 {
		t.Fatalf("MetaTTL=0 should cache found metadata forever, got %d calls", got)
	}
}

// With MetaTTL set, a found row is reused within the TTL and re-fetched past it.
func TestMetaTTLRefetchesPastWindow(t *testing.T) {
	clock := now
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	e := newEvalCfg(t, policy.Default(), m, &fakeVuln{}, Config{Now: func() time.Time { return clock }, MetaTTL: 24 * time.Hour})

	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	clock = now.Add(12 * time.Hour) // within TTL
	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if got := atomic.LoadInt32(&m.calls); got != 1 {
		t.Fatalf("within MetaTTL should reuse cache, got %d calls", got)
	}
	clock = now.Add(25 * time.Hour) // past TTL
	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if got := atomic.LoadInt32(&m.calls); got != 2 {
		t.Fatalf("past MetaTTL should refetch once, got %d calls", got)
	}
}

// If a MetaTTL refresh fails (deps.dev down), serve the stale found row rather
// than degrade — the publish date can't have changed.
func TestMetaTTLOutageServesStale(t *testing.T) {
	clock := now
	m := &fakeMeta{results: map[string]model.VersionMeta{"1.0.0": aged(30, "MIT")}, found: map[string]bool{"1.0.0": true}}
	e := newEvalCfg(t, policy.Default(), m, &fakeVuln{}, Config{Now: func() time.Time { return clock }, MetaTTL: time.Hour})

	if got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); got.Decision != model.Allow {
		t.Fatalf("warm: expected allow, got %s", got.Decision)
	}
	clock = now.Add(2 * time.Hour) // past TTL
	m.err = errors.New("deps.dev unreachable")
	got := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if got.Decision != model.Allow {
		t.Fatalf("outage past MetaTTL should serve stale found meta (allow), got %s (%+v)", got.Decision, got.Reasons)
	}
}

// A version deps.dev doesn't know yet is cached as "not found" and re-checked
// only after NotFoundRefresh — at which point a now-published version is picked up.
func TestNotFoundRefresh(t *testing.T) {
	clock := now
	m := &fakeMeta{results: map[string]model.VersionMeta{}, found: map[string]bool{}}
	e := newEvalCfg(t, policy.Default(), m, &fakeVuln{}, Config{Now: func() time.Time { return clock }})

	// Unknown upstream => cached not-found; unknown release date warns.
	if v := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); v.Decision != model.Warn {
		t.Fatalf("unknown-age version should warn, got %s", v.Decision)
	}
	if got := atomic.LoadInt32(&m.calls); got != 1 {
		t.Fatalf("want 1 fetch, got %d", got)
	}

	// Within the refresh window: served from the not-found cache, no refetch.
	clock = now.Add(10 * time.Minute)
	e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0")
	if got := atomic.LoadInt32(&m.calls); got != 1 {
		t.Fatalf("within NotFoundRefresh should not refetch, got %d", got)
	}

	// Past the window and now published upstream: refetch and allow.
	clock = now.Add(31 * time.Minute)
	m.results["1.0.0"] = aged(30, "MIT")
	m.found["1.0.0"] = true
	if v := e.Evaluate(context.Background(), model.NPM, "pkg", "1.0.0"); v.Decision != model.Allow {
		t.Fatalf("now-published clean version should allow, got %s (%+v)", v.Decision, v.Reasons)
	}
	if got := atomic.LoadInt32(&m.calls); got != 2 {
		t.Fatalf("past NotFoundRefresh should refetch once, got %d", got)
	}
}

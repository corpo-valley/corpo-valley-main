// Package eval wires the data sources, caches, and pure policy engine into a
// single "give me the verdict for this version" service. It is cache-first
// (cheap steady state), batches OSV lookups, and applies the fail-open/closed
// posture when the external metadata APIs are unreachable.
package eval

import (
	"context"
	"sync"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/model"
	"github.com/hashtagcyber/cooldeps/internal/policy"
	"github.com/hashtagcyber/cooldeps/internal/sources/osv"
)

// metaProvider / vulnProvider are the slices of the source clients eval needs,
// declared as interfaces so tests can supply fakes without real HTTP.
type metaProvider interface {
	GetVersion(ctx context.Context, eco model.Ecosystem, name, version string) (model.VersionMeta, bool, error)
}
type vulnProvider interface {
	QueryBatch(ctx context.Context, queries []osv.Query) ([][]string, error)
	GetSeverity(ctx context.Context, id string) (model.Severity, error)
}

// Evaluator produces verdicts. Safe for concurrent use.
type Evaluator struct {
	engine *policy.Engine
	meta   metaProvider
	osv    vulnProvider
	db     *cache.DB

	vulnTTL         time.Duration
	notFoundRefresh time.Duration // re-query deps.dev for a cached "unknown age" after this
	metaTTL         time.Duration // re-fetch found metadata after this (license drift); 0 => never
	fetchConc       int           // bounded concurrency for per-version fetches

	now func() time.Time
}

// Config tunes the evaluator.
type Config struct {
	VulnTTL          time.Duration
	NotFoundRefresh  time.Duration
	MetaTTL          time.Duration // 0 => found metadata is cached forever (publish date is immutable)
	FetchConcurrency int
	Now              func() time.Time
}

// New builds an Evaluator.
func New(engine *policy.Engine, meta metaProvider, vuln vulnProvider, db *cache.DB, cfg Config) *Evaluator {
	if cfg.VulnTTL <= 0 {
		cfg.VulnTTL = 6 * time.Hour
	}
	if cfg.NotFoundRefresh <= 0 {
		cfg.NotFoundRefresh = 30 * time.Minute
	}
	if cfg.FetchConcurrency <= 0 {
		cfg.FetchConcurrency = 8
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	// MetaTTL is deliberately NOT defaulted: 0 means "cache found metadata
	// forever" (the publish date is immutable; only license could drift).
	return &Evaluator{
		engine: engine, meta: meta, osv: vuln, db: db,
		vulnTTL: cfg.VulnTTL, notFoundRefresh: cfg.NotFoundRefresh, metaTTL: cfg.MetaTTL,
		fetchConc: cfg.FetchConcurrency, now: cfg.Now,
	}
}

// Evaluate returns the verdict for one exact version.
func (e *Evaluator) Evaluate(ctx context.Context, eco model.Ecosystem, name, version string) model.Verdict {
	return e.EvaluateMany(ctx, eco, name, []string{version})[version]
}

// EvaluateMany returns a verdict per version, sharing one OSV batch call. This
// is the PyPI listing path; the npm path calls it with a single version.
func (e *Evaluator) EvaluateMany(ctx context.Context, eco model.Ecosystem, name string, versions []string) map[string]model.Verdict {
	now := e.now()
	out := make(map[string]model.Verdict, len(versions))

	// 1) Metadata for every version (cache-first, bounded-concurrency fetch).
	metas := make(map[string]model.VersionMeta, len(versions))
	metaErr := make(map[string]bool, len(versions))
	e.fillMetadata(ctx, eco, name, versions, now, metas, metaErr)

	// 2) Vulns for every version that needs them (one batched OSV query).
	vulns := make(map[string][]model.Vuln, len(versions))
	vulnErr := make(map[string]bool, len(versions))
	if e.engine.Policy().NeedsVulnData() {
		e.fillVulns(ctx, eco, name, versions, now, vulns, vulnErr)
	}

	// 3) Decide.
	for _, v := range versions {
		// metaErr (deps.dev down) or vulnErr (OSV QueryBatch down) means we could
		// not fully evaluate this version, so the whole verdict goes degraded —
		// fail-closed by default (failOpen=false). Note this is deliberately
		// stricter than a single severity-lookup blip, which stays in the normal
		// path as a fail-safe Unknown rather than setting vulnErr.
		if metaErr[v] || vulnErr[v] {
			// Honour operator overrides even when the metadata APIs are down: an
			// emergency allow must still let its version through, and an incident
			// block must still hold — regardless of fail-open/closed. Only fall
			// back to the degraded verdict when no override pin matches.
			if ov, ok := e.engine.EvaluateOverride(eco, name, v); ok {
				out[v] = ov
			} else {
				out[v] = degraded(e.engine.Policy().FailOpen)
			}
			continue
		}
		out[v] = e.engine.Evaluate(metas[v], vulns[v], now)
	}
	return out
}

func (e *Evaluator) fillMetadata(ctx context.Context, eco model.Ecosystem, name string, versions []string, now time.Time, metas map[string]model.VersionMeta, metaErr map[string]bool) {
	var (
		mu      sync.Mutex
		toFetch []string
		// fallback holds stale-but-valid "found" rows scheduled for a META_TTL
		// refresh: if that refresh fails (deps.dev down) we serve the stale row
		// rather than degrade, since its publish date can never change.
		fallback = map[string]model.VersionMeta{}
	)
	for _, v := range versions {
		if m, found, ok := e.db.GetMeta(eco, name, v); ok {
			if found {
				// A found row's publish date is immutable, so trust it forever
				// unless META_TTL is set — then refresh past the TTL to pick up a
				// license correction, keeping the stale row as an outage fallback.
				if e.metaTTL <= 0 {
					metas[v] = m
					continue
				}
				if at, ok2 := e.db.MetaFetchedAt(eco, name, v); ok2 && now.Sub(at) < e.metaTTL {
					metas[v] = m
					continue
				}
				fallback[v] = m
			} else {
				// A cached "not found" (unknown age) is refreshed periodically,
				// since a just-published version eventually gains a release date.
				if at, ok2 := e.db.MetaFetchedAt(eco, name, v); ok2 && now.Sub(at) < e.notFoundRefresh {
					metas[v] = m
					continue
				}
			}
		}
		toFetch = append(toFetch, v)
	}

	e.parallel(toFetch, func(v string) {
		m, found, err := e.meta.GetVersion(ctx, eco, name, v)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			if fb, ok := fallback[v]; ok {
				metas[v] = fb // stale found row beats degrading on a transient outage
				return
			}
			metaErr[v] = true
			return
		}
		_ = e.db.PutMeta(m, found, now)
		metas[v] = m
	})
}

func (e *Evaluator) fillVulns(ctx context.Context, eco model.Ecosystem, name string, versions []string, now time.Time, vulns map[string][]model.Vuln, vulnErr map[string]bool) {
	// Cache pass.
	var need []string
	for _, v := range versions {
		if cached, ok := e.db.GetVulns(eco, name, v, now); ok {
			vulns[v] = cached
			continue
		}
		need = append(need, v)
	}
	if len(need) == 0 {
		return
	}

	// One batched querybatch for all uncached versions.
	queries := make([]osv.Query, len(need))
	for i, v := range need {
		queries[i] = osv.Query{Ecosystem: eco, Name: name, Version: v}
	}
	idsByIdx, err := e.osv.QueryBatch(ctx, queries)
	if err != nil {
		for _, v := range need {
			vulnErr[v] = true
		}
		return
	}

	fetchSeverity := e.engine.Policy().CVE.FetchSeverity
	// Resolve severities concurrently, SINGLE-FLIGHT per advisory id (one CVE can
	// affect many versions of the package, and several version goroutines may
	// race on the same id): concurrent callers for an id share one GetSeverity
	// call. The bool reports a TRANSIENT fetch failure (network/5xx), distinct
	// from a deliberate Unknown when fetchSeverity is off — a transient failure
	// must not be cached as a durable "Unknown == offending" verdict, or one OSV
	// blip would over-block for hours.
	type sevResult struct {
		sev    model.Severity
		failed bool
	}
	var sevMu sync.Mutex
	sevCache := map[string]sevResult{}
	inflight := map[string]chan struct{}{}
	resolve := func(id string) (model.Severity, bool) {
		if !fetchSeverity {
			return model.SeverityUnknown, false // deliberate Unknown (fail-safe), cacheable
		}
		for {
			sevMu.Lock()
			if r, ok := sevCache[id]; ok {
				sevMu.Unlock()
				return r.sev, r.failed
			}
			if ch, ok := inflight[id]; ok {
				// Another goroutine is already fetching this id — wait, then retry.
				sevMu.Unlock()
				<-ch
				continue
			}
			ch := make(chan struct{})
			inflight[id] = ch
			sevMu.Unlock()

			s, err := e.osv.GetSeverity(ctx, id)
			if err != nil {
				s = model.SeverityUnknown
			}
			sevMu.Lock()
			sevCache[id] = sevResult{sev: s, failed: err != nil}
			delete(inflight, id)
			close(ch)
			sevMu.Unlock()
			return s, err != nil
		}
	}

	var mu sync.Mutex
	e.parallelIdx(len(need), func(i int) {
		v := need[i]
		ids := idsByIdx[i]
		vs := make([]model.Vuln, 0, len(ids))
		transient := false
		for _, id := range ids {
			sev, failed := resolve(id)
			transient = transient || failed
			vs = append(vs, model.Vuln{ID: id, Severity: sev})
		}
		mu.Lock()
		vulns[v] = vs
		// Use the result for this request (fail-safe), but only persist it when
		// no severity lookup transiently failed, so a blip is re-resolved soon.
		if !transient {
			_ = e.db.PutVulns(eco, name, v, vs, now, e.vulnTTL)
		}
		mu.Unlock()
	})
}

// degraded builds the verdict used when external APIs are unreachable.
func degraded(failOpen bool) model.Verdict {
	if failOpen {
		return model.Verdict{Decision: model.Warn, Reasons: []model.Reason{{
			Check: "degraded", Decision: model.Warn,
			Message: "metadata APIs unreachable; allowing (failOpen=true)"}}}
	}
	return model.Verdict{Decision: model.Block, Reasons: []model.Reason{{
		Check: "degraded", Decision: model.Block,
		Message: "metadata APIs unreachable; blocking (failOpen=false)"}}}
}

// --- tiny bounded worker pools (no external deps) ---

func (e *Evaluator) parallel(items []string, fn func(string)) {
	e.parallelIdx(len(items), func(i int) { fn(items[i]) })
}

func (e *Evaluator) parallelIdx(n int, fn func(int)) {
	if n == 0 {
		return
	}
	conc := e.fetchConc
	if conc > n {
		conc = n
	}
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

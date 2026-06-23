package policy

import (
	"fmt"
	"strings"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// Engine is a pure evaluator: given a version's metadata and known vulns it
// returns a verdict. Construct it once from a Policy; it holds no I/O state and
// is safe for concurrent use.
type Engine struct {
	policy       Policy
	maxSeverity  model.Severity
	allowLicense map[string]bool
	blockLicense map[string]bool
	allowPins    pinSet
	blockPins    pinSet
}

// NewEngine pre-compiles the lookup structures from a policy.
func NewEngine(p Policy) *Engine {
	e := &Engine{
		policy:       p,
		maxSeverity:  model.ParseSeverity(p.CVE.MaxSeverity),
		allowLicense: toLicenseSet(p.License.Allow),
		blockLicense: toLicenseSet(p.License.Block),
		allowPins:    newPinSet(p.Overrides.Allow),
		blockPins:    newPinSet(p.Overrides.Block),
	}
	return e
}

// Policy returns the policy this engine was built from.
func (e *Engine) Policy() Policy { return e.policy }

// EvaluateOverride runs ONLY the override pin checks — which need no metadata or
// vuln data — returning the override verdict and true when a pin matches. Block
// wins over allow (fail-safe) so an allow pin can never resurrect a package an
// operator explicitly killed. The evaluator also calls this on the degraded
// path so operator overrides still hold when the metadata APIs are unreachable.
func (e *Engine) EvaluateOverride(eco model.Ecosystem, name, version string) (model.Verdict, bool) {
	if e.blockPins.matches(eco, name, version) {
		return model.Verdict{Decision: model.Block, Reasons: []model.Reason{{
			Check: "override", Decision: model.Block,
			Message: fmt.Sprintf("%s %s is on the override block list", name, version),
		}}}, true
	}
	if e.allowPins.matches(eco, name, version) {
		return model.Verdict{Decision: model.Allow, Reasons: []model.Reason{{
			Check: "override", Decision: model.Allow,
			Message: fmt.Sprintf("%s %s is allow-listed (override); cooldown/CVE/license checks skipped", name, version),
		}}}, true
	}
	return model.Verdict{}, false
}

// Evaluate runs the full decision ladder for one version. `now` is injected so
// the cooldown check is deterministic in tests.
func (e *Engine) Evaluate(meta model.VersionMeta, vulns []model.Vuln, now time.Time) model.Verdict {
	// Overrides first.
	if v, ok := e.EvaluateOverride(meta.Ecosystem, meta.Name, meta.Version); ok {
		return v
	}

	v := model.Verdict{Decision: model.Allow}
	add := func(r model.Reason) {
		v.Reasons = append(v.Reasons, r)
		if r.Decision > v.Decision {
			v.Decision = r.Decision
		}
	}

	if r, ok := e.checkReleaseAge(meta, now); ok {
		add(r)
	}
	if r, ok := e.checkLicense(meta); ok {
		add(r)
	}
	for _, r := range e.checkCVE(vulns) {
		add(r)
	}
	return v
}

func (e *Engine) checkReleaseAge(meta model.VersionMeta, now time.Time) (model.Reason, bool) {
	if e.policy.ReleaseAge.MinDays <= 0 {
		return model.Reason{}, false
	}
	if !meta.PublishedKnown {
		if e.policy.ReleaseAge.BlockOnUnknown {
			return model.Reason{Check: "cooldown", Decision: model.Block,
				Message: "release date unknown (deps.dev has no metadata yet) and blockOnUnknown is set"}, true
		}
		return model.Reason{Check: "cooldown", Decision: model.Warn,
			Message: "release date unknown (deps.dev has no metadata yet)"}, true
	}
	minAge := time.Duration(e.policy.ReleaseAge.MinDays) * 24 * time.Hour
	age := now.Sub(meta.PublishedAt)
	if age >= minAge {
		return model.Reason{}, false
	}
	dec := model.Block
	if e.policy.ReleaseAge.WarnOnly {
		dec = model.Warn
	}
	days := age.Hours() / 24
	return model.Reason{Check: "cooldown", Decision: dec,
		Message: fmt.Sprintf("published %.1f days ago, inside the %d-day cooldown window", days, e.policy.ReleaseAge.MinDays)}, true
}

func (e *Engine) checkLicense(meta model.VersionMeta) (model.Reason, bool) {
	lic := strings.TrimSpace(meta.License)
	if lic == "" {
		if e.policy.License.WarnOnUnknown {
			return model.Reason{Check: "license", Decision: model.Warn,
				Message: "no license reported upstream"}, true
		}
		return model.Reason{}, false
	}
	dec, why := e.evalLicenseExpr(lic)
	if dec == model.Allow {
		return model.Reason{}, false
	}
	return model.Reason{Check: "license", Decision: dec, Message: why}, true
}

// evalLicenseExpr handles the common SPDX shapes without a full parser:
//   - a bare id ("MIT")
//   - "A OR B" — user may pick either, so allowed if ANY operand is allowed and
//     none is explicitly blocked
//   - "A AND B" — both apply, so blocked if ANY operand is blocked
//
// Anything genuinely ambiguous defaults to block when an allowlist is set
// (strict gate), else allow. This is intentionally simplified; see README.
func (e *Engine) evalLicenseExpr(expr string) (model.Decision, string) {
	norm := strings.ToUpper(expr)
	if strings.Contains(norm, " OR ") {
		ops := splitOn(expr, " OR ")
		for _, op := range ops {
			if e.licenseAllowed(op) {
				return model.Allow, ""
			}
		}
		return model.Block, fmt.Sprintf("no operand of %q is on the allow list", expr)
	}
	// AND (or single id): every operand must be allowed.
	for _, op := range splitOn(expr, " AND ") {
		if !e.licenseAllowed(op) {
			return model.Block, fmt.Sprintf("license %q is not on the allow list", expr)
		}
	}
	return model.Allow, ""
}

// licenseAllowed reports whether a single license id passes. With no allow list
// configured, anything not explicitly blocked passes.
func (e *Engine) licenseAllowed(op string) bool {
	id := normLicense(op)
	// SPDX "<license> WITH <exception>": the exception only grants additional
	// permissions, so judge by the base license id (e.g. "Apache-2.0 WITH
	// LLVM-exception" is decided as "Apache-2.0").
	if i := strings.Index(id, " WITH "); i >= 0 {
		id = strings.TrimSpace(id[:i])
	}
	if e.blockLicense[id] {
		return false
	}
	if len(e.allowLicense) == 0 {
		return true
	}
	return e.allowLicense[id]
}

func (e *Engine) checkCVE(vulns []model.Vuln) []model.Reason {
	if e.policy.CVE.MaxSeverity == "" || len(vulns) == 0 {
		return nil
	}
	var offending []model.Vuln
	for _, vln := range vulns {
		if vln.Severity.AtLeast(e.maxSeverity) {
			offending = append(offending, vln)
		}
	}
	if len(offending) == 0 {
		return nil
	}
	dec := model.Block
	if e.policy.CVE.WarnOnly {
		dec = model.Warn
	}
	reasons := make([]model.Reason, 0, len(offending))
	for _, vln := range offending {
		reasons = append(reasons, model.Reason{Check: "cve", Decision: dec,
			Message: fmt.Sprintf("%s (severity %s) >= maxSeverity %s", vln.ID, vln.Severity, e.maxSeverity)})
	}
	return reasons
}

// --- helpers ---

func toLicenseSet(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		if s := normLicense(id); s != "" {
			m[s] = true
		}
	}
	return m
}

func normLicense(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "()")
	return strings.ToUpper(strings.TrimSpace(s))
}

func splitOn(expr, sep string) []string {
	parts := strings.Split(strings.ToUpper(expr), sep)
	// Map back to original-cased trimmed substrings is unnecessary since callers
	// re-normalise; trim each operand.
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(strings.Trim(p, "()"))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

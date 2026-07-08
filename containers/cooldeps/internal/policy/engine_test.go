package policy

import (
	"testing"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

var refNow = time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)

func metaAt(name, ver, lic string, ageDays float64) model.VersionMeta {
	return model.VersionMeta{
		Ecosystem:      model.NPM,
		Name:           name,
		Version:        ver,
		License:        lic,
		PublishedAt:    refNow.Add(-time.Duration(ageDays*24) * time.Hour),
		PublishedKnown: true,
	}
}

func TestCooldownBlocksFreshVersion(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("left-pad", "1.3.0", "MIT", 2), nil, refNow)
	if v.Decision != model.Block {
		t.Fatalf("fresh version should block, got %s (%+v)", v.Decision, v.Reasons)
	}
	if v.Reasons[0].Check != "cooldown" {
		t.Fatalf("expected cooldown reason, got %+v", v.Reasons)
	}
}

func TestCooldownAllowsAgedVersion(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("left-pad", "1.3.0", "MIT", 30), nil, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("aged MIT version should allow, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestOverrideAllowBypassesCooldown(t *testing.T) {
	p := Default()
	p.Overrides.Allow = []string{"npm:laps@1.0.1"}
	e := NewEngine(p)
	// Published today AND would otherwise trip cooldown — the override wins.
	m := metaAt("laps", "1.0.1", "MIT", 0)
	v := e.Evaluate(m, nil, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("override allow should let a same-day critical fix through, got %s (%+v)", v.Decision, v.Reasons)
	}
	if v.Reasons[0].Check != "override" {
		t.Fatalf("expected override reason, got %+v", v.Reasons)
	}
}

func TestOverrideAllowIsVersionSpecific(t *testing.T) {
	p := Default()
	p.Overrides.Allow = []string{"npm:laps@1.0.1"}
	e := NewEngine(p)
	// A *different* fresh version of the same package is still gated.
	v := e.Evaluate(metaAt("laps", "1.0.2", "MIT", 0), nil, refNow)
	if v.Decision != model.Block {
		t.Fatalf("non-pinned fresh version should still block, got %s", v.Decision)
	}
}

func TestBareNameOverrideAllowsAllVersions(t *testing.T) {
	p := Default()
	p.Overrides.Allow = []string{"internal-tool"} // trust every version
	e := NewEngine(p)
	for _, ver := range []string{"1.0.0", "9.9.9"} {
		if v := e.Evaluate(metaAt("internal-tool", ver, "", 0), nil, refNow); v.Decision != model.Allow {
			t.Fatalf("bare-name override should allow %s, got %s", ver, v.Decision)
		}
	}
}

func TestOverrideBlockWinsOverAllow(t *testing.T) {
	p := Default()
	p.Overrides.Allow = []string{"npm:evil@1.0.0"}
	p.Overrides.Block = []string{"npm:evil@1.0.0"}
	e := NewEngine(p)
	if v := e.Evaluate(metaAt("evil", "1.0.0", "MIT", 30), nil, refNow); v.Decision != model.Block {
		t.Fatalf("block override must win over allow, got %s", v.Decision)
	}
}

func TestScopedNpmOverride(t *testing.T) {
	p := Default()
	p.Overrides.Allow = []string{"@types/node@1.2.3"}
	e := NewEngine(p)
	m := metaAt("@types/node", "1.2.3", "MIT", 0)
	if v := e.Evaluate(m, nil, refNow); v.Decision != model.Allow {
		t.Fatalf("scoped name override should parse and allow, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestGoEcosystemOverridePin(t *testing.T) {
	p := Default()
	p.Overrides.Block = []string{"go:github.com/evil/mod@v1.0.0"}
	e := NewEngine(p)
	m := model.VersionMeta{Ecosystem: model.Go, Name: "github.com/evil/mod", Version: "v1.0.0",
		License: "MIT", PublishedAt: refNow.Add(-100 * 24 * time.Hour), PublishedKnown: true}
	if v := e.Evaluate(m, nil, refNow); v.Decision != model.Block {
		t.Fatalf("go: block override must enforce, got %s (%+v)", v.Decision, v.Reasons)
	}
	// A go: allow override must let a same-day module through.
	p2 := Default()
	p2.Overrides.Allow = []string{"go:golang.org/x/tools@v0.1.0"}
	e2 := NewEngine(p2)
	m2 := model.VersionMeta{Ecosystem: model.Go, Name: "golang.org/x/tools", Version: "v0.1.0", PublishedKnown: false}
	if v := e2.Evaluate(m2, nil, refNow); v.Decision != model.Allow {
		t.Fatalf("go: allow override must bypass gate, got %s", v.Decision)
	}
}

func TestLicenseWithException(t *testing.T) {
	e := NewEngine(Default()) // allow includes Apache-2.0
	v := e.Evaluate(metaAt("llvm", "1.0.0", "Apache-2.0 WITH LLVM-exception", 30), nil, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("'Apache-2.0 WITH LLVM-exception' should be allowed via base id, got %s (%+v)", v.Decision, v.Reasons)
	}
	// And a blocked base license WITH an exception still blocks.
	vb := e.Evaluate(metaAt("gpl", "1.0.0", "GPL-3.0 WITH Classpath-exception-2.0", 30), nil, refNow)
	if vb.Decision != model.Block {
		t.Fatalf("blocked base license WITH exception should still block, got %s", vb.Decision)
	}
}

func TestLicenseBlockList(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("copyleft", "1.0.0", "GPL-3.0", 30), nil, refNow)
	if v.Decision != model.Block {
		t.Fatalf("GPL-3.0 should block, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestLicenseNotOnAllowList(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("weird", "1.0.0", "WTFPL", 30), nil, refNow)
	if v.Decision != model.Block {
		t.Fatalf("license outside allow list should block, got %s", v.Decision)
	}
}

func TestLicenseOrExpression(t *testing.T) {
	e := NewEngine(Default())
	// MIT is allowed; "MIT OR GPL-3.0" means the user may pick MIT -> allow.
	v := e.Evaluate(metaAt("dual", "1.0.0", "MIT OR GPL-3.0", 30), nil, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("OR-expr with an allowed operand should allow, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestLicenseAndExpressionWithBlocked(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("combo", "1.0.0", "MIT AND GPL-3.0", 30), nil, refNow)
	if v.Decision != model.Block {
		t.Fatalf("AND-expr containing a blocked operand should block, got %s", v.Decision)
	}
}

func TestUnknownLicenseWarns(t *testing.T) {
	e := NewEngine(Default())
	v := e.Evaluate(metaAt("nolicense", "1.0.0", "", 30), nil, refNow)
	if v.Decision != model.Warn {
		t.Fatalf("unknown license should warn, got %s", v.Decision)
	}
}

func TestUnknownAgeWarnsByDefault(t *testing.T) {
	e := NewEngine(Default())
	m := model.VersionMeta{Ecosystem: model.NPM, Name: "fresh", Version: "0.0.1", License: "MIT", PublishedKnown: false}
	v := e.Evaluate(m, nil, refNow)
	if v.Decision != model.Warn {
		t.Fatalf("unknown age should warn by default, got %s", v.Decision)
	}
}

func TestUnknownAgeBlocksWhenStrict(t *testing.T) {
	p := Default()
	p.ReleaseAge.BlockOnUnknown = true
	e := NewEngine(p)
	m := model.VersionMeta{Ecosystem: model.NPM, Name: "fresh", Version: "0.0.1", License: "MIT", PublishedKnown: false}
	if v := e.Evaluate(m, nil, refNow); v.Decision != model.Block {
		t.Fatalf("unknown age with blockOnUnknown should block, got %s", v.Decision)
	}
}

func TestCVEHighBlocks(t *testing.T) {
	e := NewEngine(Default())
	vulns := []model.Vuln{{ID: "GHSA-xxxx", Severity: model.SeverityHigh}}
	v := e.Evaluate(metaAt("vulnpkg", "1.0.0", "MIT", 30), vulns, refNow)
	if v.Decision != model.Block {
		t.Fatalf("HIGH cve should block, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestCVELowDoesNotBlock(t *testing.T) {
	e := NewEngine(Default())
	vulns := []model.Vuln{{ID: "GHSA-low", Severity: model.SeverityLow}}
	v := e.Evaluate(metaAt("vulnpkg", "1.0.0", "MIT", 30), vulns, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("LOW cve under HIGH threshold should allow, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestCVEUnknownSeverityBlocksFailSafe(t *testing.T) {
	e := NewEngine(Default())
	vulns := []model.Vuln{{ID: "OSV-unscored", Severity: model.SeverityUnknown}}
	v := e.Evaluate(metaAt("vulnpkg", "1.0.0", "MIT", 30), vulns, refNow)
	if v.Decision != model.Block {
		t.Fatalf("unscored vuln should block (fail-safe), got %s", v.Decision)
	}
}

func TestMultipleReasonsAccumulate(t *testing.T) {
	e := NewEngine(Default())
	// fresh + GPL + HIGH cve all at once.
	vulns := []model.Vuln{{ID: "GHSA-y", Severity: model.SeverityCritical}}
	v := e.Evaluate(metaAt("triple", "1.0.0", "GPL-3.0", 1), vulns, refNow)
	if v.Decision != model.Block {
		t.Fatalf("expected block, got %s", v.Decision)
	}
	if len(v.Reasons) < 3 {
		t.Fatalf("expected >=3 accumulated reasons, got %d: %+v", len(v.Reasons), v.Reasons)
	}
}

func TestWarnOnlyCooldownDoesNotBlock(t *testing.T) {
	p := Default()
	p.ReleaseAge.WarnOnly = true
	e := NewEngine(p)
	v := e.Evaluate(metaAt("fresh", "1.0.0", "MIT", 1), nil, refNow)
	if v.Decision != model.Warn {
		t.Fatalf("warnOnly cooldown should warn not block, got %s", v.Decision)
	}
}

func TestCVEDisabledWhenMaxSeverityEmpty(t *testing.T) {
	p := Default()
	p.CVE.MaxSeverity = "" // disable CVE gating entirely
	e := NewEngine(p)
	v := e.Evaluate(metaAt("pkg", "1.0.0", "MIT", 30),
		[]model.Vuln{{ID: "GHSA-x", Severity: model.SeverityCritical}}, refNow)
	if v.Decision != model.Allow {
		t.Fatalf("maxSeverity=\"\" should ignore even a CRITICAL vuln, got %s (%+v)", v.Decision, v.Reasons)
	}
}

func TestLicenseBlocklistOnly(t *testing.T) {
	p := Default()
	p.License.Allow = nil // empty allow => allow anything not blocked
	p.License.Block = []string{"GPL-3.0"}
	e := NewEngine(p)
	if d := e.Evaluate(metaAt("pkg", "1.0.0", "GPL-3.0", 30), nil, refNow).Decision; d != model.Block {
		t.Fatalf("blocked license should block, got %s", d)
	}
	if d := e.Evaluate(metaAt("pkg", "2.0.0", "WTFPL", 30), nil, refNow).Decision; d != model.Allow {
		t.Fatalf("non-blocked license should allow with empty allowlist, got %s", d)
	}
}

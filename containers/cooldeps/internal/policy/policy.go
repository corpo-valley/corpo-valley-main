// Package policy defines the declarative gate policy and a pure engine that
// turns (version metadata + vulns) into an allow/warn/block verdict. The engine
// performs no I/O so it is trivially testable; sources and caches feed it.
package policy

import (
	"fmt"
	"strings"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// Policy is the `policy:` section of the cooldeps config (see
// docs/config-schema.md). It is decoded by the config loader on top of
// Default(); Validate() guards it.
type Policy struct {
	License    LicensePolicy    `yaml:"license"`
	ReleaseAge ReleaseAgePolicy `yaml:"releaseAge"`
	CVE        CVEPolicy        `yaml:"cve"`
	FailOpen   bool             `yaml:"failOpen"`
	Overrides  Overrides        `yaml:"overrides"`
}

type LicensePolicy struct {
	Allow         []string `yaml:"allow"`
	Block         []string `yaml:"block"`
	WarnOnUnknown bool     `yaml:"warnOnUnknown"`
}

type ReleaseAgePolicy struct {
	MinDays        int  `yaml:"minDays"`
	WarnOnly       bool `yaml:"warnOnly"`
	BlockOnUnknown bool `yaml:"blockOnUnknown"` // strict: block versions with no known release date
}

type CVEPolicy struct {
	MaxSeverity   string `yaml:"maxSeverity"` // NONE|LOW|MEDIUM|HIGH|CRITICAL
	WarnOnly      bool   `yaml:"warnOnly"`
	FetchSeverity bool   `yaml:"fetchSeverity"`
}

// Overrides pin specific packages/versions to a decision regardless of the
// other checks. `allow` lets a freshly-published critical fix through the
// cooldown/CVE gate; `block` is incident-response (kill a known-bad release).
// Entries are "ecosystem:name@version", "ecosystem:name", "name@version", or
// "name". A bare name (no @version) matches every version of that package.
type Overrides struct {
	Allow []string `yaml:"allow"`
	Block []string `yaml:"block"`
}

// Default returns the baked-in MVP policy from the design doc (§4).
func Default() Policy {
	p := Policy{
		License: LicensePolicy{
			Allow:         []string{"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"},
			Block:         []string{"GPL-3.0", "AGPL-3.0"},
			WarnOnUnknown: true,
		},
		ReleaseAge: ReleaseAgePolicy{MinDays: 14, WarnOnly: false, BlockOnUnknown: false},
		CVE:        CVEPolicy{MaxSeverity: "HIGH", WarnOnly: false, FetchSeverity: true},
		FailOpen:   false,
	}
	return p
}

// Validate catches misconfigurations that would otherwise fail open silently.
func (p Policy) Validate() error {
	if p.CVE.MaxSeverity != "" && model.ParseSeverity(p.CVE.MaxSeverity) == model.SeverityUnknown {
		return fmt.Errorf("policy: cve.maxSeverity %q is not a valid band (NONE|LOW|MEDIUM|HIGH|CRITICAL)", p.CVE.MaxSeverity)
	}
	if p.ReleaseAge.MinDays < 0 {
		return fmt.Errorf("policy: releaseAge.minDays must be >= 0")
	}
	for _, e := range append(append([]string{}, p.Overrides.Allow...), p.Overrides.Block...) {
		if strings.TrimSpace(e) == "" {
			return fmt.Errorf("policy: empty override entry")
		}
	}
	return nil
}

// NeedsVulnData reports whether any version needs an OSV lookup at all.
func (p Policy) NeedsVulnData() bool { return p.CVE.MaxSeverity != "" }

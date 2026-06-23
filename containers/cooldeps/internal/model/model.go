// Package model holds the small, dependency-free types shared across the
// cooldeps proxy: ecosystems, per-version metadata, vulnerabilities, and the
// allow/warn/block verdict the policy engine produces. Keeping these here lets
// the policy engine stay pure (no I/O, no registry knowledge) while sources,
// caches, and backends all speak the same vocabulary.
package model

import (
	"strings"
	"time"
)

// Ecosystem identifies a package registry the proxy gates.
type Ecosystem string

const (
	NPM  Ecosystem = "npm"
	PyPI Ecosystem = "pypi"
	Go   Ecosystem = "go"
)

// VersionMeta is the immutable, per-version metadata the engine reasons about.
// PublishedKnown distinguishes "published at the zero time" (impossible) from
// "we don't know when this was published" — the cooldown rule treats those
// cases differently (see policy.Engine).
type VersionMeta struct {
	Ecosystem      Ecosystem
	Name           string
	Version        string
	PublishedAt    time.Time
	PublishedKnown bool
	License        string // raw SPDX expression or id as reported upstream; "" if unknown
}

// Severity is an ordered CVE severity band. Higher is worse. Unknown sorts
// above Critical on purpose: an unscored vuln must never silently pass a
// maxSeverity gate (fail-safe), so it compares as "at least as bad as anything".
type Severity int

const (
	SeverityNone Severity = iota
	SeverityLow
	SeverityMedium
	SeverityHigh
	SeverityCritical
	SeverityUnknown
)

// ParseSeverity maps a policy/string band to a Severity. Unrecognised input
// (including "") yields SeverityUnknown.
func ParseSeverity(s string) Severity {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "NONE":
		return SeverityNone
	case "LOW":
		return SeverityLow
	case "MEDIUM", "MODERATE":
		return SeverityMedium
	case "HIGH":
		return SeverityHigh
	case "CRITICAL":
		return SeverityCritical
	default:
		return SeverityUnknown
	}
}

func (s Severity) String() string {
	switch s {
	case SeverityNone:
		return "NONE"
	case SeverityLow:
		return "LOW"
	case SeverityMedium:
		return "MEDIUM"
	case SeverityHigh:
		return "HIGH"
	case SeverityCritical:
		return "CRITICAL"
	default:
		return "UNKNOWN"
	}
}

// AtLeast reports whether s is at least as severe as the threshold. Unknown is
// treated as offending against any concrete threshold (fail-safe), but an
// Unknown threshold (a misconfigured policy) is never satisfied by None.
func (s Severity) AtLeast(threshold Severity) bool {
	if s == SeverityUnknown {
		return true
	}
	return s >= threshold
}

// Vuln is one OSV advisory affecting a version. Severity may be Unknown when it
// has not been (or cannot be) resolved to a band.
type Vuln struct {
	ID       string
	Severity Severity
}

// Decision is the policy ladder. It can only escalate: allow < warn < block.
type Decision int

const (
	Allow Decision = iota
	Warn
	Block
)

func (d Decision) String() string {
	switch d {
	case Warn:
		return "warn"
	case Block:
		return "block"
	default:
		return "allow"
	}
}

// MarshalJSON renders the decision as its lowercase string so rejection bodies
// and the /status endpoint read naturally ("block", not 2).
func (d Decision) MarshalJSON() ([]byte, error) {
	return []byte(`"` + d.String() + `"`), nil
}

// Reason is a single human-readable justification for (part of) a verdict.
type Reason struct {
	Check    string   `json:"check"`    // "cooldown" | "license" | "cve" | "override"
	Decision Decision `json:"decision"` // contribution of this check
	Message  string   `json:"message"`
}

// Verdict is the engine's combined output for one version.
type Verdict struct {
	Decision Decision `json:"decision"`
	Reasons  []Reason `json:"reasons"`
}

// Blocked is a convenience for the common branch.
func (v Verdict) Blocked() bool { return v.Decision == Block }

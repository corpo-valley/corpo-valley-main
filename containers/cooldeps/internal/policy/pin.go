package policy

import (
	"strings"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// pin is a parsed override entry. Ecosystem/Version may be empty meaning
// "any" — a bare "name" matches every version in every ecosystem.
type pin struct {
	Ecosystem model.Ecosystem // "" = any
	Name      string          // normalised (lowercased)
	Version   string          // "" = any version
}

type pinSet struct {
	pins []pin
}

func newPinSet(entries []string) pinSet {
	ps := pinSet{}
	for _, e := range entries {
		if p, ok := parsePin(e); ok {
			ps.pins = append(ps.pins, p)
		}
	}
	return ps
}

// parsePin understands:
//
//	npm:left-pad@1.3.0   -> {npm, left-pad, 1.3.0}
//	pypi:requests        -> {pypi, requests, ""}
//	left-pad@1.3.0       -> {"", left-pad, 1.3.0}
//	@types/node@1.2.3    -> {"", @types/node, 1.2.3}  (scoped npm name)
//	@types/node          -> {"", @types/node, ""}
func parsePin(entry string) (pin, bool) {
	s := strings.TrimSpace(entry)
	if s == "" {
		return pin{}, false
	}
	p := pin{}
	// Optional "ecosystem:" prefix. Guard against the ':' that can't appear in a
	// package name; npm/pypi/go names never contain ':'.
	if i := strings.Index(s, ":"); i > 0 {
		switch model.Ecosystem(strings.ToLower(s[:i])) {
		case model.NPM, model.PyPI, model.Go:
			p.Ecosystem = model.Ecosystem(strings.ToLower(s[:i]))
			s = s[i+1:]
		}
	}
	// Version is everything after the LAST '@', but a leading '@' (scoped npm
	// name) is part of the name, not a version separator.
	if at := strings.LastIndex(s, "@"); at > 0 {
		p.Name = strings.TrimSpace(s[:at])
		p.Version = strings.TrimSpace(s[at+1:])
	} else {
		p.Name = strings.TrimSpace(s)
	}
	if p.Name == "" {
		return pin{}, false
	}
	p.Name = strings.ToLower(p.Name)
	return p, true
}

func (ps pinSet) matches(eco model.Ecosystem, name, version string) bool {
	name = strings.ToLower(name)
	for _, p := range ps.pins {
		if p.Ecosystem != "" && p.Ecosystem != eco {
			continue
		}
		if p.Name != name {
			continue
		}
		if p.Version != "" && p.Version != version {
			continue
		}
		return true
	}
	return false
}

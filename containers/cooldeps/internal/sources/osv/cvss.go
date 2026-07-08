package osv

import (
	"math"
	"strings"
)

// CVSSBaseScore parses a CVSS v3.0/v3.1 vector string and computes its base
// score per the official specification. It returns (score, true) on success, or
// (0, false) for an unparseable / non-v3 vector (e.g. a CVSS v2 vector), letting
// the caller fall back to a textual band or Unknown.
//
// This is a compact, dependency-free implementation of the documented formula —
// enough to band advisories (low/medium/high/critical) accurately. It does not
// handle temporal/environmental metrics (not needed for a base-severity gate).
func CVSSBaseScore(vector string) (float64, bool) {
	vector = strings.TrimSpace(vector)
	if vector == "" {
		return 0, false
	}
	m := map[string]string{}
	for _, part := range strings.Split(vector, "/") {
		kv := strings.SplitN(part, ":", 2)
		if len(kv) != 2 {
			continue
		}
		m[strings.ToUpper(kv[0])] = strings.ToUpper(kv[1])
	}
	// Require the v3 prefix and the mandatory base metrics.
	if v := m["CVSS"]; v != "3.0" && v != "3.1" {
		return 0, false
	}
	av, ok1 := attackVector(m["AV"])
	ac, ok2 := attackComplexity(m["AC"])
	ui, ok3 := userInteraction(m["UI"])
	scopeChanged, ok4 := scope(m["S"])
	pr, ok5 := privilegesRequired(m["PR"], scopeChanged)
	c, ok6 := impact(m["C"])
	i, ok7 := impact(m["I"])
	a, ok8 := impact(m["A"])
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8) {
		return 0, false
	}

	iscBase := 1 - (1-c)*(1-i)*(1-a)
	var impactScore float64
	if scopeChanged {
		impactScore = 7.52*(iscBase-0.029) - 3.25*math.Pow(iscBase-0.02, 15)
	} else {
		impactScore = 6.42 * iscBase
	}
	if impactScore <= 0 {
		return 0, true
	}
	exploitability := 8.22 * av * ac * pr * ui
	var base float64
	if scopeChanged {
		base = roundUp(math.Min(1.08*(impactScore+exploitability), 10))
	} else {
		base = roundUp(math.Min(impactScore+exploitability, 10))
	}
	return base, true
}

// roundUp implements the CVSS v3.1 "Roundup" to one decimal place.
func roundUp(x float64) float64 {
	return math.Ceil(x*10) / 10
}

func attackVector(v string) (float64, bool) {
	switch v {
	case "N":
		return 0.85, true
	case "A":
		return 0.62, true
	case "L":
		return 0.55, true
	case "P":
		return 0.2, true
	}
	return 0, false
}

func attackComplexity(v string) (float64, bool) {
	switch v {
	case "L":
		return 0.77, true
	case "H":
		return 0.44, true
	}
	return 0, false
}

func userInteraction(v string) (float64, bool) {
	switch v {
	case "N":
		return 0.85, true
	case "R":
		return 0.62, true
	}
	return 0, false
}

func scope(v string) (changed bool, ok bool) {
	switch v {
	case "U":
		return false, true
	case "C":
		return true, true
	}
	return false, false
}

func privilegesRequired(v string, scopeChanged bool) (float64, bool) {
	switch v {
	case "N":
		return 0.85, true
	case "L":
		if scopeChanged {
			return 0.68, true
		}
		return 0.62, true
	case "H":
		if scopeChanged {
			return 0.5, true
		}
		return 0.27, true
	}
	return 0, false
}

func impact(v string) (float64, bool) {
	switch v {
	case "H":
		return 0.56, true
	case "L":
		return 0.22, true
	case "N":
		return 0.0, true
	}
	return 0, false
}

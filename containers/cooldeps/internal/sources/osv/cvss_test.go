package osv

import (
	"math"
	"testing"
)

func TestCVSSKnownVectors(t *testing.T) {
	cases := []struct {
		vec  string
		want float64
	}{
		// Canonical examples from the CVSS 3.1 spec / NVD.
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8},  // critical
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5},  // high
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0}, // scope changed
		{"CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N", 2.6},  // low
		{"CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8},  // v3.0 prefix
	}
	for _, tc := range cases {
		got, ok := CVSSBaseScore(tc.vec)
		if !ok {
			t.Fatalf("%s: expected parse ok", tc.vec)
		}
		if math.Abs(got-tc.want) > 0.1 {
			t.Errorf("%s: got %.1f want %.1f", tc.vec, got, tc.want)
		}
	}
}

func TestCVSSRejectsV2(t *testing.T) {
	if _, ok := CVSSBaseScore("AV:N/AC:L/Au:N/C:P/I:P/A:P"); ok {
		t.Fatal("v2 vector should not parse as v3")
	}
}

func TestBandFromScore(t *testing.T) {
	cases := []struct {
		score float64
		want  string
	}{
		{0, "NONE"}, {3.9, "LOW"}, {4.0, "MEDIUM"}, {6.9, "MEDIUM"},
		{7.0, "HIGH"}, {8.9, "HIGH"}, {9.0, "CRITICAL"}, {10, "CRITICAL"},
	}
	for _, tc := range cases {
		if got := bandFromScore(tc.score).String(); got != tc.want {
			t.Errorf("score %.1f: got %s want %s", tc.score, got, tc.want)
		}
	}
}

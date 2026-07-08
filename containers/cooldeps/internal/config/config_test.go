package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// envKeys are the COOLDEPS_* overrides plus the config-path var; tests clear them
// so a dirty ambient environment can't leak into assertions.
var envKeys = []string{
	ConfigPathEnv,
	"COOLDEPS_SERVER_ADDR", "COOLDEPS_SERVER_STATUSENABLED", "COOLDEPS_SERVER_LOGLEVEL",
	"COOLDEPS_SERVER_NPMUPSTREAM", "COOLDEPS_SERVER_PYPIUPSTREAM", "COOLDEPS_SERVER_GOUPSTREAM",
	"COOLDEPS_SERVER_PUBLICURL",
	"COOLDEPS_CACHE_DATADIR", "COOLDEPS_CACHE_ARTIFACTS", "COOLDEPS_CACHE_ARTIFACTDIR",
	"COOLDEPS_CACHE_ARTIFACTMAXBYTES", "COOLDEPS_CACHE_VULNTTL", "COOLDEPS_CACHE_METATTL",
	"COOLDEPS_CACHE_METANOTFOUNDREFRESH", "COOLDEPS_CACHE_FETCHCONCURRENCY",
	"COOLDEPS_POLICY_FAILOPEN", "COOLDEPS_POLICY_LICENSE_WARNONUNKNOWN",
	"COOLDEPS_POLICY_RELEASEAGE_MINDAYS", "COOLDEPS_POLICY_RELEASEAGE_WARNONLY",
	"COOLDEPS_POLICY_RELEASEAGE_BLOCKONUNKNOWN", "COOLDEPS_POLICY_CVE_MAXSEVERITY",
	"COOLDEPS_POLICY_CVE_WARNONLY", "COOLDEPS_POLICY_CVE_FETCHSEVERITY",
}

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range envKeys {
		t.Setenv(k, "")
	}
}

// writeConfig writes a config file and points COOLDEPS_CONFIG at it.
func writeConfig(t *testing.T, body string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "cooldeps.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ConfigPathEnv, p)
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load with clean env: %v", err)
	}
	if c.Server.Addr != ":8080" || c.Server.LogLevel != "info" {
		t.Fatalf("server defaults: %+v", c.Server)
	}
	if !c.Cache.Artifacts || int64(c.Cache.ArtifactMaxBytes) != 40<<30 || c.Cache.FetchConcurrency != 8 {
		t.Fatalf("cache defaults: %+v", c.Cache)
	}
	if c.Cache.VulnTTL.Std() != 6*time.Hour || c.Cache.MetaTTL.Std() != 0 || c.Cache.MetaNotFoundRefresh.Std() != 30*time.Minute {
		t.Fatalf("cache ttl defaults: %+v", c.Cache)
	}
	if c.Cache.ArtifactDir != "/data/artifacts" {
		t.Fatalf("derived artifactDir = %q", c.Cache.ArtifactDir)
	}
	if c.Policy.ReleaseAge.MinDays != 14 || c.Policy.CVE.MaxSeverity != "HIGH" {
		t.Fatalf("policy defaults not applied: %+v", c.Policy)
	}
}

func TestLoadFile(t *testing.T) {
	clearEnv(t)
	writeConfig(t, `
server:
  addr: ":9000"
  statusEnabled: true
cache:
  vulnTTL: 30m
  metaTTL: 720h
  artifactMaxBytes: 512MB
policy:
  releaseAge:
    minDays: 7
  cve:
    maxSeverity: CRITICAL
  license:
    allow: [MIT]
    block: []
`)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Server.Addr != ":9000" || !c.Server.StatusEnabled {
		t.Fatalf("server section: %+v", c.Server)
	}
	if c.Cache.VulnTTL.Std() != 30*time.Minute || c.Cache.MetaTTL.Std() != 720*time.Hour || int64(c.Cache.ArtifactMaxBytes) != 512*1000*1000 {
		t.Fatalf("cache section: %+v", c.Cache)
	}
	if c.Policy.ReleaseAge.MinDays != 7 || c.Policy.CVE.MaxSeverity != "CRITICAL" {
		t.Fatalf("policy section: %+v", c.Policy)
	}
	// A field absent from the file keeps its default (overlay, not replace).
	if c.Cache.FetchConcurrency != 8 {
		t.Fatalf("absent field should keep default, got %d", c.Cache.FetchConcurrency)
	}
}

func TestFileRejectsUnknownField(t *testing.T) {
	clearEnv(t)
	writeConfig(t, "cache:\n  vulnTTLL: 30m\n")
	if _, err := Load(); err == nil {
		t.Fatal("expected unknown-field error")
	}
}

func TestEnvOverridesFile(t *testing.T) {
	clearEnv(t)
	writeConfig(t, "server:\n  addr: \":9000\"\ncache:\n  metaTTL: 1h\n")
	t.Setenv("COOLDEPS_SERVER_ADDR", ":7777")
	t.Setenv("COOLDEPS_CACHE_METATTL", "48h")
	t.Setenv("COOLDEPS_POLICY_FAILOPEN", "true")
	t.Setenv("COOLDEPS_POLICY_CVE_MAXSEVERITY", "LOW")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Server.Addr != ":7777" {
		t.Fatalf("env should override file addr, got %q", c.Server.Addr)
	}
	if c.Cache.MetaTTL.Std() != 48*time.Hour {
		t.Fatalf("env should override file metaTTL, got %s", c.Cache.MetaTTL.Std())
	}
	if !c.Policy.FailOpen || c.Policy.CVE.MaxSeverity != "LOW" {
		t.Fatalf("policy scalar env overrides not applied: %+v", c.Policy)
	}
}

func TestMalformedEnvAggregates(t *testing.T) {
	clearEnv(t)
	t.Setenv("COOLDEPS_CACHE_FETCHCONCURRENCY", "abc")
	t.Setenv("COOLDEPS_CACHE_VULNTTL", "6hours")
	t.Setenv("COOLDEPS_CACHE_ARTIFACTMAXBYTES", "lots")
	t.Setenv("COOLDEPS_SERVER_STATUSENABLED", "maybe")
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for malformed env")
	}
	for _, want := range []string{"FETCHCONCURRENCY", "VULNTTL", "ARTIFACTMAXBYTES", "STATUSENABLED"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name %s: %v", want, err)
		}
	}
}

func TestValidate(t *testing.T) {
	base := func() Config { return defaults() }
	if err := base().Validate(); err != nil {
		t.Fatalf("defaults should be valid: %v", err)
	}

	cases := map[string]func(*Config){
		"server.addr":            func(c *Config) { c.Server.Addr = "nope" },
		"server.npmUpstream":     func(c *Config) { c.Server.NPMUpstream = "ftp://x" },
		"missing host":           func(c *Config) { c.Server.PyPIUpstream = "https://" },
		"server.logLevel":        func(c *Config) { c.Server.LogLevel = "loud" },
		"cache.fetchConcurrency": func(c *Config) { c.Cache.FetchConcurrency = 0 },
		"cache.artifactMaxBytes": func(c *Config) { c.Cache.ArtifactMaxBytes = 0 },
		"cache.vulnTTL":          func(c *Config) { c.Cache.VulnTTL = Duration(-time.Second) },
		"policy":                 func(c *Config) { c.Policy.CVE.MaxSeverity = "BOGUS" },
	}
	for name, mut := range cases {
		c := base()
		mut(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}

	// Artifact size 0 is fine when the artifact cache is off.
	c := base()
	c.Cache.Artifacts = false
	c.Cache.ArtifactMaxBytes = 0
	if err := c.Validate(); err != nil {
		t.Errorf("0 bytes with cache off should be valid: %v", err)
	}
}

func TestParseBytesGrammar(t *testing.T) {
	cases := map[string]int64{
		"1024": 1024, "40GiB": 40 << 30, "512MB": 512 * 1000 * 1000,
		"1.5KiB": 1536, "2GB": 2 * 1000 * 1000 * 1000,
	}
	for in, want := range cases {
		got, err := parseBytes(in)
		if err != nil || got != want {
			t.Errorf("parseBytes(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := parseBytes("lots"); err == nil {
		t.Error(`parseBytes("lots") should error`)
	}
}

func TestEnvBytesAndDurationParseLikeFile(t *testing.T) {
	clearEnv(t)
	t.Setenv("COOLDEPS_CACHE_ARTIFACTMAXBYTES", "1GiB")
	t.Setenv("COOLDEPS_CACHE_METANOTFOUNDREFRESH", "45m")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if int64(c.Cache.ArtifactMaxBytes) != 1<<30 {
		t.Fatalf("env Bytes parse: got %d", int64(c.Cache.ArtifactMaxBytes))
	}
	if c.Cache.MetaNotFoundRefresh.Std() != 45*time.Minute {
		t.Fatalf("env Duration parse: got %s", c.Cache.MetaNotFoundRefresh.Std())
	}
}

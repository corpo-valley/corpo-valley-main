// Package config loads cooldeps' unified runtime configuration: a single YAML
// file with `server`, `cache`, and `policy` sections, layered as
//
//	built-in defaults  <  config file  <  environment variables
//
// Environment overrides follow a strict, mechanical convention so the mapping
// never drifts and is trivial to reimplement in a port:
//
//	COOLDEPS_<SECTION>_<FIELD>     e.g. COOLDEPS_CACHE_METATTL, COOLDEPS_SERVER_ADDR
//	COOLDEPS_POLICY_<SUB>_<FIELD>  e.g. COOLDEPS_POLICY_CVE_MAXSEVERITY
//
// Each variable overrides exactly the scalar field its name spells out (list
// fields — license/override lists — are file-only). Malformed values and
// semantically-invalid config are reported and cause a non-zero exit rather than
// silently falling back, mirroring the strict policy loader.
package config

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hashtagcyber/cooldeps/internal/policy"
)

// ConfigPathEnv is the one bootstrap variable: the path to the YAML config file.
// Unset => run on built-in defaults plus any COOLDEPS_* overrides.
const ConfigPathEnv = "COOLDEPS_CONFIG"

// Config is the whole configuration tree.
type Config struct {
	Server Server        `yaml:"server"`
	Cache  Cache         `yaml:"cache"`
	Policy policy.Policy `yaml:"policy"`
}

// Server is how the proxy runs and what it proxies to.
type Server struct {
	Addr          string `yaml:"addr"`          // COOLDEPS_SERVER_ADDR
	StatusEnabled bool   `yaml:"statusEnabled"` // COOLDEPS_SERVER_STATUSENABLED
	LogLevel      string `yaml:"logLevel"`      // COOLDEPS_SERVER_LOGLEVEL
	NPMUpstream   string `yaml:"npmUpstream"`   // COOLDEPS_SERVER_NPMUPSTREAM
	PyPIUpstream  string `yaml:"pypiUpstream"`  // COOLDEPS_SERVER_PYPIUPSTREAM
	GoUpstream    string `yaml:"goUpstream"`    // COOLDEPS_SERVER_GOUPSTREAM
	PublicURL     string `yaml:"publicURL"`     // COOLDEPS_SERVER_PUBLICURL
}

// Cache is storage and freshness tuning.
type Cache struct {
	DataDir             string   `yaml:"dataDir"`             // COOLDEPS_CACHE_DATADIR
	Artifacts           bool     `yaml:"artifacts"`           // COOLDEPS_CACHE_ARTIFACTS
	ArtifactDir         string   `yaml:"artifactDir"`         // COOLDEPS_CACHE_ARTIFACTDIR
	ArtifactMaxBytes    Bytes    `yaml:"artifactMaxBytes"`    // COOLDEPS_CACHE_ARTIFACTMAXBYTES
	VulnTTL             Duration `yaml:"vulnTTL"`             // COOLDEPS_CACHE_VULNTTL
	MetaTTL             Duration `yaml:"metaTTL"`             // COOLDEPS_CACHE_METATTL
	MetaNotFoundRefresh Duration `yaml:"metaNotFoundRefresh"` // COOLDEPS_CACHE_METANOTFOUNDREFRESH
	FetchConcurrency    int      `yaml:"fetchConcurrency"`    // COOLDEPS_CACHE_FETCHCONCURRENCY
}

// defaults returns the built-in configuration (used when no file/env is given).
func defaults() Config {
	return Config{
		Server: Server{
			Addr:         ":8080",
			LogLevel:     "info",
			NPMUpstream:  "https://registry.npmjs.org",
			PyPIUpstream: "https://pypi.org",
			GoUpstream:   "https://proxy.golang.org",
		},
		Cache: Cache{
			DataDir:             "/data",
			Artifacts:           true,
			ArtifactMaxBytes:    Bytes(40 << 30), // 40 GiB
			VulnTTL:             Duration(6 * time.Hour),
			MetaTTL:             0, // found metadata kept forever
			MetaNotFoundRefresh: Duration(30 * time.Minute),
			FetchConcurrency:    8,
		},
		Policy: policy.Default(),
	}
}

// Load assembles the configuration: defaults, then the YAML file at
// $COOLDEPS_CONFIG (if set), then COOLDEPS_* environment overrides; then it
// validates. The returned Config is populated even on error so callers can log
// the effective values, but it must not be used to serve when err != nil.
func Load() (Config, error) {
	c := defaults()

	// 1) File overlay (strict: unknown keys are an error so typos surface).
	if path := os.Getenv(ConfigPathEnv); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return c, fmt.Errorf("config: read %s: %w", path, err)
		}
		dec := yaml.NewDecoder(strings.NewReader(string(b)))
		dec.KnownFields(true)
		if err := dec.Decode(&c); err != nil && !errors.Is(err, io.EOF) {
			return c, fmt.Errorf("config: parse %s: %w", path, err)
		}
	}

	// 2) Environment overrides.
	l := &loader{}
	applyEnv(&c, l)
	if len(l.errs) > 0 {
		return c, fmt.Errorf("config: malformed environment: %w", errors.Join(l.errs...))
	}

	// 3) Derived defaults.
	if c.Cache.ArtifactDir == "" {
		c.Cache.ArtifactDir = strings.TrimRight(c.Cache.DataDir, "/") + "/artifacts"
	}

	// 4) Validate.
	if err := c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}

// DBPath returns the bbolt database path inside the data dir.
func (c Config) DBPath() string {
	return strings.TrimRight(c.Cache.DataDir, "/") + "/cooldeps.db"
}

// applyEnv overlays COOLDEPS_* variables onto c. Only fields whose variable is
// set (to a non-empty value) are changed; parse failures are collected on l.
func applyEnv(c *Config, l *loader) {
	s := &c.Server
	l.str(&s.Addr, "COOLDEPS_SERVER_ADDR")
	l.boolean(&s.StatusEnabled, "COOLDEPS_SERVER_STATUSENABLED")
	l.str(&s.LogLevel, "COOLDEPS_SERVER_LOGLEVEL")
	l.str(&s.NPMUpstream, "COOLDEPS_SERVER_NPMUPSTREAM")
	l.str(&s.PyPIUpstream, "COOLDEPS_SERVER_PYPIUPSTREAM")
	l.str(&s.GoUpstream, "COOLDEPS_SERVER_GOUPSTREAM")
	l.str(&s.PublicURL, "COOLDEPS_SERVER_PUBLICURL")

	ch := &c.Cache
	l.str(&ch.DataDir, "COOLDEPS_CACHE_DATADIR")
	l.boolean(&ch.Artifacts, "COOLDEPS_CACHE_ARTIFACTS")
	l.str(&ch.ArtifactDir, "COOLDEPS_CACHE_ARTIFACTDIR")
	l.bytes(&ch.ArtifactMaxBytes, "COOLDEPS_CACHE_ARTIFACTMAXBYTES")
	l.duration(&ch.VulnTTL, "COOLDEPS_CACHE_VULNTTL")
	l.duration(&ch.MetaTTL, "COOLDEPS_CACHE_METATTL")
	l.duration(&ch.MetaNotFoundRefresh, "COOLDEPS_CACHE_METANOTFOUNDREFRESH")
	l.integer(&ch.FetchConcurrency, "COOLDEPS_CACHE_FETCHCONCURRENCY")

	// Policy scalar leaves only — lists (license/override) stay file-only.
	p := &c.Policy
	l.boolean(&p.FailOpen, "COOLDEPS_POLICY_FAILOPEN")
	l.boolean(&p.License.WarnOnUnknown, "COOLDEPS_POLICY_LICENSE_WARNONUNKNOWN")
	l.integer(&p.ReleaseAge.MinDays, "COOLDEPS_POLICY_RELEASEAGE_MINDAYS")
	l.boolean(&p.ReleaseAge.WarnOnly, "COOLDEPS_POLICY_RELEASEAGE_WARNONLY")
	l.boolean(&p.ReleaseAge.BlockOnUnknown, "COOLDEPS_POLICY_RELEASEAGE_BLOCKONUNKNOWN")
	l.str(&p.CVE.MaxSeverity, "COOLDEPS_POLICY_CVE_MAXSEVERITY")
	l.boolean(&p.CVE.WarnOnly, "COOLDEPS_POLICY_CVE_WARNONLY")
	l.boolean(&p.CVE.FetchSeverity, "COOLDEPS_POLICY_CVE_FETCHSEVERITY")
}

// Validate catches semantically-bad configuration before the server starts.
func (c Config) Validate() error {
	var errs []error

	if _, port, err := net.SplitHostPort(c.Server.Addr); err != nil {
		errs = append(errs, fmt.Errorf("server.addr %q is not a valid listen address (want host:port, e.g. :8080)", c.Server.Addr))
	} else if port == "" {
		errs = append(errs, fmt.Errorf("server.addr %q has no port", c.Server.Addr))
	}

	for _, u := range []struct{ name, val string }{
		{"server.npmUpstream", c.Server.NPMUpstream},
		{"server.pypiUpstream", c.Server.PyPIUpstream},
		{"server.goUpstream", c.Server.GoUpstream},
	} {
		if err := validateUpstream(u.val); err != nil {
			errs = append(errs, fmt.Errorf("%s %q: %w", u.name, u.val, err))
		}
	}
	if c.Server.PublicURL != "" {
		if err := validateUpstream(c.Server.PublicURL); err != nil {
			errs = append(errs, fmt.Errorf("server.publicURL %q: %w", c.Server.PublicURL, err))
		}
	}
	switch c.Server.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("server.logLevel %q is not one of debug|info|warn|error", c.Server.LogLevel))
	}

	if c.Cache.FetchConcurrency < 1 {
		errs = append(errs, fmt.Errorf("cache.fetchConcurrency must be >= 1, got %d", c.Cache.FetchConcurrency))
	}
	if c.Cache.Artifacts && c.Cache.ArtifactMaxBytes < 1 {
		errs = append(errs, fmt.Errorf("cache.artifactMaxBytes must be >= 1 when cache.artifacts is on, got %d", int64(c.Cache.ArtifactMaxBytes)))
	}
	for _, d := range []struct {
		name string
		val  Duration
	}{
		{"cache.vulnTTL", c.Cache.VulnTTL},
		{"cache.metaTTL", c.Cache.MetaTTL},
		{"cache.metaNotFoundRefresh", c.Cache.MetaNotFoundRefresh},
	} {
		if d.val < 0 {
			errs = append(errs, fmt.Errorf("%s must be >= 0, got %s", d.name, d.val.Std()))
		}
	}

	if err := c.Policy.Validate(); err != nil {
		errs = append(errs, err)
	}

	if len(errs) > 0 {
		return fmt.Errorf("config: invalid: %w", errors.Join(errs...))
	}
	return nil
}

// validateUpstream requires an absolute http/https URL with a host.
func validateUpstream(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("scheme must be http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("missing host")
	}
	return nil
}

// --- typed YAML scalars (parsed identically by file and env) ---

// Duration is a time.Duration that decodes from a Go duration string ("6h",
// "30m", "0") in YAML, instead of a raw nanosecond count.
type Duration time.Duration

// Std returns the underlying time.Duration.
func (d Duration) Std() time.Duration { return time.Duration(d) }

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	v, err := parseDuration(n.Value)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}

// Bytes is an int64 byte count that decodes from a size string ("40GiB",
// "500MB") or a raw integer in YAML.
type Bytes int64

func (b *Bytes) UnmarshalYAML(n *yaml.Node) error {
	v, err := parseBytes(n.Value)
	if err != nil {
		return err
	}
	*b = Bytes(v)
	return nil
}

func parseDuration(s string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("%q: want a duration (e.g. 6h, 30m, 90s)", s)
	}
	return d, nil
}

// parseBytes accepts an optional, case-insensitive unit suffix (KB/MB/GB/TB
// decimal; KiB/MiB/GiB/TiB binary) or a raw byte count, with a fractional value.
func parseBytes(raw string) (int64, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return 0, fmt.Errorf("empty size")
	}
	mult := int64(1)
	upper := strings.ToUpper(v)
	for suffix, m := range map[string]int64{
		"KIB": 1 << 10, "MIB": 1 << 20, "GIB": 1 << 30, "TIB": 1 << 40,
		"KB": 1000, "MB": 1000 * 1000, "GB": 1000 * 1000 * 1000, "TB": 1000 * 1000 * 1000 * 1000,
	} {
		if strings.HasSuffix(upper, suffix) {
			mult = m
			v = strings.TrimSpace(upper[:len(upper)-len(suffix)])
			break
		}
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, fmt.Errorf("%q is not a valid size (e.g. 40GiB, 500MB, or a byte count)", raw)
	}
	return int64(n * float64(mult)), nil
}

// --- environment override helpers (collect parse errors) ---

type loader struct{ errs []error }

func (l *loader) str(dst *string, key string) {
	if v := os.Getenv(key); v != "" {
		*dst = v
	}
}

func (l *loader) boolean(dst *bool, key string) {
	v := os.Getenv(key)
	if v == "" {
		return
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		l.errs = append(l.errs, fmt.Errorf("%s=%q: want a boolean (true/false/1/0)", key, v))
		return
	}
	*dst = b
}

func (l *loader) integer(dst *int, key string) {
	v := os.Getenv(key)
	if v == "" {
		return
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		l.errs = append(l.errs, fmt.Errorf("%s=%q: want an integer", key, v))
		return
	}
	*dst = int(n)
}

func (l *loader) duration(dst *Duration, key string) {
	v := os.Getenv(key)
	if v == "" {
		return
	}
	d, err := parseDuration(v)
	if err != nil {
		l.errs = append(l.errs, fmt.Errorf("%s=%s", key, err))
		return
	}
	*dst = Duration(d)
}

func (l *loader) bytes(dst *Bytes, key string) {
	v := os.Getenv(key)
	if v == "" {
		return
	}
	n, err := parseBytes(v)
	if err != nil {
		l.errs = append(l.errs, fmt.Errorf("%s: %s", key, err))
		return
	}
	*dst = Bytes(n)
}

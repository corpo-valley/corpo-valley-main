// Package backend implements the ecosystem-specific HTTP gates: npm (gate the
// tarball fetch), PyPI (filter the Simple listing), and Go modules (gate the
// .zip). They share a Gate (the evaluator) and the artifact cache.
package backend

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// Gate is the slice of the evaluator the backends use.
type Gate interface {
	Evaluate(ctx context.Context, eco model.Ecosystem, name, version string) model.Verdict
	EvaluateMany(ctx context.Context, eco model.Ecosystem, name string, versions []string) map[string]model.Verdict
}

// Verdict header names. The trust token (X-Cooldeps-Trust) is reserved for the
// post-MVP upstream-chaining design; the MVP emits the verdict and reasons (plus
// X-Cooldeps-Cache on cacheable artifact responses).
const (
	headerVerdict = "X-Cooldeps-Verdict"
	headerReasons = "X-Cooldeps-Reasons"
)

// blockBody is the JSON returned on a 403 so a developer sees why an install was
// refused.
type blockBody struct {
	Error     string          `json:"error"`
	Ecosystem model.Ecosystem `json:"ecosystem"`
	Package   string          `json:"package"`
	Version   string          `json:"version"`
	Decision  model.Decision  `json:"decision"`
	Reasons   []model.Reason  `json:"reasons"`
}

// writeBlock emits the standard 403 rejection.
func writeBlock(w http.ResponseWriter, eco model.Ecosystem, name, version string, v model.Verdict, log *slog.Logger) {
	if log != nil {
		log.Info("blocked", "ecosystem", eco, "package", name, "version", version, "reasons", reasonsText(v))
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(headerVerdict, v.Decision.String())
	w.Header().Set(headerReasons, reasonsText(v))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(blockBody{
		Error:     "blocked by cooldown policy",
		Ecosystem: eco, Package: name, Version: version,
		Decision: v.Decision, Reasons: v.Reasons,
	})
}

func reasonsText(v model.Verdict) string {
	out := ""
	for i, r := range v.Reasons {
		if i > 0 {
			out += "; "
		}
		out += r.Check + ":" + r.Message
	}
	return out
}

// cacheTee wraps the artifact cache writer so a cache-side write error can NEVER
// abort the client copy. The artifact cache is a best-effort transparent tier;
// if its temp file fails mid-stream (e.g. the cache volume fills), we abort the
// cache write, set failed, and keep streaming the full body to the client.
// io.MultiWriter stops on the first writer error, so without this a cache disk
// error would truncate the developer's tarball/zip.
type cacheTee struct {
	w      io.Writer
	abort  func()
	failed bool
}

func (c *cacheTee) Write(p []byte) (int, error) {
	if c.failed {
		return len(p), nil
	}
	if _, err := c.w.Write(p); err != nil {
		c.abort()
		c.failed = true
	}
	return len(p), nil // never propagate a cache error to the client copy
}

// publicBase derives the externally-visible scheme://host used to rewrite npm
// tarball URLs back through this proxy. The configured COOLDEPS_PUBLIC_URL is
// the robust source and should always be set in production; it wins outright.
//
// Without it we fall back to the request's own Host. We deliberately do NOT
// trust a client-supplied X-Forwarded-Host: it is spoofable and would let a
// client steer the rewritten dist.tarball URLs to an arbitrary host. Only
// X-Forwarded-Proto is honoured (TLS is terminated at the edge).
func publicBase(r *http.Request, override string) string {
	if override != "" {
		return override
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + r.Host
}

// maxUpstreamBody caps how much of an upstream metadata response (npm packument,
// PyPI Simple listing) we buffer in memory, bounding a memory-exhaustion DoS
// from a hostile/compromised upstream. Even the largest real packuments/listings
// (@types/*, aws-sdk, boto3) are tens of MiB, so 64 MiB is generous while
// keeping the worst-case footprint small relative to the pod memory limit even
// under concurrent requests.
const maxUpstreamBody = 64 << 20 // 64 MiB

// readAllLimited reads up to maxUpstreamBody bytes, transparently gunzipping a
// gzip-encoded body. It errors if the body exceeds the cap (truncating could
// corrupt the JSON we are about to parse).
func readAllLimited(body io.Reader, contentEncoding string) ([]byte, error) {
	var reader io.Reader = body
	if strings.EqualFold(contentEncoding, "gzip") {
		gz, err := gzip.NewReader(body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		reader = gz
	}
	// +1 so we can detect "exactly at the cap" overflow.
	b, err := io.ReadAll(io.LimitReader(reader, maxUpstreamBody+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxUpstreamBody {
		return nil, fmt.Errorf("upstream body exceeds %d bytes", maxUpstreamBody)
	}
	return b, nil
}

// stripSensitiveHeaders removes client credentials and forwarding/identity
// headers from an outbound proxied request. The proxy talks only to public
// registries, so forwarding a client's Authorization/Cookie/Proxy-Authorization
// would be a needless credential leak (and turn the proxy into an authenticated
// relay). The HTTP-method allowlist is enforced at the router (proxy.readOnly).
func stripSensitiveHeaders(req *http.Request) {
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	// Set to nil (not Del) so httputil.ReverseProxy does not re-add the inbound
	// client IP as X-Forwarded-For — nothing about the internal client topology
	// should reach the public upstream registry.
	req.Header["X-Forwarded-For"] = nil
	req.Header["X-Forwarded-Host"] = nil
	req.Header["X-Forwarded-Proto"] = nil
}

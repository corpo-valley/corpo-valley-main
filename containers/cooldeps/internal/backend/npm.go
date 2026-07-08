package backend

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

// NPM gates the npm registry. Packuments pass through (so resolution works) but
// every version's dist.tarball URL is rewritten to point back at this proxy, so
// the actual install — the tarball fetch — is forced through the gate. Tarball
// requests are then evaluated and either 403'd or served (cache-first).
type NPM struct {
	upstream   *url.URL
	gate       Gate
	artifacts  *cache.ArtifactCache
	httpClient *http.Client
	proxy      *httputil.ReverseProxy
	publicURL  string // optional COOLDEPS_PUBLIC_URL override
	log        *slog.Logger
}

type ctxKey string

const pubBaseKey ctxKey = "pubbase"

// NewNPM builds the npm backend. upstreamURL is e.g. https://registry.npmjs.org.
func NewNPM(upstreamURL string, gate Gate, artifacts *cache.ArtifactCache, httpClient *http.Client, publicURL string, log *slog.Logger) (*NPM, error) {
	u, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}
	b := &NPM{
		upstream: u, gate: gate, artifacts: artifacts,
		httpClient: httpClient, publicURL: publicURL, log: log,
	}
	b.proxy = &httputil.ReverseProxy{
		Director:       b.director,
		ModifyResponse: b.rewritePackument,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Warn("npm upstream error", "path", r.URL.Path, "err", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
		},
	}
	return b, nil
}

func (b *NPM) director(req *http.Request) {
	base := publicBase(req, b.publicURL)
	req.URL.Scheme = b.upstream.Scheme
	req.URL.Host = b.upstream.Host
	req.Host = b.upstream.Host
	stripSensitiveHeaders(req)
	// Ask for identity so ModifyResponse can rewrite the JSON without juggling
	// content-encodings (we still defensively gunzip below).
	req.Header.Set("Accept-Encoding", "identity")
	// Stash the client-facing base so rewritePackument can build tarball URLs.
	*req = *req.WithContext(context.WithValue(req.Context(), pubBaseKey, base))
}

func (b *NPM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if name, version, ok := parseTarballPath(r.URL.Path); ok {
		b.gateTarball(w, r, name, version)
		return
	}
	b.proxy.ServeHTTP(w, r)
}

// gateTarball evaluates the exact version and either rejects it or serves the
// bytes (cache-first, caching on the way through).
func (b *NPM) gateTarball(w http.ResponseWriter, r *http.Request, name, version string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		b.proxy.ServeHTTP(w, r)
		return
	}
	verdict := b.gate.Evaluate(r.Context(), model.NPM, name, version)
	if verdict.Blocked() {
		writeBlock(w, model.NPM, name, version, verdict, b.log)
		return
	}

	upstreamURL := b.upstream.String() + r.URL.Path
	w.Header().Set(headerVerdict, verdict.Decision.String())

	// Cache hit? Artifacts are immutable by URL — let the CDN/clients cache it
	// forever. (The immutable directive is only ever set on a real 200 body,
	// never on the error path below.)
	if f, _, ok := b.artifacts.Get(upstreamURL); ok {
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Cooldeps-Cache", "hit")
		http.ServeContent(w, r, "", time.Time{}, f) // sets Content-Length, supports range
		return
	}

	// Miss: fetch upstream, stream to client, tee into the cache.
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	resp, err := b.httpClient.Do(req)
	if err != nil {
		b.log.Warn("npm tarball upstream error", "url", upstreamURL, "err", err)
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Do NOT cache a transient upstream failure: no immutable directive here.
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.Header().Set("X-Cooldeps-Cache", "miss")
	w.WriteHeader(http.StatusOK)

	var dst io.Writer = w
	writer, caching := b.artifacts.NewWriter(upstreamURL)
	var tee *cacheTee
	if caching {
		tee = &cacheTee{w: writer, abort: writer.Abort}
		dst = io.MultiWriter(w, tee)
	}
	// copyErr now reflects ONLY client/upstream stream failures — the tee never
	// surfaces a cache error.
	_, copyErr := io.Copy(dst, resp.Body)
	if caching {
		switch {
		case copyErr != nil || tee.failed:
			writer.Abort() // idempotent if the tee already aborted
		default:
			if err := writer.Commit(); err != nil {
				b.log.Warn("npm artifact cache commit failed", "url", upstreamURL, "err", err)
			}
		}
	}
}

// rewritePackument rewrites every dist.tarball URL in a packument response to
// point back at this proxy, guaranteeing tarball fetches traverse the gate
// regardless of npm's host-replacement behaviour.
func (b *NPM) rewritePackument(resp *http.Response) error {
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	if isTarballPath(resp.Request.URL.Path) {
		return nil // handled separately; never reaches the proxy anyway
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "json") {
		return nil
	}
	base, _ := resp.Request.Context().Value(pubBaseKey).(string)
	if base == "" {
		return nil
	}

	body, err := readBody(resp)
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		// Not an object we understand — pass through untouched.
		return replaceBody(resp, body)
	}
	upstreamBase := b.upstream.Scheme + "://" + b.upstream.Host
	newBase := strings.TrimRight(base, "/") + "/npm"
	rewriteTarballs(doc, upstreamBase, newBase)

	out, err := json.Marshal(doc)
	if err != nil {
		return replaceBody(resp, body)
	}
	return replaceBody(resp, out)
}

// rewriteTarballs walks versions[*].dist.tarball and swaps the upstream host
// prefix for our proxy prefix.
func rewriteTarballs(doc map[string]any, upstreamBase, newBase string) {
	versions, ok := doc["versions"].(map[string]any)
	if !ok {
		return
	}
	for _, v := range versions {
		vm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		dist, ok := vm["dist"].(map[string]any)
		if !ok {
			continue
		}
		tb, ok := dist["tarball"].(string)
		if !ok {
			continue
		}
		if strings.HasPrefix(tb, upstreamBase) {
			dist["tarball"] = newBase + strings.TrimPrefix(tb, upstreamBase)
		}
	}
}

func readBody(resp *http.Response) ([]byte, error) {
	return readAllLimited(resp.Body, resp.Header.Get("Content-Encoding"))
}

func replaceBody(resp *http.Response, body []byte) error {
	resp.Body.Close()
	resp.Body = io.NopCloser(strings.NewReader(string(body)))
	resp.Header.Del("Content-Encoding")
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.ContentLength = int64(len(body))
	return nil
}

// parseTarballPath extracts (name, version) from an npm tarball path, handling
// scoped names. Returns ok=false for non-tarball (packument) paths.
//
//	/lodash/-/lodash-4.17.21.tgz        -> ("lodash", "4.17.21")
//	/@babel/core/-/core-7.0.0.tgz       -> ("@babel/core", "7.0.0")
func parseTarballPath(p string) (name, version string, ok bool) {
	i := strings.Index(p, "/-/")
	if i < 0 {
		return "", "", false
	}
	name = strings.Trim(p[:i], "/")
	// npm sometimes percent-encodes the scope slash in the name segment.
	if dec, err := url.PathUnescape(name); err == nil {
		name = dec
	}
	file := p[i+len("/-/"):]
	if !strings.HasSuffix(file, ".tgz") {
		return "", "", false
	}
	file = strings.TrimSuffix(file, ".tgz")
	if name == "" || file == "" {
		return "", "", false
	}
	// The canonical tarball filename uses the *unscoped* package name as a
	// prefix: "<unscoped>-<version>".
	unscoped := name
	if s := strings.LastIndex(name, "/"); s >= 0 {
		unscoped = name[s+1:]
	}
	if v := strings.TrimPrefix(file, unscoped+"-"); v != "" && v != file {
		return name, v, true
	}
	// Unconventional filename: still GATE it (ok=true) with the stem as a
	// best-effort version rather than letting an unrecognised "/-/*.tgz" pass
	// through ungated. A wrong version 404s on deps.dev -> unknown age ->
	// warn/block (fail-safe), never a silent gate bypass.
	return name, file, true
}

func isTarballPath(p string) bool {
	_, _, ok := parseTarballPath(p)
	return ok
}

package backend

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

// GoMod gates Go modules via the GOPROXY protocol. Resolution traffic
// (/@v/list, .info, .mod, /@latest) passes straight through; the module .zip —
// the unambiguous "download this exact version" signal — is evaluated and
// either rejected or served (cache-first). Unlike npm there is nothing to
// rewrite: the Go client always fetches .zip from its configured GOPROXY, so it
// already traverses this gate. Zip bytes are passed through unmodified, so
// GOSUMDB checksum verification still succeeds.
type GoMod struct {
	upstream   *url.URL
	gate       Gate
	artifacts  *cache.ArtifactCache
	httpClient *http.Client
	proxy      *httputil.ReverseProxy
	log        *slog.Logger
}

// NewGoMod builds the Go backend. upstreamURL is e.g. https://proxy.golang.org.
func NewGoMod(upstreamURL string, gate Gate, artifacts *cache.ArtifactCache, httpClient *http.Client, log *slog.Logger) (*GoMod, error) {
	u, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}
	b := &GoMod{upstream: u, gate: gate, artifacts: artifacts, httpClient: httpClient, log: log}
	b.proxy = &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = u.Scheme
			req.URL.Host = u.Host
			req.Host = u.Host
			stripSensitiveHeaders(req)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Warn("go upstream error", "path", r.URL.Path, "err", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
		},
	}
	return b, nil
}

func (b *GoMod) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if module, version, ok := parseGoZipPath(r.URL.Path); ok {
		b.gateZip(w, r, module, version)
		return
	}
	b.proxy.ServeHTTP(w, r)
}

func (b *GoMod) gateZip(w http.ResponseWriter, r *http.Request, module, version string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		b.proxy.ServeHTTP(w, r)
		return
	}
	verdict := b.gate.Evaluate(r.Context(), model.Go, module, version)
	if verdict.Blocked() {
		// Plain-text body: the go command surfaces a proxy error message to the
		// user, and a 403 (not 404/410) stops GOPROXY fallthrough so the block
		// holds.
		b.log.Info("blocked", "ecosystem", "go", "module", module, "version", version, "reasons", reasonsText(verdict))
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set(headerVerdict, verdict.Decision.String())
		w.Header().Set(headerReasons, reasonsText(verdict))
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "blocked by cooldown policy: "+module+"@"+version+"\n"+reasonsText(verdict)+"\n")
		return
	}

	upstreamURL := b.upstream.String() + r.URL.Path
	w.Header().Set(headerVerdict, verdict.Decision.String())

	// Cache hit? Module zips are immutable by URL. The immutable directive is
	// only ever set on a real 200 body, never on the error path below.
	if f, _, ok := b.artifacts.Get(upstreamURL); ok {
		defer f.Close()
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Cooldeps-Cache", "hit")
		http.ServeContent(w, r, "", time.Time{}, f)
		return
	}

	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	resp, err := b.httpClient.Do(req)
	if err != nil {
		b.log.Warn("go zip upstream error", "url", upstreamURL, "err", err)
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Do NOT cache a transient upstream failure for a year.
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
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
	_, copyErr := io.Copy(dst, resp.Body)
	if caching {
		if copyErr == nil && !tee.failed {
			if err := writer.Commit(); err != nil {
				b.log.Warn("go artifact cache commit failed", "url", upstreamURL, "err", err)
			}
		} else {
			writer.Abort()
		}
	}
}

// parseGoZipPath extracts (module, version) from a GOPROXY .zip path, decoding
// the proxy's case-escaping (!x -> X). Returns ok=false for non-zip (resolution)
// paths.
//
//	/github.com/pkg/errors/@v/v0.9.1.zip        -> ("github.com/pkg/errors", "v0.9.1")
//	/github.com/!azure/azure-sdk/@v/v1.0.0.zip  -> ("github.com/Azure/azure-sdk", "v1.0.0")
func parseGoZipPath(p string) (module, version string, ok bool) {
	i := strings.Index(p, "/@v/")
	if i < 0 {
		return "", "", false
	}
	mod := strings.Trim(p[:i], "/")
	file := p[i+len("/@v/"):]
	if !strings.HasSuffix(file, ".zip") {
		return "", "", false
	}
	ver := strings.TrimSuffix(file, ".zip")
	if mod == "" || ver == "" {
		return "", "", false
	}
	return decodeGoEscape(mod), decodeGoEscape(ver), true
}

// decodeGoEscape reverses the GOPROXY case-encoding: an exclamation mark before
// a lowercase letter denotes the uppercase form (so module paths can live on
// case-insensitive filesystems).
func decodeGoEscape(s string) string {
	if !strings.Contains(s, "!") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '!' && i+1 < len(s) {
			i++
			n := s[i]
			if n >= 'a' && n <= 'z' {
				n -= 'a' - 'A'
			}
			b.WriteByte(n)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

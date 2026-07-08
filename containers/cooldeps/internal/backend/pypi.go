package backend

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// PyPI gates the PyPI Simple API. Rather than blocking downloads, it rewrites
// the per-project Simple listing: every candidate version is evaluated and the
// files belonging to blocked versions are removed before pip's resolver sees
// them. The resolver then naturally picks an allowed version (or fails cleanly
// if none qualify).
type PyPI struct {
	upstream *url.URL
	gate     Gate
	proxy    *httputil.ReverseProxy
	log      *slog.Logger
}

// simpleDoc is the PEP 691 (+ PEP 700 "versions") JSON document.
type simpleDoc struct {
	Meta     map[string]any   `json:"meta"`
	Name     string           `json:"name"`
	Files    []map[string]any `json:"files"`
	Versions []string         `json:"versions,omitempty"`
}

// projectPathRe matches a Simple project page: /simple/<name>/ (trailing slash
// optional). The root index /simple/ is excluded.
var projectPathRe = regexp.MustCompile(`^/simple/([^/]+)/?$`)

func NewPyPI(upstreamURL string, gate Gate, log *slog.Logger) (*PyPI, error) {
	u, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}
	b := &PyPI{upstream: u, gate: gate, log: log}
	b.proxy = &httputil.ReverseProxy{
		Director:       b.director,
		ModifyResponse: b.filterListing,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Warn("pypi upstream error", "path", r.URL.Path, "err", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
		},
	}
	return b, nil
}

func (b *PyPI) ServeHTTP(w http.ResponseWriter, r *http.Request) { b.proxy.ServeHTTP(w, r) }

func (b *PyPI) director(req *http.Request) {
	req.URL.Scheme = b.upstream.Scheme
	req.URL.Host = b.upstream.Host
	req.Host = b.upstream.Host
	stripSensitiveHeaders(req)
	if projectPathRe.MatchString(req.URL.Path) {
		// Force the PEP 691 JSON representation so we can filter structurally.
		req.Header.Set("Accept", "application/vnd.pypi.simple.v1+json")
		req.Header.Set("Accept-Encoding", "identity")
	}
}

func (b *PyPI) filterListing(resp *http.Response) error {
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	m := projectPathRe.FindStringSubmatch(resp.Request.URL.Path)
	if m == nil {
		return nil // download or root index — pass through
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "json") {
		// Upstream gave HTML (very old index); we can't safely filter it here.
		b.log.Warn("pypi listing not JSON; passing through unfiltered", "path", resp.Request.URL.Path)
		return nil
	}
	rawName, _ := url.PathUnescape(m[1])
	name := normalizePyPI(rawName)

	// Bounded, gzip-aware read: the director requests identity encoding, but a
	// non-conforming upstream could still gzip; decompress so we never parse a
	// compressed body as JSON, and cap the size to bound memory.
	body, err := readAllLimited(resp.Body, resp.Header.Get("Content-Encoding"))
	resp.Body.Close()
	if err != nil {
		return err
	}
	var doc simpleDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return restore(resp, body) // unknown shape — pass through
	}

	candidates := candidateVersions(doc)
	if len(candidates) == 0 {
		return restore(resp, body)
	}
	verdicts := b.gate.EvaluateMany(resp.Request.Context(), model.PyPI, name, candidates)

	allowed := make(map[string]bool, len(candidates))
	for v, verdict := range verdicts {
		allowed[v] = !verdict.Blocked()
	}

	kept := make([]map[string]any, 0, len(doc.Files))
	dropped := 0
	for _, f := range doc.Files {
		fn, _ := f["filename"].(string)
		ver := versionFromFilename(fn, candidates)
		// Keep files whose version we couldn't determine (conservative) or that
		// are allowed; drop the rest.
		if ver == "" || allowed[ver] {
			kept = append(kept, f)
		} else {
			dropped++
		}
	}
	doc.Files = kept
	if doc.Versions != nil {
		keptVers := make([]string, 0, len(doc.Versions))
		for _, v := range doc.Versions {
			if allowed[v] {
				keptVers = append(keptVers, v)
			}
		}
		doc.Versions = keptVers
	}
	if dropped > 0 {
		b.log.Info("pypi listing filtered", "package", name, "dropped_files", dropped, "kept_files", len(kept))
	}

	out, err := json.Marshal(doc)
	if err != nil {
		return restore(resp, body)
	}
	resp.Header.Set(headerVerdict, "filtered")
	// A filtered listing reflects current policy/CVE state, so it must NOT be
	// cached as long as artifacts are — keep it short-lived at the edge.
	resp.Header.Set("Cache-Control", "public, max-age=300")
	return restore(resp, out)
}

func restore(resp *http.Response, body []byte) error {
	resp.Body = io.NopCloser(strings.NewReader(string(body)))
	resp.Header.Del("Content-Encoding")
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.ContentLength = int64(len(body))
	// Preserve the JSON content-type pip negotiated.
	if resp.Header.Get("Content-Type") == "" {
		resp.Header.Set("Content-Type", "application/vnd.pypi.simple.v1+json")
	}
	return nil
}

// candidateVersions returns the version list to evaluate: PEP 700 "versions" if
// present, else derived from the wheel filenames.
func candidateVersions(doc simpleDoc) []string {
	if len(doc.Versions) > 0 {
		return doc.Versions
	}
	seen := map[string]bool{}
	var out []string
	for _, f := range doc.Files {
		fn, _ := f["filename"].(string)
		if v := versionFromFilename(fn, nil); v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// versionFromFilename extracts a version from a wheel/sdist filename. Wheels
// have a reliable structure (version is the 2nd "-"-delimited field). For
// sdists — whose project names may contain hyphens — it matches the longest
// known version that the stem ends with.
func versionFromFilename(filename string, known []string) string {
	if filename == "" {
		return ""
	}
	if strings.HasSuffix(filename, ".whl") {
		stem := strings.TrimSuffix(filename, ".whl")
		parts := strings.Split(stem, "-")
		if len(parts) < 2 {
			return ""
		}
		ver := parts[1]
		// The wheel filename escapes '+'/'!'/'-' in the version to '_' (PEP 427),
		// so an epoch/local version won't byte-match the canonical PEP 700 list
		// the allow-map is keyed by. Reconcile by matching the escaped form back
		// to the canonical version, mirroring the sdist branch's use of `known`.
		for _, k := range known {
			if k == ver || wheelEscape(k) == ver {
				return k
			}
		}
		return ver
	}
	stem := filename
	for _, ext := range []string{".tar.gz", ".tar.bz2", ".tgz", ".zip", ".tar"} {
		if strings.HasSuffix(stem, ext) {
			stem = strings.TrimSuffix(stem, ext)
			break
		}
	}
	best := ""
	for _, v := range known {
		if strings.HasSuffix(stem, "-"+v) && len(v) > len(best) {
			best = v
		}
	}
	return best
}

// wheelEscapeRe matches runs of characters PEP 427 escapes to "_" in a wheel
// filename's version field (anything other than alphanumerics and "."). e.g.
// "1.0.0+local" -> "1.0.0_local", "1!2.0" -> "1_2.0".
var wheelEscapeRe = regexp.MustCompile(`[^A-Za-z0-9.]+`)

func wheelEscape(version string) string {
	return wheelEscapeRe.ReplaceAllString(version, "_")
}

var pep503Re = regexp.MustCompile(`[-_.]+`)

// normalizePyPI applies PEP 503 normalization (lowercase, collapse [-_.] runs).
func normalizePyPI(name string) string {
	return pep503Re.ReplaceAllString(strings.ToLower(name), "-")
}

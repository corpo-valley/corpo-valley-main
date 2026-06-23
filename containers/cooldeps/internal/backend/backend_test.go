package backend

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// fakeGate blocks a configured set of versions and allows the rest.
type fakeGate struct {
	blocked map[string]bool
}

func (g *fakeGate) verdict(version string) model.Verdict {
	if g.blocked[version] {
		return model.Verdict{Decision: model.Block, Reasons: []model.Reason{{Check: "cooldown", Decision: model.Block, Message: "too fresh"}}}
	}
	return model.Verdict{Decision: model.Allow}
}
func (g *fakeGate) Evaluate(_ context.Context, _ model.Ecosystem, _, version string) model.Verdict {
	return g.verdict(version)
}
func (g *fakeGate) EvaluateMany(_ context.Context, _ model.Ecosystem, _ string, versions []string) map[string]model.Verdict {
	out := make(map[string]model.Verdict, len(versions))
	for _, v := range versions {
		out[v] = g.verdict(v)
	}
	return out
}

// --- parseTarballPath ---

func TestParseTarballPath(t *testing.T) {
	cases := []struct {
		path, name, version string
		ok                  bool
	}{
		{"/lodash/-/lodash-4.17.21.tgz", "lodash", "4.17.21", true},
		{"/@babel/core/-/core-7.0.0.tgz", "@babel/core", "7.0.0", true},
		{"/@types%2Fnode/-/node-20.1.0.tgz", "@types/node", "20.1.0", true},
		{"/lodash", "", "", false},      // packument
		{"/@babel/core", "", "", false}, // scoped packument
		{"/lodash/-/lodash.json", "", "", false},
	}
	for _, c := range cases {
		name, ver, ok := parseTarballPath(c.path)
		if ok != c.ok || name != c.name || ver != c.version {
			t.Errorf("%s -> (%q,%q,%v), want (%q,%q,%v)", c.path, name, ver, ok, c.name, c.version, c.ok)
		}
	}
}

// --- npm tarball gating ---

func newNPMTest(t *testing.T, upstream string, gate Gate, withCache bool) *NPM {
	t.Helper()
	var ac *cache.ArtifactCache
	if withCache {
		ac, _ = cache.NewArtifactCache(t.TempDir(), 1<<20)
	} else {
		ac, _ = cache.NewArtifactCache(t.TempDir(), 0)
	}
	b, err := NewNPM(upstream, gate, ac, http.DefaultClient, "", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestNPMBlocksFreshTarball(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("TARBALL-BYTES"))
	}))
	defer upstream.Close()

	b := newNPMTest(t, upstream.URL, &fakeGate{blocked: map[string]bool{"1.0.0": true}}, true)
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/evil/-/evil-1.0.0.tgz", nil))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	// Decision marshals to its string form; assert on the wire JSON.
	bodyStr := rec.Body.String()
	if !strings.Contains(bodyStr, `"version":"1.0.0"`) || !strings.Contains(bodyStr, `"decision":"block"`) {
		t.Fatalf("bad block body: %s", bodyStr)
	}
}

func TestNPMServesAndCachesAllowedTarball(t *testing.T) {
	var upstreamHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		w.Write([]byte("GOOD-TARBALL"))
	}))
	defer upstream.Close()

	b := newNPMTest(t, upstream.URL, &fakeGate{blocked: map[string]bool{}}, true)

	// First fetch: miss, served + cached.
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/good/-/good-2.0.0.tgz", nil))
	if rec.Code != 200 || rec.Body.String() != "GOOD-TARBALL" {
		t.Fatalf("miss serve failed: %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Cooldeps-Cache") != "miss" {
		t.Fatalf("expected miss header, got %q", rec.Header().Get("X-Cooldeps-Cache"))
	}

	// Second fetch: cache hit, no upstream call.
	rec2 := httptest.NewRecorder()
	b.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/good/-/good-2.0.0.tgz", nil))
	if rec2.Body.String() != "GOOD-TARBALL" {
		t.Fatalf("hit serve failed: %q", rec2.Body.String())
	}
	if rec2.Header().Get("X-Cooldeps-Cache") != "hit" {
		t.Fatalf("expected hit header, got %q", rec2.Header().Get("X-Cooldeps-Cache"))
	}
	if upstreamHits != 1 {
		t.Fatalf("expected exactly 1 upstream fetch, got %d", upstreamHits)
	}
}

func TestNPMTransientErrorNotCachedForever(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound) // transient upstream failure
	}))
	defer upstream.Close()
	b := newNPMTest(t, upstream.URL, &fakeGate{}, true)
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pkg/-/pkg-1.0.0.tgz", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 relayed, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("error response must not be cacheable; Cache-Control=%q", cc)
	}
}

func TestNPMAllowedTarballIsImmutable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "BYTES")
	}))
	defer upstream.Close()
	b := newNPMTest(t, upstream.URL, &fakeGate{}, true)
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pkg/-/pkg-1.0.0.tgz", nil))
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("allowed 200 tarball should be immutable, got %q", rec.Header().Get("Cache-Control"))
	}
}

func TestParseTarballPathFailSafeGates(t *testing.T) {
	// An unconventional tarball filename (doesn't start with "<unscoped>-") must
	// still be recognised as a tarball (ok=true) so it is gated, not bypassed.
	name, ver, ok := parseTarballPath("/pkg/-/weirdname-9.9.9.tgz")
	if !ok {
		t.Fatal("unconventional tarball must still be gated (ok=true)")
	}
	if name != "pkg" || ver == "" {
		t.Fatalf("expected best-effort gate, got name=%q ver=%q", name, ver)
	}
}

func TestPublicBaseIgnoresSpoofedForwardedHost(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/lodash", nil)
	r.Host = "cooldeps.example.com"
	r.Header.Set("X-Forwarded-Host", "evil.example.com")
	r.Header.Set("X-Forwarded-Proto", "https")
	if got := publicBase(r, ""); got != "https://cooldeps.example.com" {
		t.Fatalf("publicBase must ignore X-Forwarded-Host, got %q", got)
	}
	// Explicit override always wins.
	if got := publicBase(r, "https://configured.example"); got != "https://configured.example" {
		t.Fatalf("override should win, got %q", got)
	}
}

func TestNPMRewritesPackumentTarballURLs(t *testing.T) {
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// dist.tarball points at the upstream host; we expect it rewritten to us.
		json.NewEncoder(w).Encode(map[string]any{
			"name": "lodash",
			"versions": map[string]any{
				"4.17.21": map[string]any{
					"dist": map[string]any{"tarball": upstream.URL + "/lodash/-/lodash-4.17.21.tgz"},
				},
			},
		})
	}))
	defer upstream.Close()

	b := newNPMTest(t, upstream.URL, &fakeGate{}, false)
	req := httptest.NewRequest(http.MethodGet, "/lodash", nil)
	req.Host = "cooldeps.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, req)

	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	got := doc["versions"].(map[string]any)["4.17.21"].(map[string]any)["dist"].(map[string]any)["tarball"].(string)
	want := "https://cooldeps.example.com/npm/lodash/-/lodash-4.17.21.tgz"
	if got != want {
		t.Fatalf("tarball not rewritten:\n got=%s\nwant=%s", got, want)
	}
}

// --- pypi listing filter ---

func TestPyPIFiltersBlockedVersions(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.pypi.simple.v1+json")
		json.NewEncoder(w).Encode(simpleDoc{
			Meta: map[string]any{"api-version": "1.0"},
			Name: "requests",
			Files: []map[string]any{
				{"filename": "requests-2.31.0-py3-none-any.whl", "url": "https://files/x"},
				{"filename": "requests-2.99.0-py3-none-any.whl", "url": "https://files/y"},
				{"filename": "requests-2.99.0.tar.gz", "url": "https://files/z"},
			},
			Versions: []string{"2.31.0", "2.99.0"},
		})
	}))
	defer upstream.Close()

	b, err := NewPyPI(upstream.URL, &fakeGate{blocked: map[string]bool{"2.99.0": true}}, quietLog())
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/simple/requests/", nil))

	var doc simpleDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("bad json: %v\n%s", err, rec.Body.String())
	}
	if len(doc.Files) != 1 {
		t.Fatalf("expected 1 surviving file, got %d: %+v", len(doc.Files), doc.Files)
	}
	if !strings.Contains(doc.Files[0]["filename"].(string), "2.31.0") {
		t.Fatalf("wrong file survived: %+v", doc.Files[0])
	}
	if len(doc.Versions) != 1 || doc.Versions[0] != "2.31.0" {
		t.Fatalf("versions array not recomputed: %+v", doc.Versions)
	}
}

func TestPyPIPassesThroughDownloads(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("WHEEL-BYTES"))
	}))
	defer upstream.Close()
	b, _ := NewPyPI(upstream.URL, &fakeGate{}, quietLog())
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/packages/aa/bb/requests-2.31.0.whl", nil))
	if rec.Body.String() != "WHEEL-BYTES" {
		t.Fatalf("download should pass through, got %q", rec.Body.String())
	}
}

func TestVersionFromFilename(t *testing.T) {
	known := []string{"2.31.0", "1.0.0-beta", "1.0.0+local", "1!2.0"}
	cases := []struct{ fn, want string }{
		{"requests-2.31.0-py3-none-any.whl", "2.31.0"},
		{"requests-2.31.0.tar.gz", "2.31.0"},
		{"my-pkg-1.0.0-beta.tar.gz", "1.0.0-beta"}, // hyphenated name + version
		// PEP 427 escaping: the wheel filename version must reconcile back to the
		// canonical PEP 700 version so an allowed local/epoch wheel isn't dropped.
		{"pkg-1.0.0_local-py3-none-any.whl", "1.0.0+local"},
		{"pkg-1_2.0-py3-none-any.whl", "1!2.0"},
		{"weird.txt", ""},
	}
	for _, c := range cases {
		if got := versionFromFilename(c.fn, known); got != c.want {
			t.Errorf("%s -> %q want %q", c.fn, got, c.want)
		}
	}
}

func TestCacheTeeNeverBreaksClientStream(t *testing.T) {
	aborted := false
	tee := &cacheTee{w: failingWriter{}, abort: func() { aborted = true }}
	// A cache-side failure must be swallowed: Write reports full length, no error.
	n, err := tee.Write([]byte("hello"))
	if err != nil || n != 5 {
		t.Fatalf("tee.Write must never error and must report full length, got n=%d err=%v", n, err)
	}
	if !aborted || !tee.failed {
		t.Fatal("a cache write failure must abort the cache and set failed")
	}
	// Subsequent writes are silent no-ops (client stream keeps flowing).
	if n2, err2 := tee.Write([]byte("more")); err2 != nil || n2 != 4 {
		t.Fatalf("post-failure writes must be silent no-ops, got n=%d err=%v", n2, err2)
	}
}

type failingWriter struct{}

func (failingWriter) Write(p []byte) (int, error) { return 0, errFail }

var errFail = &fakeErr{}

type fakeErr struct{}

func (*fakeErr) Error() string { return "simulated cache write failure" }

func TestStripSensitiveHeaders(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("Cookie", "a=b")
	r.Header.Set("Proxy-Authorization", "x")
	r.Header.Set("X-Forwarded-For", "10.9.8.7")
	stripSensitiveHeaders(r)
	if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Proxy-Authorization") != "" {
		t.Fatal("credentials must be stripped from outbound requests")
	}
	// Must be nil-valued (not merely absent) so ReverseProxy can't re-add the IP.
	if v, ok := r.Header["X-Forwarded-For"]; !ok || v != nil {
		t.Fatalf("X-Forwarded-For must be set to nil to block reverse-proxy re-add, got ok=%v v=%v", ok, v)
	}
}

// --- go module gating ---

func TestParseGoZipPath(t *testing.T) {
	cases := []struct {
		path, module, version string
		ok                    bool
	}{
		{"/github.com/pkg/errors/@v/v0.9.1.zip", "github.com/pkg/errors", "v0.9.1", true},
		{"/github.com/!azure/azure-sdk-for-go/@v/v1.0.0.zip", "github.com/Azure/azure-sdk-for-go", "v1.0.0", true},
		{"/golang.org/x/sys/@v/v0.0.0-20230615123456-abcdef012345.zip", "golang.org/x/sys", "v0.0.0-20230615123456-abcdef012345", true},
		{"/github.com/pkg/errors/@v/v0.9.1.info", "", "", false}, // metadata, not gated
		{"/github.com/pkg/errors/@v/v0.9.1.mod", "", "", false},
		{"/github.com/pkg/errors/@v/list", "", "", false},
		{"/github.com/pkg/errors/@latest", "", "", false},
	}
	for _, c := range cases {
		m, v, ok := parseGoZipPath(c.path)
		if ok != c.ok || m != c.module || v != c.version {
			t.Errorf("%s -> (%q,%q,%v) want (%q,%q,%v)", c.path, m, v, ok, c.module, c.version, c.ok)
		}
	}
}

func TestGoBlocksFreshZipAndPassesMetadata(t *testing.T) {
	var modHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".mod") {
			modHits++
			io.WriteString(w, "module example.com/x\n")
			return
		}
		io.WriteString(w, "ZIP-BYTES")
	}))
	defer upstream.Close()

	ac, _ := cache.NewArtifactCache(t.TempDir(), 1<<20)
	b, err := NewGoMod(upstream.URL, &fakeGate{blocked: map[string]bool{"v1.0.0": true}}, ac, http.DefaultClient, quietLog())
	if err != nil {
		t.Fatal(err)
	}

	// .mod (resolution) passes through.
	recMod := httptest.NewRecorder()
	b.ServeHTTP(recMod, httptest.NewRequest(http.MethodGet, "/example.com/x/@v/v1.0.0.mod", nil))
	if recMod.Code != 200 || modHits != 1 {
		t.Fatalf("mod should pass through: code=%d hits=%d", recMod.Code, modHits)
	}

	// .zip (install) is gated and blocked.
	recZip := httptest.NewRecorder()
	b.ServeHTTP(recZip, httptest.NewRequest(http.MethodGet, "/example.com/x/@v/v1.0.0.zip", nil))
	if recZip.Code != http.StatusForbidden {
		t.Fatalf("fresh zip should be 403, got %d", recZip.Code)
	}
	if !strings.Contains(recZip.Body.String(), "blocked by cooldown") {
		t.Fatalf("expected readable reason, got %q", recZip.Body.String())
	}
}

func TestGoServesAllowedZip(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "GOOD-ZIP")
	}))
	defer upstream.Close()
	ac, _ := cache.NewArtifactCache(t.TempDir(), 1<<20)
	b, _ := NewGoMod(upstream.URL, &fakeGate{}, ac, http.DefaultClient, quietLog())
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/golang.org/x/text/@v/v0.3.0.zip", nil))
	if rec.Code != 200 || rec.Body.String() != "GOOD-ZIP" {
		t.Fatalf("allowed zip serve failed: %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Cooldeps-Cache") != "miss" {
		t.Fatalf("expected miss header")
	}
}

func TestDecodeGoEscape(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"github.com/!azure/!a!w!s", "github.com/Azure/AWS"},
		{"github.com/pkg/errors", "github.com/pkg/errors"},
	} {
		if got := decodeGoEscape(c.in); got != c.want {
			t.Errorf("decode(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizePyPI(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Flask-Cors", "flask-cors"},
		{"flask_cors", "flask-cors"},
		{"flask.cors", "flask-cors"},
	} {
		if got := normalizePyPI(c.in); got != c.want {
			t.Errorf("normalize(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

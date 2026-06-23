package cache

import (
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := OpenDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMetaRoundTrip(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	pub := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	meta := model.VersionMeta{Ecosystem: model.NPM, Name: "left-pad", Version: "1.3.0",
		PublishedAt: pub, PublishedKnown: true, License: "MIT"}
	if err := db.PutMeta(meta, true, now); err != nil {
		t.Fatal(err)
	}
	got, found, ok := db.GetMeta(model.NPM, "left-pad", "1.3.0")
	if !ok || !found {
		t.Fatalf("expected hit+found, got ok=%v found=%v", ok, found)
	}
	if got.License != "MIT" || !got.PublishedKnown || !got.PublishedAt.Equal(pub) {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestMetaMissIsColdNotFound(t *testing.T) {
	db := openTestDB(t)
	if _, _, ok := db.GetMeta(model.NPM, "nope", "0.0.0"); ok {
		t.Fatal("expected cold miss (ok=false)")
	}
}

func TestMetaCachedNotFoundIsHit(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	meta := model.VersionMeta{Ecosystem: model.NPM, Name: "fresh", Version: "0.0.1"}
	if err := db.PutMeta(meta, false, now); err != nil { // deps.dev had no record
		t.Fatal(err)
	}
	got, found, ok := db.GetMeta(model.NPM, "fresh", "0.0.1")
	if !ok {
		t.Fatal("cached not-found should be a hit (ok=true)")
	}
	if found || got.PublishedKnown {
		t.Fatal("expected found=false, publish unknown")
	}
}

func TestVulnTTL(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	vulns := []model.Vuln{{ID: "GHSA-x", Severity: model.SeverityHigh}}
	if err := db.PutVulns(model.NPM, "p", "1.0.0", vulns, now, 6*time.Hour); err != nil {
		t.Fatal(err)
	}
	got, ok := db.GetVulns(model.NPM, "p", "1.0.0", now.Add(time.Hour))
	if !ok || len(got) != 1 || got[0].Severity != model.SeverityHigh {
		t.Fatalf("fresh vuln read failed: ok=%v %+v", ok, got)
	}
	if _, ok := db.GetVulns(model.NPM, "p", "1.0.0", now.Add(7*time.Hour)); ok {
		t.Fatal("expired vuln entry should be a miss")
	}
}

func TestVulnEmptySetIsHit(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	if err := db.PutVulns(model.NPM, "clean", "1.0.0", nil, now, time.Hour); err != nil {
		t.Fatal(err)
	}
	got, ok := db.GetVulns(model.NPM, "clean", "1.0.0", now)
	if !ok || len(got) != 0 {
		t.Fatalf("empty vuln set should be a valid hit, got ok=%v len=%d", ok, len(got))
	}
}

func TestArtifactCacheRoundTrip(t *testing.T) {
	c, err := NewArtifactCache(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	w, ok := c.NewWriter("https://reg/x.tgz")
	if !ok {
		t.Fatal("expected writer")
	}
	io.WriteString(w, "hello-artifact")
	if err := w.Commit(); err != nil {
		t.Fatal(err)
	}
	f, size, ok := c.Get("https://reg/x.tgz")
	if !ok {
		t.Fatal("expected cache hit")
	}
	defer f.Close()
	if size != int64(len("hello-artifact")) {
		t.Fatalf("size mismatch: %d", size)
	}
	b, _ := io.ReadAll(f)
	if string(b) != "hello-artifact" {
		t.Fatalf("content mismatch: %q", b)
	}
}

func TestArtifactAbortLeavesNoFile(t *testing.T) {
	c, _ := NewArtifactCache(t.TempDir(), 1<<20)
	w, _ := c.NewWriter("https://reg/y.tgz")
	io.WriteString(w, "partial")
	w.Abort()
	if _, _, ok := c.Get("https://reg/y.tgz"); ok {
		t.Fatal("aborted write should not be cached")
	}
	if c.Bytes() != 0 {
		t.Fatalf("aborted bytes should not count, got %d", c.Bytes())
	}
}

func TestArtifactLRUEviction(t *testing.T) {
	// Cap small so a few writes force eviction. high-water=80%, low=70%.
	c, err := NewArtifactCache(t.TempDir(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.Repeat("z", 200) // 200B each
	for i := 0; i < 8; i++ {            // 1600B total written > cap
		w, _ := c.NewWriter(keyN(i))
		io.WriteString(w, payload)
		if err := w.Commit(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond) // distinct mtimes for LRU ordering
	}
	if c.Bytes() > 1000 {
		t.Fatalf("eviction failed to bound size: %d > 1000", c.Bytes())
	}
	// The most recently written key should survive; the oldest should be gone.
	if _, _, ok := c.Get(keyN(7)); !ok {
		t.Fatal("most-recent artifact should survive eviction")
	}
	if _, _, ok := c.Get(keyN(0)); ok {
		t.Fatal("oldest artifact should have been evicted")
	}
}

func TestArtifactDuplicateCommitDoesNotOvercount(t *testing.T) {
	c, err := NewArtifactCache(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	key := "https://reg/dup.tgz"
	payload := strings.Repeat("q", 300)
	// Commit the same key twice (simulating a repeat/concurrent fetch). curBytes
	// must reflect ONE copy, not two.
	for i := 0; i < 2; i++ {
		w, _ := c.NewWriter(key)
		io.WriteString(w, payload)
		if err := w.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.Bytes(); got != int64(len(payload)) {
		t.Fatalf("duplicate commit overcounted: curBytes=%d want %d", got, len(payload))
	}
}

func TestArtifactDisabled(t *testing.T) {
	c, _ := NewArtifactCache(t.TempDir(), 0)
	if c.Enabled() {
		t.Fatal("zero cap should disable caching")
	}
	if _, ok := c.NewWriter("k"); ok {
		t.Fatal("disabled cache should not vend writers")
	}
}

func keyN(i int) string { return "https://reg/pkg-" + string(rune('a'+i)) + ".tgz" }

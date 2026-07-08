package depsdev

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hashtagcyber/cooldeps/internal/httpx"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

func testClient(srv *httptest.Server) *Client {
	h := httpx.New("cooldeps-test")
	h.BaseDelay = 0
	return New(h, srv.URL)
}

func TestGetVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/systems/npm/packages/left-pad/versions/1.3.0") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Write([]byte(`{"versionKey":{"system":"NPM","name":"left-pad","version":"1.3.0"},"publishedAt":"2018-04-12T19:00:00Z","licenses":["MIT"]}`))
	}))
	defer srv.Close()

	meta, found, err := testClient(srv).GetVersion(context.Background(), model.NPM, "left-pad", "1.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("expected found")
	}
	if !meta.PublishedKnown || meta.PublishedAt.Year() != 2018 {
		t.Fatalf("bad publish time: %+v", meta)
	}
	if meta.License != "MIT" {
		t.Fatalf("bad license: %q", meta.License)
	}
}

func TestGetVersion404IsNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	meta, found, err := testClient(srv).GetVersion(context.Background(), model.NPM, "brandnew", "0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Fatal("expected not found for 404")
	}
	if meta.PublishedKnown {
		t.Fatal("404 should leave publish unknown")
	}
}

func TestGetVersionMultiLicenseBecomesAND(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"licenses":["MIT","Apache-2.0"]}`))
	}))
	defer srv.Close()
	meta, _, err := testClient(srv).GetVersion(context.Background(), model.NPM, "x", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if meta.License != "MIT AND Apache-2.0" {
		t.Fatalf("expected AND join, got %q", meta.License)
	}
}

func TestGoPseudoVersionAllForms(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c := testClient(srv)
	// All three Go pseudo-version forms must yield the embedded 2023 date.
	for _, ver := range []string{
		"v0.0.0-20230615123456-abcdef012345",       // form 1: base release, '-' before ts
		"v1.2.3-0.20230615123456-abcdef012345",     // form 3: after a release tag, '.' before ts
		"v1.2.3-pre.0.20230615123456-abcdef012345", // form 2: after a prerelease, '.' before ts
	} {
		meta, found, err := c.GetVersion(context.Background(), model.Go, "github.com/foo/bar", ver)
		if err != nil {
			t.Fatal(err)
		}
		if !found || !meta.PublishedKnown || meta.PublishedAt.Year() != 2023 {
			t.Fatalf("%s: expected derived 2023 date, got found=%v known=%v", ver, found, meta.PublishedKnown)
		}
	}
	// A normal tagged version must NOT be mistaken for a pseudo-version.
	if _, found, _ := c.GetVersion(context.Background(), model.Go, "github.com/foo/bar", "v1.2.3"); found {
		t.Fatal("tagged version must not match the pseudo-version regex")
	}
}

func TestGoPseudoVersionWithIncompatible(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	// A v2+ pseudo-version carrying a +incompatible build-metadata suffix must
	// still yield the embedded commit date.
	meta, found, err := testClient(srv).GetVersion(context.Background(), model.Go,
		"github.com/foo/bar", "v2.0.0-20230615123456-abcdef012345+incompatible")
	if err != nil {
		t.Fatal(err)
	}
	if !found || !meta.PublishedKnown || meta.PublishedAt.Year() != 2023 {
		t.Fatalf("pseudo-version with +incompatible should yield a known 2023 date, got found=%v %+v", found, meta)
	}
}

func TestGoPseudoVersionDateFallback(t *testing.T) {
	// deps.dev 404s for an untagged pseudo-version; we derive the date from the
	// version string itself so cooldown still applies.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	meta, found, err := testClient(srv).GetVersion(context.Background(), model.Go,
		"golang.org/x/sys", "v0.0.0-20230615123456-abcdef012345")
	if err != nil {
		t.Fatal(err)
	}
	if !found || !meta.PublishedKnown {
		t.Fatalf("pseudo-version should yield a known date, got found=%v known=%v", found, meta.PublishedKnown)
	}
	if meta.PublishedAt.Year() != 2023 || meta.PublishedAt.Month() != 6 || meta.PublishedAt.Day() != 15 {
		t.Fatalf("wrong derived date: %s", meta.PublishedAt)
	}
}

func TestGoTaggedVersion404IsNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	// A normal tagged version that 404s has no embedded date — stays unknown.
	_, found, err := testClient(srv).GetVersion(context.Background(), model.Go, "github.com/pkg/errors", "v0.9.1")
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Fatal("tagged 404 should be not-found (no derivable date)")
	}
}

func TestScopedNameEncoding(t *testing.T) {
	var rawURI string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawURI = r.RequestURI // raw, exactly as sent on the wire
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	_, _, err := testClient(srv).GetVersion(context.Background(), model.NPM, "@types/node", "20.0.0")
	if err != nil {
		t.Fatal(err)
	}
	// The scope @ and slash must be percent-encoded so the name stays one segment.
	if !strings.Contains(rawURI, "%40types%2Fnode") {
		t.Fatalf("scoped name not encoded: %s", rawURI)
	}
}

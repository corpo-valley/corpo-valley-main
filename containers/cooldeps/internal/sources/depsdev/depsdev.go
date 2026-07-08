// Package depsdev is a client for the free, no-auth deps.dev v3 API. It
// supplies the two immutable facts the cooldown gate needs about a version:
// when it was published and what license it declares. npm, PyPI, and Go modules
// are all covered by the same endpoint.
package depsdev

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/httpx"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

const defaultBaseURL = "https://api.deps.dev/v3"

// Client talks to deps.dev.
type Client struct {
	http    *httpx.Client
	baseURL string
}

// New builds a Client. baseURL may be "" for the public API; it is overridable
// for tests.
func New(h *httpx.Client, baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{http: h, baseURL: strings.TrimRight(baseURL, "/")}
}

// system maps our ecosystem to deps.dev's path segment (lowercase).
func system(e model.Ecosystem) (string, error) {
	switch e {
	case model.NPM:
		return "npm", nil
	case model.PyPI:
		return "pypi", nil
	case model.Go:
		return "go", nil
	default:
		return "", fmt.Errorf("depsdev: unsupported ecosystem %q", e)
	}
}

type versionResp struct {
	PublishedAt string   `json:"publishedAt"`
	Licenses    []string `json:"licenses"`
}

// GetVersion returns publish date + license for one exact version. A 404
// (deps.dev has no record yet — common for just-published versions) yields a
// VersionMeta with PublishedKnown=false and no license, and found=false.
func (c *Client) GetVersion(ctx context.Context, eco model.Ecosystem, name, version string) (meta model.VersionMeta, found bool, err error) {
	sys, err := system(eco)
	if err != nil {
		return model.VersionMeta{}, false, err
	}
	u := fmt.Sprintf("%s/systems/%s/packages/%s/versions/%s",
		c.baseURL, sys, encodeName(name), url.PathEscape(version))

	var vr versionResp
	status, err := c.http.GetJSON(ctx, u, &vr)
	if err != nil {
		return model.VersionMeta{}, false, err
	}
	meta = model.VersionMeta{Ecosystem: eco, Name: name, Version: version}
	if status == 404 {
		// Go pseudo-versions (untagged commits) encode their commit time in the
		// version string itself — derive the publish date so the cooldown rule
		// still works even when deps.dev has no record. License stays unknown.
		if eco == model.Go {
			if t, ok := pseudoVersionTime(version); ok {
				meta.PublishedAt = t
				meta.PublishedKnown = true
				return meta, true, nil
			}
		}
		return meta, false, nil
	}
	if status != 200 {
		return meta, false, fmt.Errorf("depsdev GetVersion %s: status %d", u, status)
	}
	if t, ok := parseTime(vr.PublishedAt); ok {
		meta.PublishedAt = t
		meta.PublishedKnown = true
	}
	meta.License = joinLicenses(vr.Licenses)
	return meta, true, nil
}

// encodeName URL-encodes a package name into a single deps.dev path segment.
// Scoped npm names ("@scope/name") need BOTH the slash and the leading @
// percent-encoded (deps.dev's documented form is e.g. "%40scope%2Fname").
func encodeName(name string) string {
	seg := url.PathEscape(name) // escapes '/', leaves '@'
	return strings.ReplaceAll(seg, "@", "%40")
}

func joinLicenses(ls []string) string {
	clean := make([]string, 0, len(ls))
	for _, l := range ls {
		if s := strings.TrimSpace(l); s != "" {
			clean = append(clean, s)
		}
	}
	// deps.dev returns a list; a multi-entry list means "all of these apply",
	// which maps to an SPDX AND expression for the engine.
	return strings.Join(clean, " AND ")
}

// pseudoVersionRe matches the 14-digit UTC timestamp + 12-hex commit suffix of
// all three Go pseudo-version forms — the timestamp is preceded by a '-' (form
// 1: vX.0.0-<ts>-<hash>) or a '.' (form 2/3: vX.Y.Z-pre.0.<ts>-<hash> and
// vX.Y.Z-0.<ts>-<hash>) — plus an optional build-metadata suffix like
// +incompatible.
var pseudoVersionRe = regexp.MustCompile(`[-.](\d{14})-[0-9a-f]{12}(\+[0-9A-Za-z.-]+)?$`)

func pseudoVersionTime(version string) (time.Time, bool) {
	m := pseudoVersionRe.FindStringSubmatch(version)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102150405", m[1])
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func parseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

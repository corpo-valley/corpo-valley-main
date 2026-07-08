// Package cache holds the proxy's three tiers of state: an immutable metadata
// cache (release date + license, kept forever), a short-TTL vuln cache (OSV
// results, ~6h), and an LRU-capped on-disk artifact cache. The metadata and
// vuln tiers share one embedded bbolt key/value database.
//
// bbolt (pure Go, a single dependency) was chosen over an embedded SQLite so
// that a *dependency*-gating tool carries a tiny, fully-auditable dependency
// tree of its own — and still builds as a static, CGO-free, multi-arch binary.
package cache

import (
	"encoding/json"
	"fmt"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

var (
	bucketMeta = []byte("meta")
	bucketVuln = []byte("vuln")
)

// DB wraps the bbolt handle plus the metadata and vuln tiers.
type DB struct {
	b *bolt.DB
}

// OpenDB opens (creating if needed) the database at path and ensures buckets.
func OpenDB(path string) (*DB, error) {
	b, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open bolt %s: %w", path, err)
	}
	err = b.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bucketMeta, bucketVuln} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		b.Close()
		return nil, fmt.Errorf("init buckets: %w", err)
	}
	return &DB{b: b}, nil
}

func (d *DB) Close() error { return d.b.Close() }

// key composes the per-version key. The components cannot contain a NUL byte, so
// it is an unambiguous separator.
func key(eco model.Ecosystem, name, version string) []byte {
	return []byte(string(eco) + "\x00" + name + "\x00" + version)
}

// --- metadata tier (immutable, forever) ---

type metaRecord struct {
	PublishedAt    int64  `json:"p"`
	PublishedKnown bool   `json:"pk"`
	License        string `json:"l"`
	Found          bool   `json:"f"`
	FetchedAt      int64  `json:"t"`
}

// GetMeta returns cached metadata for an exact version. ok=false means a cold
// cache (caller should fetch). A cached "not found" (found=0) is still a hit:
// it returns ok=true with found=false so the caller need not re-query deps.dev
// for a version it already knows nothing about (subject to refresh recency).
func (d *DB) GetMeta(eco model.Ecosystem, name, version string) (meta model.VersionMeta, found bool, ok bool) {
	var rec metaRecord
	got := false
	_ = d.b.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketMeta).Get(key(eco, name, version))
		if raw == nil {
			return nil
		}
		if json.Unmarshal(raw, &rec) == nil {
			got = true
		}
		return nil
	})
	if !got {
		return model.VersionMeta{}, false, false
	}
	meta = model.VersionMeta{Ecosystem: eco, Name: name, Version: version, License: rec.License}
	if rec.PublishedKnown {
		meta.PublishedAt = time.Unix(rec.PublishedAt, 0).UTC()
		meta.PublishedKnown = true
	}
	return meta, rec.Found, true
}

// PutMeta upserts metadata. found records whether deps.dev actually had the
// version, so a "still unknown" record can be refreshed later.
func (d *DB) PutMeta(meta model.VersionMeta, found bool, now time.Time) error {
	rec := metaRecord{License: meta.License, Found: found, FetchedAt: now.Unix()}
	if meta.PublishedKnown {
		rec.PublishedAt = meta.PublishedAt.Unix()
		rec.PublishedKnown = true
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return d.b.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketMeta).Put(key(meta.Ecosystem, meta.Name, meta.Version), raw)
	})
}

// MetaFetchedAt returns when a metadata row was last fetched, for deciding
// whether to refresh a cached "not found" (unknown-age) record.
func (d *DB) MetaFetchedAt(eco model.Ecosystem, name, version string) (time.Time, bool) {
	var rec metaRecord
	got := false
	_ = d.b.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketMeta).Get(key(eco, name, version))
		if raw != nil && json.Unmarshal(raw, &rec) == nil {
			got = true
		}
		return nil
	})
	if !got {
		return time.Time{}, false
	}
	return time.Unix(rec.FetchedAt, 0).UTC(), true
}

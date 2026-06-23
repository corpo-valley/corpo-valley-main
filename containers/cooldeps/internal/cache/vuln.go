package cache

import (
	"encoding/json"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/hashtagcyber/cooldeps/internal/model"
)

// vulnRow is the persisted shape of one vuln.
type vulnRow struct {
	ID       string         `json:"id"`
	Severity model.Severity `json:"sev"`
}

type vulnRecord struct {
	Vulns   []vulnRow `json:"v"`
	Expires int64     `json:"e"`
}

// GetVulns returns cached vulns for a version if present and not expired.
// ok=false means cold or stale (caller should re-query OSV). An empty non-nil
// slice with ok=true is a valid "known to have no vulns" hit.
func (d *DB) GetVulns(eco model.Ecosystem, name, version string, now time.Time) (vulns []model.Vuln, ok bool) {
	var rec vulnRecord
	got := false
	_ = d.b.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketVuln).Get(key(eco, name, version))
		if raw != nil && json.Unmarshal(raw, &rec) == nil {
			got = true
		}
		return nil
	})
	if !got {
		return nil, false
	}
	if now.Unix() >= rec.Expires {
		return nil, false // stale: force refresh so new CVEs are picked up
	}
	out := make([]model.Vuln, 0, len(rec.Vulns))
	for _, r := range rec.Vulns {
		out = append(out, model.Vuln{ID: r.ID, Severity: r.Severity})
	}
	return out, true
}

// PutVulns upserts the vuln set for a version with a TTL.
func (d *DB) PutVulns(eco model.Ecosystem, name, version string, vulns []model.Vuln, now time.Time, ttl time.Duration) error {
	rec := vulnRecord{Expires: now.Add(ttl).Unix(), Vulns: make([]vulnRow, 0, len(vulns))}
	for _, v := range vulns {
		rec.Vulns = append(rec.Vulns, vulnRow{ID: v.ID, Severity: v.Severity})
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return d.b.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketVuln).Put(key(eco, name, version), raw)
	})
}

// PurgeExpiredVulns deletes stale vuln rows (housekeeping; optional).
func (d *DB) PurgeExpiredVulns(now time.Time) (int64, error) {
	var deleted int64
	err := d.b.Update(func(tx *bolt.Tx) error {
		c := tx.Bucket(bucketVuln).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var rec vulnRecord
			if json.Unmarshal(v, &rec) == nil && now.Unix() >= rec.Expires {
				if err := c.Delete(); err != nil {
					return err
				}
				deleted++
			}
		}
		return nil
	})
	return deleted, err
}

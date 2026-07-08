package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ArtifactCache stores immutable artifact bytes (tarballs, wheels, sdists) on
// disk, keyed by a hash of the upstream URL and sharded into subdirectories so
// no single directory grows unbounded. Total size is bounded by an LRU cap:
// when usage crosses the high-water mark, the least-recently-served files are
// evicted down to the low-water mark. This is the one tier the doc insists must
// be bounded, or the disk fills.
type ArtifactCache struct {
	dir       string
	maxBytes  int64
	highWater int64 // start evicting above this (80% of max)
	lowWater  int64 // evict down to this (70% of max)

	curBytes int64 // atomic running total

	accMu   sync.Mutex // serialises commit size-accounting (stat+rename+add)
	evictMu sync.Mutex // serialises eviction passes
}

// NewArtifactCache prepares the cache directory and computes current usage.
// maxBytes <= 0 disables the cache entirely (Enabled() reports false).
func NewArtifactCache(dir string, maxBytes int64) (*ArtifactCache, error) {
	if maxBytes <= 0 {
		return &ArtifactCache{dir: dir, maxBytes: 0}, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("artifact cache mkdir: %w", err)
	}
	c := &ArtifactCache{
		dir:       dir,
		maxBytes:  maxBytes,
		highWater: maxBytes * 8 / 10,
		lowWater:  maxBytes * 7 / 10,
	}
	total, err := c.scan()
	if err != nil {
		return nil, err
	}
	atomic.StoreInt64(&c.curBytes, total)
	return c, nil
}

// Enabled reports whether artifact caching is on.
func (c *ArtifactCache) Enabled() bool { return c != nil && c.maxBytes > 0 }

// Bytes returns the current cached size.
func (c *ArtifactCache) Bytes() int64 { return atomic.LoadInt64(&c.curBytes) }

func (c *ArtifactCache) pathFor(key string) string {
	sum := sha256.Sum256([]byte(key))
	h := hex.EncodeToString(sum[:])
	return filepath.Join(c.dir, h[:2], h[2:4], h)
}

// Get opens a cached artifact, refreshing its recency (mtime) so LRU reflects
// reads. The caller owns the returned file and must Close it.
func (c *ArtifactCache) Get(key string) (*os.File, int64, bool) {
	if !c.Enabled() {
		return nil, 0, false
	}
	p := c.pathFor(key)
	f, err := os.Open(p)
	if err != nil {
		return nil, 0, false
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, false
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now) // touch for LRU; best-effort
	return f, fi.Size(), true
}

// Writer captures artifact bytes to a temp file; Commit atomically publishes it
// into the cache (and accounts for eviction), Abort discards it. This lets a
// backend tee an upstream stream into the cache while serving the client, and
// only keep the bytes if the transfer completed.
type Writer struct {
	cache *ArtifactCache
	key   string
	tmp   *os.File
	final string
	n     int64
	done  bool
}

// NewWriter returns a Writer for key, or (nil,false) when caching is disabled.
func (c *ArtifactCache) NewWriter(key string) (*Writer, bool) {
	if !c.Enabled() {
		return nil, false
	}
	final := c.pathFor(key)
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return nil, false
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), ".tmp-*")
	if err != nil {
		return nil, false
	}
	return &Writer{cache: c, key: key, tmp: tmp, final: final}, true
}

func (w *Writer) Write(p []byte) (int, error) {
	n, err := w.tmp.Write(p)
	w.n += int64(n)
	return n, err
}

// Commit flushes and atomically renames the temp file into place, updates the
// size accounting, and triggers eviction if over the high-water mark.
func (w *Writer) Commit() error {
	if w.done {
		return nil
	}
	w.done = true
	if err := w.tmp.Close(); err != nil {
		os.Remove(w.tmp.Name())
		return err
	}
	// Account for the size DELTA, not w.n: if a file already exists at the
	// destination (a concurrent or repeat commit of the same URL), the rename
	// overwrites it, so only (new - old) bytes are added. Serialising stat+
	// rename+add keeps curBytes exact even when two goroutines commit the same
	// key — otherwise it would double-count and over-evict.
	c := w.cache
	c.accMu.Lock()
	var old int64
	if fi, err := os.Stat(w.final); err == nil {
		old = fi.Size()
	}
	if err := os.Rename(w.tmp.Name(), w.final); err != nil {
		c.accMu.Unlock()
		os.Remove(w.tmp.Name())
		return err
	}
	atomic.AddInt64(&c.curBytes, w.n-old)
	c.accMu.Unlock()

	c.maybeEvict()
	return nil
}

// Abort discards the partial temp file.
func (w *Writer) Abort() {
	if w.done {
		return
	}
	w.done = true
	w.tmp.Close()
	os.Remove(w.tmp.Name())
}

func (c *ArtifactCache) maybeEvict() {
	if atomic.LoadInt64(&c.curBytes) <= c.highWater {
		return
	}
	// Only one eviction pass at a time; others can skip — the survivor frees space.
	if !c.evictMu.TryLock() {
		return
	}
	defer c.evictMu.Unlock()
	if atomic.LoadInt64(&c.curBytes) <= c.highWater {
		return
	}
	c.evictTo(c.lowWater)
}

type fileEntry struct {
	path  string
	size  int64
	mtime time.Time
}

// evictTo deletes least-recently-served files until usage <= target.
func (c *ArtifactCache) evictTo(target int64) {
	var entries []fileEntry
	filepath.Walk(c.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if filepath.Base(path)[0] == '.' {
			return nil // skip in-flight temp files
		}
		entries = append(entries, fileEntry{path: path, size: info.Size(), mtime: info.ModTime()})
		return nil
	})
	sort.Slice(entries, func(i, j int) bool { return entries[i].mtime.Before(entries[j].mtime) })
	for _, e := range entries {
		if atomic.LoadInt64(&c.curBytes) <= target {
			break
		}
		// Serialise remove+accounting with Commit's stat+rename+add (accMu) so a
		// file removed here while it is being re-committed can't double-adjust
		// curBytes. Re-stat under the lock to charge the true on-disk size.
		c.accMu.Lock()
		if fi, err := os.Stat(e.path); err == nil {
			if err := os.Remove(e.path); err == nil {
				atomic.AddInt64(&c.curBytes, -fi.Size())
			}
		}
		c.accMu.Unlock()
	}
}

func (c *ArtifactCache) scan() (int64, error) {
	var total int64
	err := filepath.Walk(c.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() && filepath.Base(path)[0] != '.' {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

var _ io.Writer = (*Writer)(nil)

// Command cooldeps is the self-hosted package-manager gating proxy. It speaks
// the native npm, PyPI, and Go-module protocols, evaluates each requested
// version against a declarative policy (release-age cooldown, license, known
// CVEs), and blocks or passes the install before the bytes land.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hashtagcyber/cooldeps/internal/backend"
	"github.com/hashtagcyber/cooldeps/internal/cache"
	"github.com/hashtagcyber/cooldeps/internal/config"
	"github.com/hashtagcyber/cooldeps/internal/eval"
	"github.com/hashtagcyber/cooldeps/internal/httpx"
	"github.com/hashtagcyber/cooldeps/internal/policy"
	"github.com/hashtagcyber/cooldeps/internal/proxy"
	"github.com/hashtagcyber/cooldeps/internal/sources/depsdev"
	"github.com/hashtagcyber/cooldeps/internal/sources/osv"
)

// version is overridden at build time via -ldflags.
var version = "dev"

func main() {
	cfg, err := config.Load()
	log := newLogger(cfg.Server.LogLevel)
	if err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	if err := run(cfg, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, log *slog.Logger) error {
	if err := os.MkdirAll(cfg.Cache.DataDir, 0o755); err != nil {
		return err
	}

	pol := cfg.Policy
	log.Info("policy loaded",
		"cooldownDays", pol.ReleaseAge.MinDays,
		"maxSeverity", pol.CVE.MaxSeverity,
		"failOpen", pol.FailOpen,
		"overrideAllow", len(pol.Overrides.Allow),
		"overrideBlock", len(pol.Overrides.Block))

	db, err := cache.OpenDB(cfg.DBPath())
	if err != nil {
		return err
	}
	defer db.Close()

	maxBytes := int64(cfg.Cache.ArtifactMaxBytes)
	if !cfg.Cache.Artifacts {
		maxBytes = 0
	}
	artifacts, err := cache.NewArtifactCache(cfg.Cache.ArtifactDir, maxBytes)
	if err != nil {
		return err
	}
	log.Info("artifact cache", "enabled", artifacts.Enabled(), "dir", cfg.Cache.ArtifactDir,
		"maxBytes", maxBytes, "currentBytes", artifacts.Bytes())

	ua := "cooldeps-proxy/" + version + " (+https://github.com/hashtagcyber/cooldeps)"
	hx := httpx.New(ua)
	depsClient := depsdev.New(hx, "")
	osvClient := osv.New(hx, "")

	engine := policy.NewEngine(pol)
	evaluator := eval.New(engine, depsClient, osvClient, db, eval.Config{
		VulnTTL:          cfg.Cache.VulnTTL.Std(),
		NotFoundRefresh:  cfg.Cache.MetaNotFoundRefresh.Std(),
		MetaTTL:          cfg.Cache.MetaTTL.Std(),
		FetchConcurrency: cfg.Cache.FetchConcurrency,
	})

	// Dedicated client for artifact streaming (longer timeout than metadata).
	artifactHTTP := &http.Client{Timeout: 5 * time.Minute}

	npmBackend, err := backend.NewNPM(cfg.Server.NPMUpstream, evaluator, artifacts, artifactHTTP, cfg.Server.PublicURL, log)
	if err != nil {
		return err
	}
	pypiBackend, err := backend.NewPyPI(cfg.Server.PyPIUpstream, evaluator, log)
	if err != nil {
		return err
	}
	goBackend, err := backend.NewGoMod(cfg.Server.GoUpstream, evaluator, artifacts, artifactHTTP, log)
	if err != nil {
		return err
	}

	srv := proxy.New(npmBackend, pypiBackend, goBackend, version, cfg.Server.StatusEnabled)
	httpServer := &http.Server{
		Addr:    cfg.Server.Addr,
		Handler: srv.Handler(),
		// Slow-loris / idle-connection hardening. WriteTimeout bounds only the
		// cheap local endpoints; the streaming backends clear their write
		// deadline (see proxy.Stats.wrap), so large downloads aren't capped.
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Periodic vuln-cache housekeeping.
	stop := make(chan struct{})
	go housekeep(db, log, stop)

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Server.Addr, "npmUpstream", cfg.Server.NPMUpstream, "pypiUpstream", cfg.Server.PyPIUpstream, "goUpstream", cfg.Server.GoUpstream, "version", version)
		errCh <- httpServer.ListenAndServe()
	}()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		close(stop)
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer shutCancel()
		return httpServer.Shutdown(shutCtx)
	}
}

func housekeep(db *cache.DB, log *slog.Logger, stop <-chan struct{}) {
	t := time.NewTicker(1 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if n, err := db.PurgeExpiredVulns(time.Now()); err == nil && n > 0 {
				log.Debug("purged expired vuln rows", "count", n)
			}
		}
	}
}

func newLogger(level string) *slog.Logger {
	lvl := slog.LevelInfo
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}

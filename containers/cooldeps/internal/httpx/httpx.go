// Package httpx is a thin HTTP client wrapper shared by the deps.dev and OSV
// sources. It centralises the "polite client" behaviour the design doc calls
// for: a descriptive User-Agent, exponential backoff on 429/5xx (honouring
// Retry-After), and JSON encode/decode helpers.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"time"
)

// Client wraps *http.Client with retries and a User-Agent.
type Client struct {
	HTTP       *http.Client
	UserAgent  string
	MaxRetries int           // number of retries after the first attempt
	BaseDelay  time.Duration // first backoff step; doubles each retry
}

// New returns a Client with sane defaults.
func New(userAgent string) *Client {
	return &Client{
		HTTP:       &http.Client{Timeout: 30 * time.Second},
		UserAgent:  userAgent,
		MaxRetries: 4,
		BaseDelay:  300 * time.Millisecond,
	}
}

// retryable reports whether an HTTP status warrants a retry.
func retryable(code int) bool {
	return code == http.StatusTooManyRequests || (code >= 500 && code <= 599)
}

// do executes the request with retries. The body factory is called fresh for
// each attempt so request bodies can be replayed.
func (c *Client) do(ctx context.Context, method, url string, body func() io.Reader) (*http.Response, error) {
	var (
		lastErr      error
		nextOverride *time.Duration // Retry-After carried into the next attempt's backoff
	)
	for attempt := 0; attempt <= c.MaxRetries; attempt++ {
		if attempt > 0 {
			if err := c.sleep(ctx, attempt, nextOverride); err != nil {
				return nil, err
			}
			nextOverride = nil
		}
		req, err := http.NewRequestWithContext(ctx, method, url, body())
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", c.UserAgent)
		req.Header.Set("Accept", "application/json")
		if method == http.MethodPost {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = err
			continue // network error: retry
		}
		if retryable(resp.StatusCode) && attempt < c.MaxRetries {
			nextOverride = parseRetryAfter(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			lastErr = fmt.Errorf("%s %s: status %d", method, url, resp.StatusCode)
			continue
		}
		return resp, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("%s %s: exhausted retries", method, url)
	}
	return nil, lastErr
}

// maxBackoff caps any single backoff sleep, including a server-supplied
// Retry-After. Without it an upstream rate-limit response carrying a huge
// Retry-After (seconds or HTTP-date) could pin a request goroutine — and its
// bounded evaluator concurrency slot — for minutes/hours.
const maxBackoff = 30 * time.Second

func (c *Client) sleep(ctx context.Context, attempt int, override *time.Duration) error {
	d := c.BaseDelay * time.Duration(1<<uint(attempt-1))
	if override != nil && *override > d {
		d = *override
	}
	if d > maxBackoff {
		d = maxBackoff
	}
	// jitter ±25% to avoid thundering herd
	if d > 0 {
		j := time.Duration(rand.Int63n(int64(d/2+1))) - d/4
		d += j
	}
	if d < 0 {
		d = 0
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func parseRetryAfter(h string) *time.Duration {
	if h == "" {
		return nil
	}
	if secs, err := strconv.Atoi(h); err == nil {
		d := time.Duration(secs) * time.Second
		return &d
	}
	if t, err := http.ParseTime(h); err == nil {
		d := time.Until(t)
		if d > 0 {
			return &d
		}
	}
	return nil
}

// GetJSON fetches url and decodes the body into out (if non-nil). It returns the
// HTTP status code; a non-2xx status is returned with a nil error so callers can
// special-case 404 (not found) versus a transport failure.
func (c *Client) GetJSON(ctx context.Context, url string, out any) (int, error) {
	resp, err := c.do(ctx, http.MethodGet, url, func() io.Reader { return nil })
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return decode(resp, out)
}

// PostJSON marshals body and posts it to url, decoding the response into out.
func (c *Client) PostJSON(ctx context.Context, url string, body, out any) (int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	resp, err := c.do(ctx, http.MethodPost, url, func() io.Reader { return bytes.NewReader(raw) })
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return decode(resp, out)
}

func decode(resp *http.Response, out any) (int, error) {
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Fully drain the error body (capped) so the keep-alive connection can be
		// reused instead of being discarded. Error bodies from deps.dev/OSV are
		// small; the 1 MiB cap guards against a pathological one.
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return resp.StatusCode, nil
	}
	if out == nil {
		io.Copy(io.Discard, resp.Body)
		return resp.StatusCode, nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return resp.StatusCode, fmt.Errorf("decode response: %w", err)
	}
	return resp.StatusCode, nil
}

// Package osv is a client for the free, no-auth OSV.dev API. querybatch tells
// us which versions have advisories (IDs only, no severity); a follow-up GET on
// each advisory resolves a CVSS/GHSA severity band. We only do the follow-ups
// for the small fraction of versions that actually have hits.
package osv

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashtagcyber/cooldeps/internal/httpx"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

const defaultBaseURL = "https://api.osv.dev/v1"

// querybatch accepts up to 1000 queries per request (OSV documented cap).
const maxBatch = 1000

// Client talks to OSV.dev.
type Client struct {
	http    *httpx.Client
	baseURL string
}

func New(h *httpx.Client, baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{http: h, baseURL: strings.TrimRight(baseURL, "/")}
}

// ecosystem maps to OSV's ecosystem string. Note OSV spells PyPI "PyPI".
func ecosystem(e model.Ecosystem) (string, error) {
	switch e {
	case model.NPM:
		return "npm", nil
	case model.PyPI:
		return "PyPI", nil
	case model.Go:
		return "Go", nil
	default:
		return "", fmt.Errorf("osv: unsupported ecosystem %q", e)
	}
}

// Query is one (ecosystem, name, version) lookup.
type Query struct {
	Ecosystem model.Ecosystem
	Name      string
	Version   string
}

type batchPackage struct {
	Ecosystem string `json:"ecosystem"`
	Name      string `json:"name"`
}
type batchQuery struct {
	Package batchPackage `json:"package"`
	Version string       `json:"version"`
}
type batchReq struct {
	Queries []batchQuery `json:"queries"`
}
type batchVuln struct {
	ID string `json:"id"`
}
type batchResult struct {
	Vulns []batchVuln `json:"vulns"`
}
type batchResp struct {
	Results []batchResult `json:"results"`
}

// QueryBatch returns, for each input query (by index), the advisory IDs that
// affect it. Severity is NOT included here — callers resolve it via GetSeverity
// only for the IDs that matter. Results align 1:1 with queries.
func (c *Client) QueryBatch(ctx context.Context, queries []Query) ([][]string, error) {
	out := make([][]string, len(queries))
	for start := 0; start < len(queries); start += maxBatch {
		end := start + maxBatch
		if end > len(queries) {
			end = len(queries)
		}
		chunk := queries[start:end]
		req := batchReq{Queries: make([]batchQuery, 0, len(chunk))}
		for _, q := range chunk {
			eco, err := ecosystem(q.Ecosystem)
			if err != nil {
				return nil, err
			}
			req.Queries = append(req.Queries, batchQuery{
				Package: batchPackage{Ecosystem: eco, Name: q.Name},
				Version: q.Version,
			})
		}
		var resp batchResp
		status, err := c.http.PostJSON(ctx, c.baseURL+"/querybatch", req, &resp)
		if err != nil {
			return nil, err
		}
		if status != 200 {
			return nil, fmt.Errorf("osv querybatch: status %d", status)
		}
		// Results MUST align 1:1 with queries. A short response would otherwise
		// leave trailing indices nil — silently read as "no vulns", i.e. a CVE
		// fail-open. Treat a count mismatch as an error so the evaluator applies
		// the configured fail-open/closed policy instead.
		if len(resp.Results) != len(chunk) {
			return nil, fmt.Errorf("osv querybatch: got %d results for %d queries", len(resp.Results), len(chunk))
		}
		for i, r := range resp.Results {
			ids := make([]string, 0, len(r.Vulns))
			for _, v := range r.Vulns {
				if v.ID != "" {
					ids = append(ids, v.ID)
				}
			}
			out[start+i] = ids
		}
	}
	return out, nil
}

type vulnResp struct {
	ID       string `json:"id"`
	Severity []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	} `json:"severity"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		DatabaseSpecific struct {
			Severity string `json:"severity"`
		} `json:"database_specific"`
	} `json:"affected"`
}

// GetSeverity fetches one advisory and resolves it to a severity band. It
// prefers a CVSS vector (computed to a real base score), then a GHSA-style
// textual band, falling back to Unknown when nothing is parseable — which the
// policy engine treats as offending (fail-safe).
func (c *Client) GetSeverity(ctx context.Context, id string) (model.Severity, error) {
	var vr vulnResp
	status, err := c.http.GetJSON(ctx, c.baseURL+"/vulns/"+id, &vr)
	if err != nil {
		return model.SeverityUnknown, err
	}
	if status == 404 {
		return model.SeverityUnknown, nil
	}
	if status != 200 {
		return model.SeverityUnknown, fmt.Errorf("osv vulns/%s: status %d", id, status)
	}
	return severityFromResp(vr), nil
}

func severityFromResp(vr vulnResp) model.Severity {
	best := model.SeverityNone
	found := false
	// 1) CVSS vectors -> real base score -> band (take the worst vector).
	for _, s := range vr.Severity {
		if score, ok := CVSSBaseScore(s.Score); ok {
			b := bandFromScore(score)
			if b > best {
				best = b
			}
			found = true
		}
	}
	// 2) Textual GHSA bands (top-level and per-affected).
	textual := []string{vr.DatabaseSpecific.Severity}
	for _, a := range vr.Affected {
		textual = append(textual, a.DatabaseSpecific.Severity)
	}
	for _, t := range textual {
		if t == "" {
			continue
		}
		// A parseable band (including an explicit "NONE") counts as resolved, so
		// an advisory the database rated NONE yields SeverityNone — not Unknown,
		// which would be treated as offending and over-block.
		if b := model.ParseSeverity(t); b != model.SeverityUnknown {
			found = true
			if b > best {
				best = b
			}
		}
	}
	if !found {
		return model.SeverityUnknown
	}
	return best
}

func bandFromScore(score float64) model.Severity {
	switch {
	case score <= 0:
		return model.SeverityNone
	case score < 4.0:
		return model.SeverityLow
	case score < 7.0:
		return model.SeverityMedium
	case score < 9.0:
		return model.SeverityHigh
	default:
		return model.SeverityCritical
	}
}

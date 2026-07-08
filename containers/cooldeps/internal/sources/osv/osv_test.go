package osv

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hashtagcyber/cooldeps/internal/httpx"
	"github.com/hashtagcyber/cooldeps/internal/model"
)

func testClient(srv *httptest.Server) *Client {
	h := httpx.New("cooldeps-test")
	h.BaseDelay = 0
	return New(h, srv.URL)
}

func TestQueryBatchAlignsResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/querybatch" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var req batchReq
		json.NewDecoder(r.Body).Decode(&req)
		// First query has a vuln, second has none.
		resp := batchResp{Results: make([]batchResult, len(req.Queries))}
		if len(req.Queries) > 0 {
			resp.Results[0] = batchResult{Vulns: []batchVuln{{ID: "GHSA-aaaa"}}}
		}
		// Assert the ecosystem string is passed through to OSV verbatim.
		if req.Queries[0].Package.Ecosystem != "npm" {
			t.Errorf("expected npm ecosystem, got %q", req.Queries[0].Package.Ecosystem)
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := testClient(srv)
	res, err := c.QueryBatch(context.Background(), []Query{
		{Ecosystem: model.NPM, Name: "left-pad", Version: "1.3.0"},
		{Ecosystem: model.NPM, Name: "clean", Version: "2.0.0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || len(res[0]) != 1 || res[0][0] != "GHSA-aaaa" || len(res[1]) != 0 {
		t.Fatalf("unexpected results: %+v", res)
	}
}

func TestQueryBatchErrorsOnShortResults(t *testing.T) {
	// OSV returns fewer results than queries — must error, not silently treat
	// the missing ones as "no vulns" (a CVE fail-open).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(batchResp{Results: []batchResult{{}}}) // 1 result for 2 queries
	}))
	defer srv.Close()
	_, err := testClient(srv).QueryBatch(context.Background(), []Query{
		{Ecosystem: model.NPM, Name: "a", Version: "1"},
		{Ecosystem: model.NPM, Name: "b", Version: "2"},
	})
	if err == nil {
		t.Fatal("expected error on result/query count mismatch (fail-closed), got nil")
	}
}

func TestGetSeverityFromCVSS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(vulnResp{
			ID: "GHSA-aaaa",
			Severity: []struct {
				Type  string `json:"type"`
				Score string `json:"score"`
			}{{Type: "CVSS_V3", Score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}},
		})
	}))
	defer srv.Close()
	sev, err := testClient(srv).GetSeverity(context.Background(), "GHSA-aaaa")
	if err != nil {
		t.Fatal(err)
	}
	if sev != model.SeverityCritical {
		t.Fatalf("expected CRITICAL, got %s", sev)
	}
}

func TestGetSeverityTextualFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"GHSA-bbbb","database_specific":{"severity":"MODERATE"}}`))
	}))
	defer srv.Close()
	sev, err := testClient(srv).GetSeverity(context.Background(), "GHSA-bbbb")
	if err != nil {
		t.Fatal(err)
	}
	if sev != model.SeverityMedium {
		t.Fatalf("expected MEDIUM from MODERATE, got %s", sev)
	}
}

func TestGetSeverityTextualNoneIsNoneNotUnknown(t *testing.T) {
	// An advisory the database explicitly rated NONE must resolve to NONE (which
	// is below any concrete maxSeverity), not Unknown (which would over-block).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"GHSA-none","database_specific":{"severity":"NONE"}}`))
	}))
	defer srv.Close()
	sev, err := testClient(srv).GetSeverity(context.Background(), "GHSA-none")
	if err != nil {
		t.Fatal(err)
	}
	if sev != model.SeverityNone {
		t.Fatalf("textual NONE should resolve to SeverityNone, got %s", sev)
	}
}

func TestGetSeverityUnknownWhenUnparseable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"GHSA-cccc"}`))
	}))
	defer srv.Close()
	sev, err := testClient(srv).GetSeverity(context.Background(), "GHSA-cccc")
	if err != nil {
		t.Fatal(err)
	}
	if sev != model.SeverityUnknown {
		t.Fatalf("expected UNKNOWN, got %s", sev)
	}
}

func TestRetryOn503(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"id":"GHSA-dddd","database_specific":{"severity":"HIGH"}}`))
	}))
	defer srv.Close()
	sev, err := testClient(srv).GetSeverity(context.Background(), "GHSA-dddd")
	if err != nil {
		t.Fatal(err)
	}
	if sev != model.SeverityHigh {
		t.Fatalf("expected HIGH after retries, got %s", sev)
	}
	if hits != 3 {
		t.Fatalf("expected 3 attempts, got %d", hits)
	}
}

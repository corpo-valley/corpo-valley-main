package backend

import (
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

func TestReadAllLimitedCap(t *testing.T) {
	defer SetMaxUpstreamBody(0)

	SetMaxUpstreamBody(16)
	if _, err := readAllLimited(strings.NewReader(strings.Repeat("x", 17)), ""); err == nil {
		t.Fatal("expected error when body exceeds cap")
	}
	b, err := readAllLimited(strings.NewReader(strings.Repeat("x", 16)), "")
	if err != nil || len(b) != 16 {
		t.Fatalf("body at cap should be accepted: len=%d err=%v", len(b), err)
	}

	// A gzip body is measured after decompression.
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte(strings.Repeat("y", 64)))
	zw.Close()
	if _, err := readAllLimited(bytes.NewReader(buf.Bytes()), "gzip"); err == nil {
		t.Fatal("expected error when decompressed body exceeds cap")
	}

	SetMaxUpstreamBody(0)
	if maxUpstreamBody != defaultMaxUpstreamBody {
		t.Fatalf("SetMaxUpstreamBody(0) should restore the default, got %d", maxUpstreamBody)
	}
	if defaultMaxUpstreamBody <= 64<<20 {
		t.Fatalf("default must exceed 64 MiB so @prisma/client-sized packuments pass, got %d", defaultMaxUpstreamBody)
	}
}

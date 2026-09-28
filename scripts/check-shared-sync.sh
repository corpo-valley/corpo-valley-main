#!/usr/bin/env sh
# Fails if any MIRRORED source file has drifted between the portal and the
# mcp-gateway. The two packages have separate Docker build contexts and cannot
# import across each other, so security-relevant grammar they must agree on
# (MCP resource canonicalisation) is kept as identical copies — and this check
# is what stops the copies from silently diverging.
set -eu
cd "$(dirname "$0")/.."
status=0
for f in shared/mcp-resources.ts shared/mcp-resources.test.ts; do
  a="typescript/portal/src/$f"
  b="typescript/mcp-gateway/src/$f"
  if ! cmp -s "$a" "$b"; then
    echo "DRIFT: $a and $b differ — copy one over the other" >&2
    diff -u "$a" "$b" >&2 || true
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "shared files in sync"
exit "$status"

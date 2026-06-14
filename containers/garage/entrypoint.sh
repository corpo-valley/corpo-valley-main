#!/bin/sh
# Self-bootstrapping entrypoint for a single-node Garage (v1.0.1).
#
# Brings up the daemon, waits for it to be ready, then idempotently initializes
# the cluster layout, the bucket, and the app access key (IMPORTED from the
# exact credentials the portal pre-generated and passed via env). Every step is
# guarded or tolerates "already exists" so that k8s restarts — which re-run this
# script against an existing /data PVC — are no-ops.
#
# Secrets (rpc_secret, admin_token) are read by garage itself from the env vars
# GARAGE_RPC_SECRET and GARAGE_ADMIN_TOKEN; they are NOT in garage.toml.
set -eu

CONFIG="${GARAGE_CONFIG_FILE:-/etc/garage.toml}"
BUCKET="${S3_BUCKET:-app}"

# garage subcommands read the config from -c. Define a small wrapper.
g() { garage -c "$CONFIG" "$@"; }

# ── Required runtime inputs ───────────────────────────────────────────────────
: "${GARAGE_RPC_SECRET:?GARAGE_RPC_SECRET must be set (32-byte hex cluster secret)}"
: "${GARAGE_ADMIN_TOKEN:?GARAGE_ADMIN_TOKEN must be set (admin API token)}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID must be set (portal-generated access key id)}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY must be set (portal-generated secret)}"

# ── (a) Start the server in the background, capture its PID ────────────────────
echo "[entrypoint] starting garage server..."
garage -c "$CONFIG" server &
GARAGE_PID=$!

# Forward termination signals to the daemon and wait for it to exit cleanly.
# (tini is PID 1 and reaps; this gives us graceful shutdown of the child.)
term() {
    echo "[entrypoint] received signal, stopping garage (pid $GARAGE_PID)..."
    kill -TERM "$GARAGE_PID" 2>/dev/null || true
    wait "$GARAGE_PID" 2>/dev/null || true
    exit 0
}
trap term TERM INT

# ── (b) Poll until the node is up (bounded retries) ───────────────────────────
# `garage status` succeeds and lists this node once the RPC layer is serving.
# We grep for a "NO ROLE ASSIGNED" or any line containing the node, but simply
# requiring the command to succeed is the robust readiness signal.
echo "[entrypoint] waiting for garage to become ready..."
ready=0
i=1
while [ "$i" -le 60 ]; do
    # Bail early if the daemon died.
    if ! kill -0 "$GARAGE_PID" 2>/dev/null; then
        echo "[entrypoint] garage server exited during startup" >&2
        wait "$GARAGE_PID" 2>/dev/null || true
        exit 1
    fi
    if g status >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
    i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then
    echo "[entrypoint] garage did not become ready within timeout" >&2
    kill -TERM "$GARAGE_PID" 2>/dev/null || true
    exit 1
fi
echo "[entrypoint] garage is ready."

# ── (c) Initialize the cluster layout (only if not already applied) ───────────
# A fresh node has no role; once a layout version >= 1 is applied it persists in
# /data/meta, so on restart we skip this entirely. We detect "already laid out"
# by checking whether layout show reports a non-zero current version.
#
# `garage layout show` prints "Current cluster layout version: N". If N >= 1 the
# layout already exists. We also treat a node that already has a role as done.
layout_version="$(g layout show 2>/dev/null \
    | sed -n 's/.*[Cc]urrent cluster layout version:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -n1)"
layout_version="${layout_version:-0}"

if [ "$layout_version" -ge 1 ]; then
    echo "[entrypoint] cluster layout already applied (version $layout_version); skipping."
else
    echo "[entrypoint] no cluster layout yet; assigning role to this node..."
    NODE_ID="$(g node id -q)"
    # node id may print "<id>@<addr>"; the assign command accepts the full
    # value or a unique prefix. Strip any @addr suffix to be safe.
    NODE_ID="${NODE_ID%%@*}"
    if [ -z "$NODE_ID" ]; then
        echo "[entrypoint] could not determine node id" >&2
        exit 1
    fi
    g layout assign -z dc1 -c 10G "$NODE_ID"
    # Apply as version 1 (the first layout version of a fresh cluster).
    g layout apply --version 1
    echo "[entrypoint] cluster layout applied (version 1)."
fi

# Wait for the storage subsystem to be usable after layout apply before we
# create buckets/keys (otherwise the first bucket op can race the layout sync).
echo "[entrypoint] waiting for storage to be writable..."
i=1
while [ "$i" -le 30 ]; do
    if g bucket list >/dev/null 2>&1; then
        break
    fi
    sleep 1
    i=$((i + 1))
done

# ── (d) Ensure the bucket exists (tolerate "already exists") ──────────────────
echo "[entrypoint] ensuring bucket '$BUCKET' exists..."
if g bucket create "$BUCKET" 2>/tmp/bucket_err; then
    echo "[entrypoint] bucket '$BUCKET' created."
else
    if grep -qi 'already exists\|already a bucket\|alreadyexists' /tmp/bucket_err; then
        echo "[entrypoint] bucket '$BUCKET' already exists; ok."
    else
        echo "[entrypoint] bucket create failed:" >&2
        cat /tmp/bucket_err >&2
        exit 1
    fi
fi
rm -f /tmp/bucket_err

# ── (e) Import the app key with the EXACT portal-provided credentials ─────────
# `garage key import <ACCESS_KEY_ID> <SECRET_KEY> -n <name> --yes` (v1.0 syntax:
# two positional args, -n for the display name, --yes to skip the confirmation
# prompt). We do NOT use `key create` — the secret must match what the portal
# generated and handed to the application.
echo "[entrypoint] importing app access key '$S3_ACCESS_KEY_ID'..."
if g key import --yes -n appkey "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" 2>/tmp/key_err; then
    echo "[entrypoint] key imported."
else
    if grep -qi 'already exists\|already a key\|duplicate\|alreadyexists' /tmp/key_err; then
        echo "[entrypoint] key '$S3_ACCESS_KEY_ID' already exists; ok."
    else
        echo "[entrypoint] key import failed:" >&2
        cat /tmp/key_err >&2
        exit 1
    fi
fi
rm -f /tmp/key_err

# ── (f) Grant the key read+write on the bucket (idempotent) ───────────────────
# `garage bucket allow --read --write --key <key> <bucket>`. Re-running an
# already-granted allow is a no-op in Garage, so we just tolerate any error that
# is not fatal.
echo "[entrypoint] granting read+write on '$BUCKET' to key '$S3_ACCESS_KEY_ID'..."
if g bucket allow --read --write --key "$S3_ACCESS_KEY_ID" "$BUCKET" 2>/tmp/allow_err; then
    echo "[entrypoint] permissions granted."
else
    # An allow that is already in effect should not be fatal; surface other
    # errors but do not crash the container on a benign re-grant.
    echo "[entrypoint] bucket allow returned non-zero (continuing):" >&2
    cat /tmp/allow_err >&2
fi
rm -f /tmp/allow_err

echo "[entrypoint] bootstrap complete; garage is serving the S3 API on :3900."

# ── (g) Track the daemon's lifetime ───────────────────────────────────────────
# Block on the server process so the container lives exactly as long as garage.
wait "$GARAGE_PID"

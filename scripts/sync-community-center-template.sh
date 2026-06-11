#!/usr/bin/env bash
# MANUAL escape hatch: force-push the local `community-center/` baseline to the
# Gitea template repo `corpo-valley/community-center`.
#
# You normally don't need this. The portal seeds the template automatically on
# first startup (when the Gitea repo is missing/empty), and admins reset it to
# the baked-in baseline from the portal UI (Admin → Project Template → Reset).
# After the first seed, the GITEA REPO IS ADMIN-OWNED: platform admins edit it
# in Gitea and new projects generate from whatever it holds. This script is for
# operators with kubectl access who want to force the reset from a local
# checkout (e.g. the portal is down, or you're testing template changes that
# aren't in a portal image yet). Like the admin reset, it OVERWRITES admin
# edits.
#
# The baseline carries {{CV_*}} placeholders for deployment-specific values
# (rendered by the portal's template-seed service in the normal path). This
# script renders them with the same defaults; override via env for a
# non-default deployment:
#   CV_NAMESPACE_PREFIX, CV_REGISTRY, CV_PORTAL_PIN_URL,
#   CV_PORTAL_LOGIN_URL, CV_KRATOS_PUBLIC_URL, CV_PROJECTS_DOMAIN
#
# Usage:
#   scripts/sync-community-center-template.sh
#
# Requirements:
#   - kubectl context on the cluster (used to read the cvportal admin token and
#     to port-forward Gitea).
#   - git in PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/community-center"

# Namespaces follow the chart's namespacePrefix (default cv-).
NSP="${CV_NAMESPACE_PREFIX:-cv-}"

# Deployment-specific values rendered into the {{CV_*}} placeholders. Defaults
# reproduce the original corpo-valley.com deployment — keep these in sync with
# typescript/portal/src/services/platform-config.ts.
CV_REGISTRY="${CV_REGISTRY:-registry.${NSP}registry.svc.cluster.local:5000}"
CV_PORTAL_PIN_URL="${CV_PORTAL_PIN_URL:-http://portal.${NSP}portal.svc.cluster.local/internal/projects}"
CV_PORTAL_LOGIN_URL="${CV_PORTAL_LOGIN_URL:-https://portal.corpo-valley.com/login}"
CV_KRATOS_PUBLIC_URL="${CV_KRATOS_PUBLIC_URL:-http://ory-kratos-public.${NSP}ory.svc.cluster.local:4433}"
CV_PROJECTS_DOMAIN="${CV_PROJECTS_DOMAIN:-projects.corpo-valley.com}"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: $SRC_DIR not found" >&2
  exit 1
fi

# Pull the cvportal admin creds from the deployed gitea-admin sealed secret.
TOKEN="$(kubectl -n "${NSP}portal" get secret gitea-admin -o jsonpath='{.data.GITEA_ADMIN_TOKEN}' | base64 -d)"
USER="$(kubectl -n "${NSP}portal" get secret gitea-admin -o jsonpath='{.data.GITEA_ADMIN_USER}' | base64 -d)"
if [ -z "$TOKEN" ] || [ -z "$USER" ]; then
  echo "ERROR: could not read cvportal credentials from ${NSP}portal/gitea-admin" >&2
  exit 1
fi

# Port-forward to in-cluster Gitea. We tear it down on exit.
PF_PORT=18080
kubectl -n "${NSP}gitea" port-forward svc/gitea "$PF_PORT:80" >/tmp/cv-sync-template-pf.log 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
# Wait for the port-forward to be ready.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null "http://127.0.0.1:$PF_PORT/api/v1/version"; then break; fi
  sleep 0.5
done

TMP="$(mktemp -d)"
REMOTE="http://${USER}:${TOKEN}@127.0.0.1:${PF_PORT}/corpo-valley/community-center.git"

git clone --quiet --depth=1 "$REMOTE" "$TMP/community-center"

# Wipe the working tree (keep .git), then copy the source over the top.
# `find -mindepth 1` so we don't try to remove the directory itself.
cd "$TMP/community-center"
find . -mindepth 1 -path ./.git -prune -o -exec rm -rf {} + 2>/dev/null || true
# Copy source (including dotfiles), excluding any stray .git.
cp -a "$SRC_DIR/." .
rm -rf .git/index.lock 2>/dev/null || true

# Render the {{CV_*}} placeholders (same substitutions as template-seed.ts).
find . -path ./.git -prune -o -type f -print0 | xargs -0 sed -i \
  -e "s|{{CV_REGISTRY}}|${CV_REGISTRY}|g" \
  -e "s|{{CV_PORTAL_PIN_URL}}|${CV_PORTAL_PIN_URL}|g" \
  -e "s|{{CV_PORTAL_LOGIN_URL}}|${CV_PORTAL_LOGIN_URL}|g" \
  -e "s|{{CV_KRATOS_PUBLIC_URL}}|${CV_KRATOS_PUBLIC_URL}|g" \
  -e "s|{{CV_PROJECTS_DOMAIN}}|${CV_PROJECTS_DOMAIN}|g"

git -c user.email="cvportal@corpo-valley.com" -c user.name="cvportal" add -A
if git diff --cached --quiet; then
  echo "Template already up to date — nothing to push."
  exit 0
fi
git -c user.email="cvportal@corpo-valley.com" -c user.name="cvportal" \
  commit --quiet -m "sync from monorepo community-center/"
git push --quiet origin HEAD:main

echo "Pushed template updates to corpo-valley/community-center (main)."

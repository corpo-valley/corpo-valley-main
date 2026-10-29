# TypeScript/Node.js Application Dockerfile
# Built for: mcp-gateway (Corpo Valley per-project MCP OAuth reverse proxy)
# Build context: typescript/mcp-gateway/
#
# Multi-stage: a full node:slim builder compiles TypeScript, then a distroless
# runtime carries only the production node_modules + dist. The runtime image has
# no shell, no package manager, and runs as a non-root user.

# Pin the builder to an immutable patch tag. For supply-chain hardening, append
# a digest at build time (`node:24.22.1-slim@sha256:<digest>`) and bump
# intentionally rather than tracking the floating `node:24-slim` tag.
# 24.22.1 is the first Node 24 release with the Brotli decoder fix for
# CVE-2026-111497 (Node2Shell); do not go below it.
FROM node:24.22.1-slim AS builder

WORKDIR /app

ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# --ignore-scripts blocks dependency lifecycle scripts (a supply-chain execution
# vector); this project's deps are pure-JS and need none.
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime: distroless, non-root, no shell ───────────────────────────────────
# Pinned by digest, not by the floating `:nonroot` tag. The floating tag is
# whatever distroless last published, which is how the 2026-10-15 build shipped
# Node 24.14.0 (vulnerable to CVE-2026-111497, Node2Shell). This digest is the
# nodejs24-debian13:nonroot multi-arch index (linux/amd64 + linux/arm64) whose
# /nodejs/bin/node reports v24.22.2 (>= 24.22.1, the fixed release). To bump:
# resolve the tag's current index digest, extract /nodejs/bin/node from the
# amd64 layer and run `node --version`, then replace the digest below.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:a6c34457f6da4295807e051411c7783739c65b997a324fed14e4fa292615ae91

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

# The distroless nodejs image's entrypoint is `node`; CMD provides the script.
CMD ["dist/index.js"]

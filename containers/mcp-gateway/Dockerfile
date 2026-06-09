# TypeScript/Node.js Application Dockerfile
# Built for: mcp-gateway (Corpo Valley per-project MCP OAuth reverse proxy)
# Build context: typescript/mcp-gateway/
#
# Multi-stage: a full node:slim builder compiles TypeScript, then a distroless
# runtime carries only the production node_modules + dist. The runtime image has
# no shell, no package manager, and runs as a non-root user.

# Pin the builder to an immutable patch tag. For supply-chain hardening, append
# a digest at build time (`node:20.18.1-slim@sha256:<digest>`) and bump
# intentionally rather than tracking the floating `node:20-slim` tag.
FROM node:20.18.1-slim AS builder

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
FROM gcr.io/distroless/nodejs20-debian12:nonroot

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

# The distroless nodejs image's entrypoint is `node`; CMD provides the script.
CMD ["dist/index.js"]

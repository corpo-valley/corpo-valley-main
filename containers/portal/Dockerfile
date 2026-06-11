# TypeScript/Node.js Application Dockerfile
# Built for: portal (Corpo Valley self-service portal)
# Build context: repo root (containers/portal/context.txt) — the image carries
# both typescript/portal/ and community-center/, the project-template baseline
# the portal seeds into Gitea on first startup (services/template-seed.ts).
#
# Multi-stage: a full node:slim builder compiles TypeScript, then a distroless
# runtime carries only the production node_modules + dist. The runtime image has
# no shell, no package manager, and runs as a non-root user — shrinking the
# attack surface if the app is ever compromised.

# Pin the builder to an immutable patch tag. For supply-chain hardening, append
# a digest at build time (`node:20.18.1-slim@sha256:<digest>`) and bump
# intentionally rather than tracking the floating `node:20-slim` tag.
FROM node:20.18.1-slim AS builder

WORKDIR /app

# Optional: point npm at an internal registry/cache. Leave empty for upstream.
ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# Copy package files first for better caching. npm ci needs the lockfile.
# --ignore-scripts blocks dependency lifecycle scripts (a common supply-chain
# execution vector); this project's deps are pure-JS and need none.
COPY typescript/portal/package*.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript -> dist/, then drop devDependencies for the runtime copy.
COPY typescript/portal/ ./
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime: distroless, non-root, no shell ───────────────────────────────────
FROM gcr.io/distroless/nodejs20-debian12:nonroot

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Only the compiled output + pruned production deps land in the final image.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# The Community Center baseline: the factory-default project template the
# portal seeds into Gitea (and resets to on /admin/template/reset). Lives at
# /app/community-center — dist/services/template-seed.js resolves it two
# levels up from itself.
COPY community-center/ ./community-center/

EXPOSE 3000

# The distroless nodejs image's entrypoint is `node`; CMD provides the script.
CMD ["dist/index.js"]

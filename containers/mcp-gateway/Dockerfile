# TypeScript/Node.js Application Dockerfile
# Built for: mcp-gateway (Corpo Valley per-project MCP OAuth reverse proxy)
# Build context: typescript/mcp-gateway/

FROM node:20-slim

WORKDIR /app

ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

RUN groupadd -r app && useradd -r -g app app
RUN chown -R app:app /app
USER app

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]

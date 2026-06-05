# TypeScript/Node.js Application Dockerfile
# Built for: portal (Corpo Valley self-service portal)
# Build context: typescript/portal/

FROM node:20-slim

WORKDIR /app

# Optional: point npm at an internal registry/cache. Leave empty for upstream.
ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# Copy package files first for better caching. npm ci needs the lockfile.
COPY package*.json ./

# Install ALL dependencies (incl. dev) so we can run the TypeScript build.
RUN npm ci

# Copy application source
COPY . .

# Compile TypeScript -> dist/
RUN npm run build

# Drop devDependencies to slim the runtime image.
RUN npm prune --omit=dev

# Create non-root user and hand over the app dir
RUN groupadd -r app && useradd -r -g app app
RUN chown -R app:app /app
USER app

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]

# One image for the whole project. The image carries all capability modules
# (static-site/, database/, mcp/); the Kubernetes Deployment runs one
# container per capability you enabled, each starting a different module from
# this same image (e.g. `node database/server.js`). Building once and running
# the same image N ways keeps the build pipeline identical no matter which
# capabilities are on.
#
# Two-stage: install production deps in a builder, copy the slim node_modules
# into the runtime image so the npm cache never ships.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# node:alpine ships a non-root `node` user (uid 1000). Drop to it so any RCE
# in a capability process isn't running as root in the container.
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production
# Default command serves the website; the Deployment overrides `command` for
# the database and mcp containers.
CMD ["node", "static-site/server.js"]

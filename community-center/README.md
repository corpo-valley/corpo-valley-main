# 🌱 Community Center

This is the **template** every Corpo Valley project starts from. When you
create a project in the portal, you get your own copy of this repo — already
wired with a build pipeline, deploy manifests, and identity-gated access, so
you can focus on building, not the infra.

A project is composed from up to four **capability modules**. You pick them
with checkboxes when you create the project (and can change them later):

| Capability | Checkbox | Lives in | Served at |
|------------|----------|----------|-----------|
| **Website** | *a website for people to view content* (always on) | `static-site/` | `/` |
| **Database** | *data/views shared across users* enables sharing on top of it | `database/` | `/api` |
| **Storage** | *file storage for uploads* | `storage/` | `/files` |
| **MCP** | *users can connect to this project via MCP* | `mcp/` | `/mcp` |

The website is always present. Database, Storage, and MCP are optional.

## One language, one build

All modules are Node.js and share **one** `package.json`, **one**
`Dockerfile`, and **one** build. The build produces a single image that
carries every module; the Kubernetes Deployment runs one container per enabled
capability (`node static-site/server.js`, `node database/server.js`,
`node storage/server.js`, `node mcp/server.js`). The Ingress path-routes `/`,
`/api`, `/files`, and `/mcp` to the right container. Adding a capability doesn't
add a build — it adds a container from the image you already build.

## Authorization is built in

Every request is authenticated AND authorized at the platform edge before it
reaches a container: visitors without `read` access to this project never get
through, and allowed requests carry three trusted headers — `X-CV-User-Id`,
`X-CV-User-Email`, and `X-CV-Perm` (`read` / `write` / `admin`). Read them via
the shared `lib/identity.js` helper (`resolveUser` / `requirePerm`) and follow
the conventions in **[ACCESS.md](ACCESS.md)**: gate mutating routes with
`requirePerm('write')`, reserve `admin` for moderation. Data is scoped **per
user by default** — a caller only sees their own rows. Ticking "data is shared
across users" flips reads to a shared view (writes still record who made
them). The secure posture is the default; sharing is the explicit opt-in.

## What's in here

| Path | What it's for |
|------|---------------|
| `static-site/` | The website. Edit `static-site/public/`. |
| `database/` | Postgres-backed JSON API at `/api`. Replace the `items` example with your tables. |
| `storage/` | S3-compatible file API at `/files` (per-project Garage). Presigned upload/download; per-user isolation by default. |
| `mcp/` | MCP server at `/mcp`. Add your tools to the registry in `mcp/server.js`. |
| `package.json` / `Dockerfile` | Shared Node toolchain and the single image build. |
| `k8s/` | **Platform-generated** Deployment + Services + Ingress. Don't hand-edit. |
| `.gitea/workflows/` | **Pre-baked** build + security scans (semgrep, osv-scanner). |
| `AGENTS.md` | Guidance for any AI agent working in this project. |

## How it works

1. You (or your agent) edit a module and push to `main`.
2. A Gitea Action builds one container and pushes it to the Corpo Valley
   registry, then asks the portal to pin every container to the new tag.
3. ArgoCD rolls out the new image to `https://<project>.{{CV_PROJECTS_DOMAIN}}`.

## A note for coding agents

The build, deploy, and auth are already set up. **Don't write new CI workflows
or hand-edit `k8s/`.** To add or remove a capability, use the portal's
checkboxes or the `set_capabilities` Corpo Valley MCP tool — the platform
regenerates the manifests. Need a pattern? Call `get_template` or browse the
Community Center template repo. Platform details (cluster, auth, registry) are
abstracted away on purpose; you only need this repo.

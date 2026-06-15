# AGENTS.md — Corpo Valley project

You're working in a **Corpo Valley project**. Corpo Valley is the platform
hosting this repo, building it, deploying it, and gating it behind an
identity check. Your job is the application code; everything else is already
wired up.

## Capabilities

A project is built from up to four capability modules. Which ones are active
is decided by the project's settings in the portal and reflected by the
directories present here and the containers in `k8s/deployment.yaml`:

- **`static-site/`** — the website (always present). An Express server that
  serves `static-site/public/` at `/`. Replace the contents of `public/` with
  your site, or swap in a framework's build output.
- **`database/`** — a Postgres-backed JSON API mounted at `/api`. Present when
  the database capability is on. Per-user data isolation is the default.
- **`storage/`** — an S3-compatible file API mounted at `/files`, backed by a
  per-project Garage object store. Present when the storage capability is on.
  Per-user isolation is the default.
- **`mcp/`** — a Model Context Protocol endpoint at `/mcp` so agents can
  connect to this project. Present when the MCP capability is on.

All modules share **one** `package.json`, **one** `Dockerfile`, and **one**
build — the image carries every module, and the Deployment runs one container
per enabled capability (`node static-site/server.js`, `node database/server.js`,
`node storage/server.js`, `node mcp/server.js`). The Ingress path-routes `/`,
`/api`, `/files`, and `/mcp` to the right container.

## Identity & authorization — already enforced

Every request is authenticated at the platform edge before it reaches any
container: the Ingress gates on a valid Kratos session and bounces
unauthenticated visitors to login. The signed-in user's `ory_kratos_session`
cookie is forwarded through to the container, and the shared helper
`lib/identity.js` re-validates it against Kratos to get the caller's stable id.
A workload in this namespace can't forge an identity — that needs a real
session only the signed-in user holds.

- Resolve the caller with `resolveUser(req)` from `lib/identity.js` (returns
  `{ id, email }` or null). The `database`, `storage`, and `mcp` modules already do this.
- Scope user data by that id. Rows are owned by their creator and a caller only
  sees their own, unless the project's "data is shared across users" setting is
  on (surfaced as the `CV_SHARED` env var). **Per-user isolation is the secure
  default — don't remove the `owner_id` predicates without meaning to.**

## Adding or removing a capability

Use the portal's project settings (the capability checkboxes) or, if you're an
MCP-connected agent, the `set_capabilities` Corpo Valley tool. That regenerates
`k8s/deployment.yaml`, the Services, and the Ingress for you. **Don't hand-edit
the container list, Services, or Ingress** — they're platform-generated and
will be overwritten.

If a capability you want to model isn't enabled yet, read its canonical pattern
before inventing one: call the `get_template` Corpo Valley MCP tool (returns
the module's source from the Community Center template), or browse the
`corpo-valley/community-center` template repo in the platform's Gitea.

## Shipping flow

1. Edit a capability module and push to `main`.
2. The Build action builds **one** container, tags it with the build timestamp
   `YYYYMMDDHHMMSS` (immutable) + short SHA, pushes both to the in-cluster
   registry, and asks the portal to pin every container in
   `k8s/deployment.yaml` to that tag. The workflow holds no git credentials —
   that's why pin commits are attributed to `cvportal`.
3. ArgoCD syncs within a minute and the kubelet pulls the pinned image.
   Rollback is `git revert <bump-commit>`.

You don't manage registries, Kubernetes, DNS, or TLS.

## Platform-managed — don't rewrite

- `k8s/` — generated manifests (Deployment, Services, Ingress) already pointing
  at the right image, namespace, ingress host, and auth annotations. Add new
  manifests (a Job, a NetworkPolicy) here if you need to; don't rename or edit
  the generated three.
- `.gitea/workflows/` — `build.yaml` ships your container; `scan.yaml` runs
  semgrep + osv-scanner and blocks PR merges on findings. Don't write new
  workflows.

## Secrets

Don't commit plaintext secrets. The portal's "Sealed Secrets" section (or the
`set_project_secret` MCP tool) seals values in-cluster and commits
`k8s/secrets/<name>.sealed.yaml`. The materialised Secret lands in this
namespace; reference it via `envFrom` / `valueFrom.secretKeyRef`.

## Database

The database capability auto-provisions a one-replica Postgres in your
namespace and seals its credentials into a Secret named `postgres`. The
`database` container reads `DATABASE_URL` from it. Add tables in
`database/server.js`'s `ensureSchema()` (it runs on startup and is idempotent).

## Storage

The storage capability auto-provisions a one-replica Garage (S3-compatible)
object store in your namespace and seals its connection into a Secret named
`garage`. The `storage` container reads the `S3_*` keys from it and serves a
presigned-URL file API at `/files`. Use any S3 client against `S3_ENDPOINT`
(`http://garage:3900`, path-style, bucket `app`); objects are keyed under the
caller's `<userId>/` prefix by default (per-user isolation), or shared when the
project's "data is shared across users" setting is on. Don't read
`GARAGE_RPC_SECRET` / `GARAGE_ADMIN_TOKEN` from the Secret — those are the
daemon's, not the app's.

## Keeping CI green

`scan.yaml` runs semgrep (`--config=auto`) and osv-scanner. Use parameterized
SQL (the `database` module does), keep dependencies current, and if a scanner
flags an accepted false positive, suppress the single line with a justified
`// nosemgrep: <rule-id> -- <reason>` rather than disabling the workflow.

## See also

- `.claude/CLAUDE.md` — a one-line pointer back to this file for tooling that
  looks for `CLAUDE.md` specifically. Don't edit it.

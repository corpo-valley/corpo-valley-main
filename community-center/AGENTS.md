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

Every request is authenticated **and authorized** at the platform edge before it
reaches any container. The Ingress asks the portal whether the visitor may see
this project: anonymous visitors are bounced to login, and signed-in members
without `read` get a 403 — your code never sees either. Allowed requests arrive
carrying three **trusted** headers:

```
X-CV-User-Id     stable identity id of the caller — use as your owner_id
X-CV-User-Email  caller email
X-CV-Perm        read | write | admin
```

nginx overwrites these from the portal's auth answer on every request, so a
client-supplied copy never survives the edge (and network policy stops other
projects calling your Services directly). That edge overwrite — not anything in
your container — is what makes a forged identity impossible.

- Resolve the caller with `resolveUser(req)` from `lib/identity.js` — it returns
  `{ id, email, perm }` or `null`. The `database`, `storage`, and `mcp` modules
  already do this.
- **Gate every mutating route with `requirePerm('write')`** (also from
  `lib/identity.js`): it 401s unauthenticated callers, 403s anyone below the
  class, and sets `req.userId` / `req.userEmail` / `req.userPerm`. GETs are
  already covered by the platform's `read` floor. Reserve `admin` for moderation
  paths (acting on anyone's data); the project owner is always `admin`.
- Scope user data by `req.userId` (never trust an id from the request body).
  Rows are owned by their creator and a caller only sees their own, unless the
  project's "data is shared across users" setting is on (surfaced as the
  `CV_SHARED` env var, which widens *reads* only). **Per-user isolation is the
  secure default — don't remove the `owner_id` predicates without meaning to.**

The permission classes and grant model are the project's access standard — see
[`ACCESS.md`](ACCESS.md) for the full contract.

A Kratos session-cookie check exists only as a **local-dev fallback**:
`resolveUser` validates the forwarded `ory_kratos_session` against Kratos and
reports `write`, but **only** when `CV_DEV_COOKIE_FALLBACK` is set. In the
cluster it never runs — a deployed container that ever loses its edge headers
fails closed (deny) rather than granting `write` to any signed-in session.

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
namespace and seals its credentials into a Secret named `postgres`. **Every**
container in the pod gets `DATABASE_URL` from it (not just `database`), so your
`static-site`, `storage`, or `mcp` code can reach Postgres too — e.g. the
storage server recording a download into the DB. Add tables in
`database/server.js`'s `ensureSchema()` (it runs on startup and is idempotent).

## Storage

The storage capability auto-provisions a one-replica Garage (S3-compatible)
object store in your namespace and seals its connection into a Secret named
`garage`. Every container in the pod gets the six `S3_*` keys from it (not just
`storage`), and the `storage` container serves a file API at `/files`. Use any
S3 client against `S3_ENDPOINT`
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
{{CV_COOLDEPS_NOTE}}
## See also

- `.claude/CLAUDE.md` — a one-line pointer back to this file for tooling that
  looks for `CLAUDE.md` specifically. Don't edit it.

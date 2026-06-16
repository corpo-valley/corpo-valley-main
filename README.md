# Corpo Valley

A **self-hosted, single-organization "vibe-coding" platform**. An admin stands
it up and provisions identities; after that, members self-serve: each person can
spin up a **project** — a Git repo, an auto-deployed website, and the wiring to
build it with Claude Code — without filing a ticket or touching Kubernetes.
Everything is private and access-gated by default.

This repo (`corpo-valley-main`) holds the **platform application source** and
builds it into container images. How to *deploy* it lives in
[`corpo-valley-chart`](https://github.com/corpo-valley/corpo-valley-chart); a
deployment repo like `corpo-valley-hetzner` holds the per-cluster values. See
[Repo split](#repo-split). The sections below describe what the platform does
and how to tune it; deeper specs are linked under [Documentation](#documentation).

## The model

1. An **admin** installs the chart and creates the first accounts (or turns on
   Google Workspace login so members self-register).
2. A **member** opens the portal and creates a project. The platform provisions
   a private Gitea repo from a template, a sealed Kubernetes namespace, an
   auto-deploying site at `<slug>.<projects-domain>`, and (optionally) a database,
   file storage, and an MCP endpoint.
3. The member points **Claude Code** at the project over MCP (or clones the
   repo) and builds. On every push, CI builds and scans the image and the new
   version rolls out automatically.
4. The member **shares** the project with teammates at read/write/admin, or with
   a group — access is enforced at the edge before a request ever reaches their
   app.

## Features

### Projects & capabilities

Every project is a private Gitea repo plus an auto-deployed website at
`<slug>.<projects-domain>`. New repos are generated from the Community Center
template (`community-center/`), so a project ships with a working build
pipeline, a starter site, and Claude config from the first commit. Three
capabilities are opt-in per project:

| Capability | What it adds |
|---|---|
| **website** | Always on — the deployed site. |
| **database** | A per-project Postgres, password sealed at rest; the app gets a ready connection. |
| **storage** | A per-project S3-compatible object store (Garage), credentials sealed at rest; an `/files` API and a ready S3 client connection. |
| **mcp** | An `/mcp` endpoint so agents can use the project itself as a tool. |

A `CV_SHARED` switch flips a capability between per-user isolation (the default —
each member sees only their own data) and a single shared view.

**The deploy loop:** push to `main` → Gitea Actions builds the image, runs
security scans (semgrep + osv-scanner), and pushes to the in-cluster registry →
the workflow calls the portal, which pins `k8s/deployment.yaml` to the new
immutable tag → the projects ArgoCD syncs it into the project's sealed
namespace. Branch protection gates outside contributors behind scanned PRs.

### Access control

A project is **private by default** — only the owner (and their bot) can reach
it. Access is per-area — **Project** (the deployed site) and **Repo** (the Gitea
repository) — and widened purely by explicit grants. The highest applicable
grant wins, and the owner is always `admin`:

- **per-user** and **per-group grants** (`read` / `write` / `admin`); groups are
  member-created and self-serve,
- an **`everyone` grant** — the virtual org-wide subject covering every
  signed-in member, for org-wide `read` or `write` (never `admin`).

Both areas support all three levels (repo levels map onto Gitea collaborator
permissions). Owners manage this on the project page: a **Project Access**
section, then a **Repo Access** section, each with Read / Write / Admin rows.

The deployed site is gated **at the edge**: ingress asks the portal whether a
visitor may see the project, anonymous visitors bounce to login, and members
below `read` get a 403 before any project code runs. Allowed requests arrive
carrying three trusted headers — `X-CV-User-Id`, `X-CV-User-Email`, `X-CV-Perm`
— so an app needs zero auth code to be fully protected (the **X-CV-Perm
standard**, see [`community-center/ACCESS.md`](community-center/ACCESS.md)).
Project repos are always private; member repo access is granted as Gitea
collaborators, never by making a repo public.

### Identity & login

Identity is **Ory Kratos**. By default there is no public sign-up — admins
create accounts. Turn on **Google Workspace login** (`auth.google.enabled`) and
anyone from an allowed Workspace domain can sign in and is auto-provisioned as a
member; the domain restriction is enforced inside Kratos, so it can't be
bypassed. Each human gets a paired `.bot` identity and Gitea account for
automation. Password/code sign-in stays available as a break-glass path.

### Drive it from your editor (MCP)

Corpo Valley speaks the Model Context Protocol on two surfaces:

- **Platform MCP** (`mcp.<domain>`): connect Claude Code once and create
  projects, mint Gitea clone credentials, seal secrets, and read the docs — all
  from chat. OAuth 2.1 with PKCE; tokens are issued by Ory Hydra.
- **Per-project MCP** (`<slug>.<projects-domain>/mcp`): exposes a project as a
  tool. Access **mirrors the site gate** — anyone with `read` may connect, and
  the project's MCP server gates individual tools on the forwarded `X-CV-Perm`
  (read vs write vs admin), exactly like the website standard.

### Admin

A scoped admin UI manages members (create, delete, set/clear the admin role,
issue recovery codes), gates first-party OAuth **services** to admins-only or
all members, and resets the project template. Deleting a user cascades cleanly:
their projects, groups, grants, API keys, bot identity, and Gitea accounts are
all torn down.

### Secure by default

Each project lands in a **sealed namespace** (Pod Security Admission, a
default-deny egress NetworkPolicy, resource quotas) before any tenant workload
exists. Project secrets are sealed at rest, the projects ArgoCD is fenced by
admission policies (it can only deploy into a project's own namespace, never a
platform one), and per-project egress is locked down. See the chart for the full
posture.

## How it fits together

```
                 ┌─────────── Ory ───────────┐
  Browser /      │ Kratos  Hydra  Keto        │
  Claude Code ──▶│ (identity)(OAuth)(roles)   │
                 │ Oathkeeper (edge gateway)  │
                 └────────────┬───────────────┘
                              │
        ┌─────────── Portal (this repo) ───────────┐
        │ self-service + admin UI, access engine,  │
        │ platform MCP, project provisioning       │
        └───┬───────────────┬──────────────┬───────┘
            │               │              │
        Gitea           per-project     projects
     (repos + CI)        namespaces      ArgoCD
                    (site/db/files/mcp) (auto-deploy)
            ▲               ▲
            └─ MCP gateway ─┘  (per-project /mcp OAuth reverse proxy)
```

The **portal** (`typescript/portal/`) is the brain: it renders the UI, runs the
access engine, hosts platform MCP, and provisions every project resource. The
**MCP gateway** (`typescript/mcp-gateway/`) is a small OAuth reverse proxy that
fronts each project's `/mcp`. Identity and authorization come from the **Ory**
stack; repos and CI from **Gitea**; deployment from a dedicated, namespace-scoped
**projects ArgoCD**.

## Tuning

Most behavior is tuned through chart values — see
[`corpo-valley-chart/values.yaml`](https://github.com/corpo-valley/corpo-valley-chart/blob/main/values.yaml)
and `values.schema.json` for the full, validated surface. The headline knobs:

| Value | Controls |
|---|---|
| `domain`, `hosts.*` | The deployment's domain and per-service hostnames. |
| `auth.google.enabled` / `auth.google.allowedDomains` | Google Workspace login and which domains may join. |
| `mcp.enforceAudience` | RFC 8707 audience enforcement on MCP tokens. |
| `mcp.denyClientIds` | OAuth clients whose tokens the MCP endpoints refuse (confused-deputy guard). |
| `storage.className` | StorageClass for per-project Postgres and Garage (storage) volumes. |
| `tenant.memory.*`, `tenant.cpu.*`, `tenant.storage.*`, `tenant.pods.max`, `tenant.pvcs.max` | Per-project resource budgets — the ResourceQuota + LimitRange stamped on each project namespace. `storage.maxPerVolume` is the per-PVC cap; `storage.maxTotal` the namespace sum. |
| `tenant.capabilities.{postgres,garage}.image` | Pinned images for the per-project Postgres/Garage capabilities (each also pins its admission VAP). |
| `scale.*`, `resources.*` | Replicas and limits for the platform components. |
| `role` | Split a deployment into `platform` / `tenants` planes, or `all-in-one`. |

New-project defaults (private site + private repo) and per-project access are
set by members in the portal, not by the operator. A handful of image-level env
vars (e.g. `REPO_RECONCILE_INTERVAL_MS`) are documented inline in the source.

## Repo split

| Repo | Owns |
|---|---|
| [`corpo-valley-main`](https://github.com/corpo-valley/corpo-valley-main) (this) | platform app source, Dockerfiles, image build pipeline |
| [`corpo-valley-chart`](https://github.com/corpo-valley/corpo-valley-chart) | Helm chart — *how* to deploy |
| `corpo-valley-hetzner` | per-cluster values, Terraform, bootstrap — *where* to deploy |

This repo builds and publishes images; it contains no deployment manifests. A
change under `typescript/portal/` triggers a new image — roll it out by bumping
`image.tags.portal` in the deployment repo and letting ArgoCD / `helm upgrade`
reconcile.

## Building images

Images publish to GHCR under the public `corpo-valley` namespace:

```
ghcr.io/corpo-valley/corpo-valley-portal:<tag>
ghcr.io/corpo-valley/corpo-valley-mcp-gateway:<tag>
```

Tags per build: `latest` (on `main` pushes only) and `YYYYMMDD-<short-sha>`
(immutable — pin to this in production). Platforms default to
`linux/amd64,linux/arm64`. A push to `main` builds the changed apps
automatically (`build-images.yaml`); the **Build Branch Images** workflow builds
every app from any ref for previewing a branch.

Add an app, or build locally:

```bash
make new-app APP_NAME=foo LANG=typescript PORT=3000   # scaffold + Dockerfile
make build push APP_NAME=portal TAG=dev               # local single-image build
```

`make new-app` creates `typescript/foo/` + `containers/foo/Dockerfile`; the next
push to `main` builds it. GHCR packages publish private by default — mark each
`corpo-valley-*` package public once under the org's package settings.

### Why a separate repo

Image source can be public without exposing the chart's deployment shape; image
tags advance per-commit while chart and deployment repos pin to known-good tags;
and a new deployment shape consumes the same images without forking the build.

## Documentation

- [`community-center/ACCESS.md`](community-center/ACCESS.md) — the X-CV-Perm
  standard project developers build against.
- [`community-center/AGENTS.md`](community-center/AGENTS.md) — guidance for
  agents working inside a project.
- [`docs/decisions/`](docs/decisions/) — design decisions (access groups,
  Google login, and the rationale behind them).
- [`corpo-valley-chart`](https://github.com/corpo-valley/corpo-valley-chart) —
  deployment, the full values surface, and the security posture.

## License

MIT — see [LICENSE](LICENSE).

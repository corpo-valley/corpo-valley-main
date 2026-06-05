# corpo-valley-main

Source repo for the **Corpo Valley platform images** — the in-cluster portal
(self-service + admin UI), the MCP gateway, and anything else that gets
packaged as a container the chart references.

This repo's job is narrow: hold the application source, build it on push to
`main`, and publish multi-arch images to GHCR under the public
`corpo-valley` namespace. It contains no deployment manifests and no
deployment automation — those live in `corpo-valley-chart`
(templates) and a deployment repo like `corpo-valley-hetzner` (where + with
what values).

## Where images go

```
ghcr.io/corpo-valley/corpo-valley-portal:<tag>
ghcr.io/corpo-valley/corpo-valley-mcp-gateway:<tag>
ghcr.io/corpo-valley/corpo-valley-<new-app>:<tag>
```

Tags emitted per build:

- `latest` (on `main` pushes only)
- `YYYYMMDD-<short-sha>` — immutable, what you should pin to in production

Platforms: `linux/amd64,linux/arm64` by default; override per app via
`containers/<app>/platforms.txt`.

## Repo split

| Repo | Owns |
|---|---|
| [`corpo-valley-main`](https://github.com/corpo-valley/corpo-valley-main) (this) | app source, Dockerfiles, image build workflow |
| [`corpo-valley-chart`](https://github.com/hashtagcyber/corpo-valley-chart) | Helm chart — how to deploy |
| [`corpo-valley-hetzner`](https://github.com/hashtagcyber/corpo-valley-hetzner) | per-cluster values, Terraform, bootstrap — where to deploy |

A change to `typescript/portal/` here triggers a new image. To roll that
image out, bump `image.tags.portal` in the consuming deployment repo's
`clusters/<cluster>/values.yaml` to the new immutable tag and let ArgoCD or
`helm upgrade` reconcile.

## Layout

```
.github/workflows/build-images.yaml   # the publish pipeline
containers/                            # one dir per image
  README.md
  portal/        Dockerfile + .dockerignore
  mcp-gateway/   Dockerfile
typescript/                            # source per image
  portal/        Express + Ory + portal UI
  mcp-gateway/   per-project MCP OAuth reverse proxy
scripts/
  new-app.sh                           # scaffold a new image-built app
Makefile                               # local build/push convenience
```

Build context resolution (handled by `build-images.yaml`):

1. If `containers/<app>/context.txt` exists, use its contents as the context.
2. Else if `typescript/<app>/` exists, use that.
3. Else `python/<app>/`, `static/<app>/`, `frontend/<app>/`.

Override the platform list per app with `containers/<app>/platforms.txt`
(one platform per line).

## Adding a new image

```bash
make new-app APP_NAME=foo LANG=typescript PORT=3000
# -> creates typescript/foo/ + containers/foo/Dockerfile
# -> committing to main triggers the workflow build
```

## Making packages public

GHCR packages publish **private by default** to your user/org namespace.
Once the first build lands, mark each package public:

1. Go to <https://github.com/orgs/corpo-valley/packages>.
2. Click each `corpo-valley-*` package → Package settings → Change
   visibility → Public.

You only need to do this once per package. Subsequent pushes inherit the
visibility.

Optionally link each package to this repo (same settings page) so the
GitHub UI shows the source code + release history.

## Local build

```bash
# Build + push a single image:
make build push APP_NAME=portal TAG=dev

# Default platform is your host's; for multi-arch use Buildx directly:
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/corpo-valley/corpo-valley-portal:dev \
  -f containers/portal/Dockerfile typescript/portal/ \
  --push
```

## Why a separate repo

A few specific reasons over keeping this in a monorepo:

- **Public visibility.** Image source can live in a public repo without
  exposing the chart's deployment shape (RBAC scopes, project lists, etc.).
- **Independent versioning.** Image tags advance per-commit; chart and
  deployment repos pin to known-good tags. No git-pin loop polluting commit
  history.
- **Smaller surface.** This repo is just app source + build pipeline — easy
  to reason about, fast CI, no manifests to keep in sync.
- **Cross-deployment.** A new deployment shape (e.g. ZTNA-fronted, on-prem)
  doesn't need to fork the image build; it consumes the same images.

## License

MIT — see [LICENSE](LICENSE).

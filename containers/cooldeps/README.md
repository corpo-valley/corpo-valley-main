# cooldeps

A self-hosted package-manager proxy that **gates dependency installs on release
age, license, and known CVEs** — before the bytes land. It speaks the native
npm, PyPI, and Go-module protocols, sits in the install data path, evaluates
each requested version against a declarative policy, and blocks or passes it.

The headline defense is the **cooldown window**: brand-new releases (the prime
vector for a compromised-maintainer supply-chain attack) are held back until
they've survived `minDays` in the wild.

## Two ways to use it

There are exactly two use cases, and they are independent — read the one you need:

| | **Config only** | **Proxy mode** |
|---|---|---|
| **You want to…** | point *your* machine / CI at a cooldeps proxy that *someone else is already running* | *run* the proxy instance that other machines point at |
| **You run** | `bootstrap.sh` (or set a few config files / env vars) | the `cooldeps` binary or Docker image |
| **You need** | the URL of a running cooldeps instance | a host/container to run it on |
| **Jump to** | [Config only](#use-case-1-config-only) | [Proxy mode](#use-case-2-proxy-mode) |

> A typical deployment is one team running **proxy mode** once, and everyone
> else (plus all CI) using **config only** to point at it.

---

## Use case 1: config only

You have the URL of a running cooldeps instance and you want this machine (or a
CI runner) to install dependencies *through* it, so they get gated.

### The easy way — `bootstrap.sh`

```sh
# point everything at your cooldeps instance
COOLDEPS_HOST=https://cooldeps.example.com ./bootstrap.sh

./bootstrap.sh --revert        # undo everything
```

`bootstrap.sh` detects what's installed and configures it (macOS + Linux,
idempotent, backs up anything it touches). It also drops a managed env-var block
into your **bash and zsh** profiles (`~/.bashrc`, `~/.zshrc`, and
`~/.bash_profile`/`~/.zshenv` if present) as a catch-all for CI and env-only
tools.

| Ecosystem | Configured | How |
|-----------|-----------|-----|
| **JS** | npm, pnpm, yarn classic | `registry=` in `~/.npmrc` (recent bun/deno read it too) |
| | yarn Berry (v2+) | `npmRegistryServer` in `~/.yarnrc.yml` |
| **Python** | pip, pipenv | `index-url` in `pip.conf` |
| | pdm | `pdm config pypi.url` |
| | uv | `UV_INDEX_URL` (env block) |
| | poetry | per-project — script prints the `poetry source add` command |
| **Go** | the whole `go` toolchain | `go env -w GOPROXY=…,direct` |
| **env (CI/catch-all)** | bash + zsh | `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `UV_INDEX_URL`, `GOPROXY` |

### The manual way

If you'd rather not run the script (or you're in a container image build),
configure each manager directly. Replace the host with your instance's URL:

```ini
# ~/.npmrc
registry=https://cooldeps.example.com/npm/

# pip.conf  (~/.config/pip/pip.conf | ~/Library/Application Support/pip/pip.conf)
[global]
index-url = https://cooldeps.example.com/pypi/simple
```

```sh
# go (keep ,direct so private modules + the checksum DB still work)
go env -w GOPROXY=https://cooldeps.example.com/go,direct
```

Or, for CI / env-only tools, just export:

```sh
export NPM_CONFIG_REGISTRY=https://cooldeps.example.com/npm/
export PIP_INDEX_URL=https://cooldeps.example.com/pypi/simple
export UV_INDEX_URL=https://cooldeps.example.com/pypi/simple
export GOPROXY=https://cooldeps.example.com/go,direct
```

A blocked install fails with a readable reason (HTTP 403 body for npm; the
version simply isn't offered for pip). Verify you're going through the proxy via
the `X-Cooldeps-Cache` response header (or the `/status` endpoint, if the
operator has enabled it).

---

## Use case 2: proxy mode

You want to **run** a cooldeps instance that other machines / CI will point at.
The server is a single static binary with no external dependencies (it stores
its cache on local disk).

### Docker

```sh
docker run -d --name cooldeps \
  -p 8080:8080 \
  -v cooldeps-data:/data \
  -v "$PWD/cooldeps.yaml:/etc/cooldeps/cooldeps.yaml:ro" \
  -e COOLDEPS_CONFIG=/etc/cooldeps/cooldeps.yaml \
  ghcr.io/hashtagcyber/cooldeps:latest
```

Images are published to `ghcr.io/hashtagcyber/cooldeps` (multi-arch
amd64+arm64). Omit the config mount to run on built-in defaults. See
[`cooldeps.example.yaml`](cooldeps.example.yaml) for a fully-commented config.

### Binary

```sh
# download a release artifact from the GitHub Releases page, or build it:
CGO_ENABLED=0 go build -o cooldeps ./cmd/cooldeps

COOLDEPS_CONFIG=./cooldeps.yaml ./cooldeps
```

Now point clients at `http://<this-host>:8080` using **use case 1** above.

### How gating works per ecosystem

- **npm** — packuments pass through (resolution works), but every
  `dist.tarball` URL is rewritten back through this proxy, so the tarball fetch
  (the unambiguous "install this version" signal) is gated. A blocked version
  returns **403** with a JSON body listing the reasons. Allowed tarballs are
  streamed and cached (immutable, LRU-capped).
- **PyPI** — the Simple listing (PEP 691 JSON) is **filtered**: files for
  blocked versions are removed before pip's resolver sees them, so it naturally
  selects an allowed version or fails cleanly. Downloads pass through.
- **Go** — the GOPROXY resolution traffic (`/@v/list`, `.info`, `.mod`,
  `/@latest`, `/sumdb/…`) passes through, but the module **`.zip`** (the install
  artifact) is gated: blocked → 403 with a readable reason, allowed → streamed
  and cached. Zip bytes are unmodified so GOSUMDB checksums still verify.
  Untagged **pseudo-versions** get their cooldown date from the timestamp
  embedded in the version string when deps.dev has no record.

### What it checks

| Check | Source | Effect |
|-------|--------|--------|
| **Cooldown** — reject versions younger than `minDays` | deps.dev publish date | block (the headline supply-chain defense) |
| **License** — allow/block lists, SPDX-expression aware | deps.dev licenses | block off-list, warn on unknown |
| **CVE** — block when a vuln ≥ `maxSeverity` is present | OSV.dev + CVSS scoring | block (unscored vulns fail-safe) |
| **Overrides** — pin an exact `pkg@version` to allow/block | `policy.overrides` | bypass/force the gate |

The **policy.overrides.allow** list is the escape hatch for *"a critical fix
shipped today, let it through the cooldown window"* — e.g. `npm:laps@1.0.1`.

### Configuration

All configuration lives in **one YAML file** with three sections — `server`,
`cache`, and `policy` — pointed at by the `COOLDEPS_CONFIG` env var. Every key is
optional and falls back to a built-in default;
[`cooldeps.example.yaml`](cooldeps.example.yaml) documents the whole thing.

```yaml
server:
  addr: ":8080"
  statusEnabled: false          # /status is 404 unless true
cache:
  vulnTTL: 6h                   # re-query OSV after this
  metaTTL: 0                    # re-fetch found metadata after this; 0 = forever
  metaNotFoundRefresh: 30m      # re-check a not-yet-known version after this
  artifactMaxBytes: 40GiB
policy:
  license:    { allow: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC], block: [GPL-3.0, AGPL-3.0], warnOnUnknown: true }
  releaseAge: { minDays: 14, warnOnly: false, blockOnUnknown: false }
  cve:        { maxSeverity: HIGH, warnOnly: false, fetchSeverity: true }
  failOpen:   false             # if deps.dev/OSV are unreachable, BLOCK
  overrides:
    allow: ["npm:laps@1.0.1"]   # let a fresh critical fix through
    block: []                   # incident response: kill a known-bad release
```

**Env overrides.** Any scalar field can be overridden by an environment variable
named **`COOLDEPS_<SECTION>_<FIELD>`** (uppercased), so deployments don't have to
template the file. Precedence is **defaults < file < env**. Examples:

```sh
COOLDEPS_SERVER_ADDR=:9000
COOLDEPS_CACHE_METATTL=720h
COOLDEPS_POLICY_CVE_MAXSEVERITY=CRITICAL
COOLDEPS_POLICY_FAILOPEN=true
```

List fields (`policy.license.allow/block`, `policy.overrides.*`) are file-only.

**Decision ladder:** `allow < warn < block`; checks only escalate and all reasons
accumulate. Overrides are evaluated first (block beats allow).

Config is validated at startup: a malformed value (`COOLDEPS_CACHE_VULNTTL=6hours`)
or a semantically-invalid one (a non-`http(s)` upstream, a bad `addr`,
`fetchConcurrency < 1`, an unknown YAML key) makes the process **log every problem
and exit non-zero** rather than silently using a default.

> **Porting to another language?** [`docs/config-schema.md`](docs/config-schema.md)
> is the normative, language-agnostic spec (sections, value grammars, the env
> override convention, validation, decision & freshness semantics, a conformance
> checklist, and a JSON Schema) so another implementation can be bit-for-bit
> compatible.

### Caching (three tiers)

- **Metadata** (release date, license) — kept forever by default (a published
  version's release date never changes; the cooldown verdict is recomputed each
  request from `now`, so a version "ages in" with no re-fetch). A version
  deps.dev doesn't know yet is re-checked every `cache.metaNotFoundRefresh`; set
  `cache.metaTTL` to also refresh found rows for license drift.
- **Vuln results** — `cache.vulnTTL` (default `~6h`) so new CVEs are picked up.
- **Artifacts** — on disk, sharded by URL hash, **LRU-capped** (evicts at 80% → 70%).

First-request-pays: once a version is evaluated, every later client gets the
cached verdict + bytes for free. Verify a cache hit via the `X-Cooldeps-Cache`
response header (or `/status`, when enabled).

### Endpoints

- `/npm/…`  — npm registry gate
- `/pypi/…` — PyPI Simple gate
- `/go/…`   — Go module (GOPROXY) gate
- `/healthz` — liveness
- `/status` — JSON request counters per backend + build version. **Disabled by
  default** (404); set `server.statusEnabled: true` (or
  `COOLDEPS_SERVER_STATUSENABLED=true`) to expose it. `GET`/`HEAD`/`OPTIONS` only.

---

## Build & test

```sh
go test ./...                                   # unit + httptest integration
CGO_ENABLED=0 go build ./cmd/cooldeps           # static binary
```

CI runs all tests with a coverage gate on every PR (see
`.github/workflows/pr-check.yml`). Release artifacts (the Docker image and the
`cooldeps` binary) are built by the manually-triggered
`.github/workflows/release.yml` workflow.

## Dependency hygiene (we eat our own dog food)

A tool that polices *other* projects' dependencies has no business shipping a
sprawling, vulnerable tree of its own. So:

- **Tiny runtime tree.** The only third-party code compiled into the binary is
  `go.etcd.io/bbolt` (embedded KV store) and `gopkg.in/yaml.v3` (+ `golang.org/x/sys`
  via bbolt). bbolt was chosen over an embedded SQLite specifically to avoid the
  ~20-module C-transpiler dependency tree the pure-Go SQLite drivers pull in.
- **`govulncheck` clean.** `govulncheck ./...` reports **no vulnerabilities** in
  our code or imported packages, built with a current Go toolchain (the Dockerfile
  pins `golang:1.26-bookworm` so the produced binary carries patched std-library
  crypto/net packages). Re-run it in CI before merging dependency bumps.
- **No CGO.** `CGO_ENABLED=0` → a static binary on distroless/static, trivially
  reproducible and cross-compiled to arm64.

## Known limitations (MVP)

- **No auth** — the edge is open. It serves only public packages minus what
  policy blocks, but an open instance leaks *what your policy blocks*. Acceptable
  for a homelab MVP; close before any org-wide rollout.
- **License expressions** are handled with a simplified SPDX evaluator (OR/AND +
  parens), not a full parser.
- **CVSS** scoring covers v3.0/3.1 base vectors; v2-only advisories fall back to
  the textual GHSA band, or Unknown (which fails safe to block).
- **PyPI** filtering requires the JSON Simple API (modern pip); an HTML-only
  response is passed through unfiltered with a logged warning.

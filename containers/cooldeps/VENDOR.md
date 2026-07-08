# Vendored: cooldeps

This directory vendors the [cooldeps](https://github.com/hashtagcyber/cooldeps)
package-manager gating proxy (npm / PyPI / Go) so the Corpo Valley build
pipeline publishes it as a first-class platform image
(`ghcr.io/corpo-valley/corpo-valley-cooldeps`) alongside every other CV service,
using the org's GHCR namespace and pull-secret conventions.

The full Go source is copied here verbatim (the build context is self-contained:
`containers/cooldeps/Dockerfile` builds `./cmd/cooldeps`). `context.txt` points
the `build-images` workflow at this directory, and the `containers/**` path
trigger rebuilds the image on any change here.

## Provenance

- Upstream: https://github.com/hashtagcyber/cooldeps
- Module: `github.com/hashtagcyber/cooldeps`

## Re-syncing from upstream

Copy the upstream tree over this directory, excluding VCS, the prebuilt binary,
the end-user `bootstrap.sh`, and upstream CI (which don't belong in the vendored
image build):

```sh
tar --exclude='.git' --exclude='./cooldeps' --exclude='bootstrap.sh' \
    --exclude='.github' -C <upstream-checkout> -cf - . \
  | tar -xf - -C containers/cooldeps
```

Then keep `context.txt` and this `VENDOR.md` (both CV-specific, not from
upstream).

## Configuration

The image bakes `:8080` + `/data` defaults and a reference config at
`/etc/cooldeps/cooldeps.example.yaml`. The chart mounts a real config and points
`COOLDEPS_CONFIG` at it; any field is overridable via `COOLDEPS_<SECTION>_<FIELD>`
env vars. See `cooldeps.example.yaml` / `docs/config-schema.md` here for the full
schema.

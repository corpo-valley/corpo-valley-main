# Garage object-store Dockerfile
# Built for: garage (Corpo Valley per-project S3-compatible blob storage)
# Build context: containers/garage/ (containers/garage/context.txt) — the
# entrypoint script and baked config live next to this Dockerfile.
#
# Self-bootstrapping: on startup the entrypoint brings up a single-node Garage
# and idempotently initializes it (cluster layout + bucket + imported access
# key) so it serves the S3 API with no external orchestration.
#
# Multi-stage: we pull the statically-linked `garage` binary from the official
# upstream image, then assemble a small Alpine runtime that — unlike the
# scratch-based upstream image — has a POSIX shell + wget so the entrypoint can
# poll readiness and run the admin CLI.

# Pin the upstream tag (immutable). Bump intentionally; for extra hardening
# append a digest (dxflrs/garage:v1.0.1@sha256:<digest>).
FROM dxflrs/garage:v1.0.1 AS upstream

# ── Runtime: small Alpine base with a shell + wget for the entrypoint ──────────
FROM alpine:3.20

# wget ships in alpine's busybox; ca-certificates for any TLS the admin CLI may
# do. tini gives us a proper init for clean signal handling / reaping.
RUN apk add --no-cache ca-certificates tini

# The static garage binary from upstream (works on any glibc/musl host).
COPY --from=upstream /garage /usr/local/bin/garage

# Baked non-secret config + the bootstrap entrypoint.
COPY garage.toml /etc/garage.toml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Non-root user (uid/gid 1000). All writable state lives under /data (the
# mounted PVC); create it and hand ownership to the runtime user so the
# container works under a read-only rootfs + dropped capabilities.
RUN addgroup -g 1000 garage \
    && adduser -D -u 1000 -G garage garage \
    && mkdir -p /data \
    && chown -R 1000:1000 /data

ENV GARAGE_CONFIG_FILE=/etc/garage.toml
ENV S3_BUCKET=app

USER 1000:1000

# 3900 = S3 API, 3903 = admin API.
EXPOSE 3900 3903

# tini as PID 1 forwards signals to the entrypoint/garage and reaps zombies.
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]

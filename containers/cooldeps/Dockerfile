# cooldeps — multi-stage Go build for the package-manager gating proxy.

# Pinned to a current Go minor so the produced binary ships patched std-library
# crypto/net packages (govulncheck-clean). Floats to the latest 1.26 patch.
FROM golang:1.26-bookworm AS build
WORKDIR /src

# Cache deps first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=dev
# CGO off → fully static binary (pure-Go deps), so it runs on
# distroless/static and cross-compiles to arm64 cleanly.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/cooldeps ./cmd/cooldeps

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/cooldeps /usr/local/bin/cooldeps
# A reference config is baked in for documentation; a deployment mounts its own
# file and points COOLDEPS_CONFIG at it (env vars can override any field).
COPY cooldeps.example.yaml /etc/cooldeps/cooldeps.example.yaml

# Defaults (:8080, /data) are baked into the binary; these mirror them
# explicitly using the COOLDEPS_<SECTION>_<FIELD> override convention.
ENV COOLDEPS_CACHE_DATADIR=/data \
    COOLDEPS_SERVER_ADDR=:8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/cooldeps"]

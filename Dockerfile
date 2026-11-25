# syntax=docker/dockerfile:1
# Build: docker build -t undertree .   (pin TeX Live: --build-arg TEXLIVE_IMAGE=texlive/texlive:TL2025-historic)

ARG TEXLIVE_IMAGE=texlive/texlive:latest

FROM rust:1-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations migrations
COPY src src
RUN cargo build --release --locked

FROM node:20-bookworm-slim AS web
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

# Full TeX Live (all packages, pdfLaTeX/XeLaTeX/LuaLaTeX, biber), like Overleaf; ~5 GB.
# Debian based with a newer glibc than the bookworm build stage, so the binary runs as is.
FROM ${TEXLIVE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps \
 && rm -rf /var/lib/apt/lists/* \
 && (getent passwd 1000 >/dev/null && userdel -r "$(getent passwd 1000 | cut -d: -f1)" || true) \
 && useradd --uid 1000 --create-home undertree \
 && mkdir -p /data \
 && chown undertree:undertree /data \
 # LuaLaTeX font database, read-only at runtime (compiles run with a per-build TEXMFVAR)
 && TEXMFVAR="$(kpsewhich -var-value TEXMFSYSVAR)" luaotfload-tool --update --force -q \
 && latexmk -v | head -1
COPY --from=rust /src/target/release/undertree /usr/local/bin/undertree
COPY --from=web /src/dist /app/static
ENV UNDERTREE_BIND=0.0.0.0:3000 \
    UNDERTREE_DATA=/data \
    UNDERTREE_STATIC_DIR=/app/static
USER undertree
WORKDIR /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["undertree", "serve"]

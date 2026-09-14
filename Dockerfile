# syntax=docker/dockerfile:1

# Stage 1: Build frontend
FROM node:25 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust binary
FROM rust:trixie AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libopus-dev cmake curl ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    archive=/tmp/kache.tar.gz; \
    curl --fail --location --silent --show-error \
        "https://github.com/kunobi-ninja/kache/releases/download/v0.20.0/kache-x86_64-unknown-linux-musl.tar.gz" \
        --output "${archive}"; \
    echo "fe5ce52406e0dcb8c9a49798671a073440cae13a88731b1b712b7c0fa372b85b *${archive}" | sha256sum --check --strict; \
    tar --extract --gzip --file "${archive}" --directory /usr/local/bin kache; \
    chmod 0755 /usr/local/bin/kache; \
    rm "${archive}"; \
    kache install-shims --force /opt/kache/shims; \
    kache --version

ARG KACHE_CACHE_ID=azuki-kache-linux-amd64-v1-kache-0.20.0
ARG CARGO_TARGET_CACHE_ID=azuki-target-linux-amd64-v1
ARG KACHE_MAX_SIZE=3GiB
ARG KACHE_PROGRESS
ARG KACHE_LOG

WORKDIR /app
ENV SQLX_OFFLINE=true \
    RUSTC_WRAPPER=/usr/local/bin/kache \
    KACHE_CONFIG=/app/.kache.toml \
    KACHE_CACHE_DIR=/var/cache/kache \
    KACHE_RUNTIME_DIR=/run/kache \
    KACHE_LOCAL_ONLY=true \
    KACHE_AUTO_GC=false \
    KACHE_MAX_SIZE="${KACHE_MAX_SIZE}" \
    KACHE_PREFETCH_ENABLED=false \
    KACHE_LOCAL_HIT_DAEMON=false \
    KACHE_ADAPTIVE_INCREMENTAL=false \
    KACHE_PROGRESS="${KACHE_PROGRESS}" \
    KACHE_LOG="${KACHE_LOG}" \
    PATH="/opt/kache/shims:${PATH}"

COPY Cargo.toml Cargo.lock .kache.toml ./
COPY crates/ crates/
COPY migrations/ migrations/

RUN --mount=type=cache,id=azuki-cargo-registry-linux-amd64-v1,target=/usr/local/cargo/registry \
    --mount=type=cache,id=azuki-cargo-git-linux-amd64-v1,target=/usr/local/cargo/git \
    --mount=type=cache,id=${CARGO_TARGET_CACHE_ID},target=/app/target \
    --mount=type=cache,id=${KACHE_CACHE_ID},sharing=locked,target=/var/cache/kache \
    --mount=type=tmpfs,target=/run/kache \
    cargo build --locked --release --bin azuki \
    && install -m 0755 /app/target/release/azuki /usr/local/bin/azuki \
    && snapshot_ready=true \
    && touch /var/cache/kache/.snapshot-uncertain \
    && if ! timeout --signal=TERM --kill-after=5s 120s kache gc --json; then \
        snapshot_ready=false; \
        echo "warning: bounded kache synchronous GC failed; cache snapshot remains ineligible" >&2; \
    fi \
    && if ! timeout --signal=TERM --kill-after=5s 15s kache daemon stop; then \
        snapshot_ready=false; \
        echo "warning: bounded kache daemon shutdown request failed; cache snapshot remains ineligible" >&2; \
    fi \
    && if ! timeout --signal=TERM --kill-after=5s 50s \
        flock --exclusive --wait 45 /run/kache/daemon.run.lock true; then \
        snapshot_ready=false; \
        echo "warning: kache daemon did not finish draining; cache snapshot remains ineligible" >&2; \
    fi \
    && if [ "${snapshot_ready}" = true ] \
        && ! rm -f /var/cache/kache/.snapshot-uncertain; then \
        echo "warning: could not clear cache snapshot uncertainty marker" >&2; \
    fi

# Stage 3: Runtime
FROM ubuntu:24.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libopus0 python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (--checksum=skip to always fetch latest)
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

# Copy binary and frontend
COPY --from=rust-builder /usr/local/bin/azuki /usr/local/bin/azuki
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Create non-root user and data directories
RUN groupadd -r -g 10001 azuki && useradd -r -u 10001 -g azuki -d /app azuki \
    && mkdir -p /app/data /app/media \
    && chown -R azuki:azuki /app/data /app/media

USER azuki

ENV STATIC_DIR=/app/frontend/dist \
    MEDIA_DIR=/app/media \
    DATA_DIR=/app/data \
    DATABASE_URL=sqlite:/app/data/azuki.db \
    WEB_PORT=3000 \
    RUST_LOG=azuki=info,azuki_bot=info,azuki_web=info,azuki_media=info,sqlx=warn

EXPOSE 3000

VOLUME ["/app/data", "/app/media"]

ENTRYPOINT ["azuki"]

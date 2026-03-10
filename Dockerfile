# Stage 1: Build frontend
FROM node:25 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust binary
FROM rust:trixie AS chef
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS rust-builder

# Install build dependencies (needed before cook for audiopus_sys, songbird, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libopus-dev cmake \
    && rm -rf /var/lib/apt/lists/*

# Cook dependencies (re-runs only when Cargo.toml/Cargo.lock change)
COPY --from=planner /app/recipe.json recipe.json
ENV SQLX_OFFLINE=true
RUN cargo chef cook --release --recipe-path recipe.json

# Build application (only recompiles source changes)
COPY . .
RUN cargo build --release --bin azuki \
    && cp target/release/azuki /usr/local/bin/azuki

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

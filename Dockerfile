# Stage 1: Build frontend
FROM node:25 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust binary
FROM rust:trixie AS rust-builder
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libopus-dev cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy everything and build
COPY . .
ENV SQLX_OFFLINE=true
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --bin azuki \
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

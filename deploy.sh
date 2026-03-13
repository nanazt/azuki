#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${REGISTRY:-192.168.1.21:5000}"
REMOTE="${REMOTE:-192.168.1.21}"
REMOTE_DIR="${REMOTE_DIR:-~/azuki}"
IMAGE="${REGISTRY}/azuki"
TAG="${1:-latest}"
TARGET="x86_64-unknown-linux-musl"

echo "==> Building frontend"
(cd frontend && npm run build)

echo "==> Building Rust binary (${TARGET})"
CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc \
CXX_x86_64_unknown_linux_musl=x86_64-linux-musl-g++ \
AR_x86_64_unknown_linux_musl=x86_64-linux-musl-ar \
OPUS_NO_PKG=1 \
SQLX_OFFLINE=true \
cargo build --target "${TARGET}" --bin azuki

# Verify binary architecture
file "target/${TARGET}/debug/azuki" | grep -q "x86-64" || { echo "ERROR: binary is not x86-64"; exit 1; }

echo "==> Building Docker image"
docker build --platform linux/amd64 -f Dockerfile.dev -t "${IMAGE}:${TAG}" .

echo "==> Pushing to ${REGISTRY}"
docker push "${IMAGE}:${TAG}"

echo "==> Deploying to ${REMOTE}"
cat docker-compose.yml | ssh "${REMOTE}" \
  "cd ${REMOTE_DIR} && AZUKI_IMAGE=${IMAGE}:${TAG} docker compose --project-name azuki -f - --env-file .env up -d --pull always"

# Post-deploy health check
sleep 3
ssh "${REMOTE}" "docker ps --filter name=azuki --format '{{.Status}}'" | grep -q "Up" \
  && echo "==> Deploy complete!" \
  || echo "==> WARNING: container may not be running, check logs"

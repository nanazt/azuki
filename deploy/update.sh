#!/usr/bin/env bash
# Quick update: pull latest image and restart container
# Usage: sudo ./update.sh <domain>
# Example: sudo ./update.sh azuki.example.com
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: sudo $0 <domain>"
    exit 1
fi

DOMAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Pulling latest image..."
docker compose pull

echo "==> Restarting container..."
export WEB_ORIGIN="https://${DOMAIN}"
docker compose up -d

echo "==> Waiting for app to be ready..."
for i in $(seq 1 30); do
    if curl -sf --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1; then
        echo "==> Update complete. App is ready."
        exit 0
    fi
    sleep 2
done
echo "WARNING: App did not respond within 60s. Check: docker compose logs"

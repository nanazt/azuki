import { Workflow, Job, getAction } from "../generated/index.js";

const checkout = getAction("actions/checkout@v4");
const setupBuildx = getAction("docker/setup-buildx-action@v3");
const login = getAction("docker/login-action@v3");
const metadata = getAction("docker/metadata-action@v5");
const buildPush = getAction("docker/build-push-action@v6");

const repository = "${{ github.repository }}";
const runId = "${{ github.run_id }}";
const runAttempt = "${{ github.run_attempt }}";
const sourceSha = "${{ github.sha }}";
const cacheRepository = `ghcr.io/${repository}-build-cache`;
const layerCacheRef = `${cacheRepository}:buildkit-linux-amd64-v1`;
const snapshotFixedRef = "kache-linux-amd64-s1-kache-0.20.0";
const transferImage = "docker.io/library/debian:trixie-slim@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f";
const restoreCacheId = "${{ env.RESTORE_ID }}";
const selectedCacheId = "${{ steps.restore.outputs.cache_id || env.FALLBACK_ID }}";
const cacheArguments = [
  "--builder \"${{ steps.buildx.outputs.name }}\"",
  "--cache-target /var/cache/kache",
  `--transfer-image ${transferImage}`,
  "--registry https://ghcr.io",
  "--repository \"${{ github.repository }}-build-cache\"",
  `--fixed-ref ${snapshotFixedRef}`,
  "--platform linux/amd64",
  "--kache-version 0.20.0",
  "--schema-version 1",
  "--max-transfer-bytes 4294967296",
  "--max-unpacked-bytes 4294967296",
  "--max-disk-bytes 12884901888",
  "--max-files 100000",
  "--timeout-ms 600000",
].join(" \\\n  ");

new Workflow({
  name: "Docker Build & Push",
  on: {
    push: {
      tags: ["v*"],
    },
  },
  permissions: {
    contents: "read",
    packages: "write",
  },
})
  .jobs((j) =>
    j.add(
      "build",
      new Job("ubuntu-latest", {
        env: {
          FALLBACK_ID: "azuki-kache-linux-amd64-v1-kache-0.20.0-fallback-${{ github.run_id }}-${{ github.run_attempt }}",
          RESTORE_ID: "azuki-kache-linux-amd64-v1-kache-0.20.0-restore-${{ github.run_id }}-${{ github.run_attempt }}",
        },
        permissions: {
          actions: "read",
          contents: "read",
          packages: "write",
        },
      }).steps((s) =>
        s
          .add(checkout())
          .add(
            setupBuildx({
              id: "buildx",
              name: "Set up Docker Buildx",
            }),
          )
          .add(
            login({
              with: {
                registry: "ghcr.io",
                username: "${{ github.actor }}",
                password: "${{ secrets.GITHUB_TOKEN }}",
              },
            }),
          )
          .add({
            id: "restore",
            name: "Restore kache snapshot",
            "continue-on-error": true,
            "timeout-minutes": 15,
            env: {
              REGISTRY_USERNAME: "${{ github.actor }}",
              REGISTRY_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
            },
            run: `set -euo pipefail
if ! node scripts/docker-cache.mjs restore \\
  --cache-id "${restoreCacheId}" \\
  ${cacheArguments}; then
  echo "::warning::Kache snapshot restore failed; building with an empty cache."
  exit 1
fi
printf 'cache_id=%s\\n' "${restoreCacheId}" >> "$GITHUB_OUTPUT"`,
          })
          .add(
            metadata({
              id: "meta",
              with: {
                images: "ghcr.io/${{ github.repository }}",
                tags: [
                  "type=semver,pattern={{version}}",
                  "type=semver,pattern={{major}}.{{minor}}",
                  "type=raw,value=latest",
                ].join("\n"),
              },
            }),
          )
          .add(
            buildPush({
              id: "image",
              with: {
                builder: "${{ steps.buildx.outputs.name }}",
                context: ".",
                push: true,
                platforms: "linux/amd64",
                tags: "${{ steps.meta.outputs.tags }}",
                labels: "${{ steps.meta.outputs.labels }}",
                "build-args": [
                  `KACHE_CACHE_ID=${selectedCacheId}`,
                  "KACHE_MAX_SIZE=3GiB",
                ].join("\n"),
                "cache-from": `type=registry,ref=${layerCacheRef}`,
                "cache-to": `type=registry,ref=${layerCacheRef},mode=max,ignore-error=true`,
              },
            }),
          )
          .add({
            name: "Publish kache snapshot",
            if: "${{ steps.image.outcome == 'success' }}",
            "continue-on-error": true,
            "timeout-minutes": 15,
            env: {
              REGISTRY_USERNAME: "${{ github.actor }}",
              REGISTRY_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
            },
            run: `set -euo pipefail
if ! node scripts/docker-cache.mjs publish \\
  --cache-id "${selectedCacheId}" \\
  ${cacheArguments} \\
  --producer-repository "${repository}" \\
  --run-id "${runId}" \\
  --run-attempt "${runAttempt}" \\
  --source-sha "${sourceSha}"; then
  echo "::warning::Kache snapshot publication failed; preserving the published runtime image and prior snapshot."
  exit 1
fi`,
          }),
      ),
    ),
  )
  .build("docker");

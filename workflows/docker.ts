import { Workflow, Job, getAction } from "../generated/index.js";

const checkout = getAction("actions/checkout@v4");
const setupBuildx = getAction("docker/setup-buildx-action@v3");
const login = getAction("docker/login-action@v3");
const metadata = getAction("docker/metadata-action@v5");
const buildPush = getAction("docker/build-push-action@v6");

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
      new Job("ubuntu-latest").steps((s) =>
        s
          .add(checkout())
          .add(setupBuildx())
          .add(
            login({
              with: {
                registry: "ghcr.io",
                username: "${{ github.actor }}",
                password: "${{ secrets.GITHUB_TOKEN }}",
              },
            }),
          )
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
              with: {
                context: ".",
                push: true,
                tags: "${{ steps.meta.outputs.tags }}",
                labels: "${{ steps.meta.outputs.labels }}",
                "cache-from": "type=gha",
                "cache-to": "type=gha,mode=max",
              },
            }),
          ),
      ),
    ),
  )
  .build("docker");

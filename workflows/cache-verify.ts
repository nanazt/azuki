import { Workflow, Job, getAction } from "../generated/index.js";

const checkout = getAction("actions/checkout@v4");
const login = getAction("docker/login-action@v3");
const downloadArtifact = getAction("actions/download-artifact@v4");
const uploadArtifact = getAction("actions/upload-artifact@v4");

const repository = "${{ github.repository }}";
const sourceSha = "${{ github.sha }}";
const seedRunId = "${{ inputs.seed_run_id }}";
const compareRunId = "${{ inputs.compare_run_id }}";

const verificationDirectories = {
  VERIFY_OUTPUT_DIR: "${{ runner.temp }}/azuki-cache-verify-output",
  VERIFY_WORK_DIR: "${{ runner.temp }}/azuki-cache-verify-work",
  VERIFY_INPUT_DIR: "${{ runner.temp }}/azuki-cache-verify-input",
  TMPDIR: "${{ runner.temp }}/azuki-cache-verify-tmp",
};

type Phase = "seed" | "compare" | "retain";
type Mode = "seed" | "warm" | "control" | "fault" | "retain";

type ArtifactInput = {
  name: string;
  path: string;
  runId: string;
};

const seedArtifact: ArtifactInput = {
  name: "azuki-cache-verify-seed",
  path: "${{ env.VERIFY_INPUT_DIR }}/seed",
  runId: seedRunId,
};

const warmArtifact: ArtifactInput = {
  name: "azuki-cache-verify-warm",
  path: "${{ env.VERIFY_INPUT_DIR }}/warm",
  runId: compareRunId,
};

function validationScript(phase: Phase): string {
  const requiredRunIds = phase === "seed"
    ? []
    : phase === "compare"
      ? [["seed_run_id", "INPUT_SEED_RUN_ID"]]
      : [
          ["seed_run_id", "INPUT_SEED_RUN_ID"],
          ["compare_run_id", "INPUT_COMPARE_RUN_ID"],
        ];

  return [
    "set -euo pipefail",
    `if [[ \"$INPUT_PHASE\" != \"${phase}\" ]]; then`,
    `  echo \"::error::This job requires phase ${phase}.\"`,
    "  exit 1",
    "fi",
    ...requiredRunIds.flatMap(([input, variable]) => [
      `if [[ ! \"$${variable}\" =~ ^[1-9][0-9]*$ ]]; then`,
      `  echo \"::error::${input} must be a positive numeric workflow run ID for phase ${phase}.\"`,
      "  exit 1",
      "fi",
    ]),
  ].join("\n");
}

function verificationJob(mode: Mode, phase: Phase, artifactInputs: ArtifactInput[] = []): Job {
  return new Job("ubuntu-latest", {
    if: `\${{ inputs.phase == '${phase}' }}`,
    "timeout-minutes": 40,
    permissions: {
      actions: "read",
      contents: "read",
      packages: "write",
    },
    env: phase === "seed"
      ? undefined
      : {
          VERIFY_SEED_RUN_ID: seedRunId,
          ...(phase === "retain" ? { VERIFY_COMPARE_RUN_ID: compareRunId } : {}),
        },
  }).steps((steps) => {
    steps.add({
      name: "Prepare verification directories",
      env: verificationDirectories,
      run: `set -euo pipefail
mkdir -p "$VERIFY_OUTPUT_DIR" "$VERIFY_WORK_DIR" "$VERIFY_INPUT_DIR" "$TMPDIR"
{
  printf 'VERIFY_OUTPUT_DIR=%s\\n' "$VERIFY_OUTPUT_DIR"
  printf 'VERIFY_WORK_DIR=%s\\n' "$VERIFY_WORK_DIR"
  printf 'VERIFY_INPUT_DIR=%s\\n' "$VERIFY_INPUT_DIR"
  printf 'TMPDIR=%s\\n' "$TMPDIR"
  printf 'VERIFY_JOB_STARTED_AT_MS=%s000\\n' "$(date +%s)"
} >> "$GITHUB_ENV"`,
    });
    steps.add({
      name: "Validate workflow inputs",
      env: {
        INPUT_PHASE: "${{ inputs.phase }}",
        INPUT_SEED_RUN_ID: seedRunId,
        INPUT_COMPARE_RUN_ID: compareRunId,
      },
      run: validationScript(phase),
    });
    steps.add(
      checkout({
        name: "Checkout dispatched commit",
        with: {
          ref: sourceSha,
          "persist-credentials": false,
        },
      }),
    );
    steps.add(
      login({
        name: "Log in to GHCR",
        with: {
          registry: "ghcr.io",
          username: "${{ github.actor }}",
          password: "${{ secrets.GITHUB_TOKEN }}",
        },
      }),
    );

    for (const artifact of artifactInputs) {
      steps.add(
        downloadArtifact({
          name: `Download ${artifact.name}`,
          with: {
            name: artifact.name,
            path: artifact.path,
            repository,
            "run-id": artifact.runId,
            "github-token": "${{ secrets.GITHUB_TOKEN }}",
          },
        }),
      );
    }

    steps.add({
      name: `Run ${mode} verification`,
      env: {
        REGISTRY_USERNAME: "${{ github.actor }}",
        REGISTRY_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      },
      run: `node \"$GITHUB_WORKSPACE/scripts/verify-remote-docker-cache.mjs\" ${mode}`,
    });
    steps.add(
      uploadArtifact({
        name: `Upload ${mode} evidence`,
        if: "${{ always() }}",
        with: {
          name: `azuki-cache-verify-${mode}`,
          path: "${{ env.VERIFY_OUTPUT_DIR }}",
          "if-no-files-found": "error",
          "retention-days": 3,
        },
      }),
    );

    return steps;
  });
}

new Workflow({
  name: "Cache Verification",
  on: {
    workflow_dispatch: {
      inputs: {
        phase: {
          description: "Verification phase to run",
          required: true,
          type: "choice",
          options: ["seed", "compare", "retain"],
        },
        seed_run_id: {
          description: "Successful seed workflow run ID (required for compare and retain)",
          required: false,
          type: "string",
        },
        compare_run_id: {
          description: "Successful compare workflow run ID (required for retain)",
          required: false,
          type: "string",
        },
      },
    },
  },
  concurrency: {
    group: "azuki-cache-verification",
    "cancel-in-progress": false,
  },
  permissions: {
    actions: "read",
    contents: "read",
    packages: "write",
  },
})
  .jobs((jobs) =>
    jobs
      .add("seed", verificationJob("seed", "seed"))
      .add("warm", verificationJob("warm", "compare", [seedArtifact]))
      .add("control", verificationJob("control", "compare", [seedArtifact]))
      .add("fault", verificationJob("fault", "compare", [seedArtifact]))
      .add("retain", verificationJob("retain", "retain", [seedArtifact, warmArtifact])),
  )
  .build("cache-verify");

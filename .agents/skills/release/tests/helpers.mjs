import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "../../../..");
export const CLI_PATH = resolve(TEST_DIR, "../scripts/release.mjs");
export const APPROVED_REMOTE = "github-nanaz:nanazt/azuki.git";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FIXTURE_DATE = "2025-01-02T03:04:05Z";

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith("GIT_") && !Object.hasOwn(extra, key)) ||
      /^(?:GH_|GITHUB_|GIT_CONFIG_(?:COUNT|KEY_|VALUE_))/.test(key) ||
      ["SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE"].includes(key)
    ) delete env[key];
  }
  return env;
}

export function runProcess(binary, args, { cwd, env, input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: childEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out running ${binary} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        code: code ?? 128,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function successful(binary, args, options = {}) {
  const result = await runProcess(binary, args, options);
  assert.equal(result.code, 0, `${binary} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function discover(binary) {
  return successful("/usr/bin/env", ["sh", "-c", `command -v ${binary}`]);
}

async function executable(path, content) {
  await writeFile(path, content, { mode: 0o700 });
  await chmod(path, 0o700);
}

const GIT_SHIM = String.raw`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const realGit = process.env.AZUKI_TEST_REAL_GIT;
const statePath = process.env.AZUKI_TEST_STATE;
const remote = process.env.AZUKI_TEST_REMOTE;
const approved = "github-nanaz:nanazt/azuki.git";
const networkOp = ["fetch", "push", "ls-remote"].find((name) => args.includes(name));

function load() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}
function save(state) {
  const next = statePath + ".next-" + process.pid;
  writeFileSync(next, JSON.stringify(state, null, 2));
  renameSync(next, statePath);
}
function targetAfter(op) {
  const start = args.indexOf(op) + 1;
  const optionsWithValues = new Set(["--upload-pack", "--receive-pack", "--depth", "--shallow-since", "--shallow-exclude", "--server-option"]);
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) return value;
  }
  return null;
}
function registerWorkflow(state) {
  const refspec = args.find((arg) => arg.includes("refs/tags/v"));
  const match = refspec?.match(/refs\/tags\/(v[^:\s]+)$/);
  if (!match || state.workflowMode === "none") return;
  const tag = match[1];
  const peeled = spawnSync(realGit, ["--git-dir", remote, "rev-parse", "refs/tags/" + tag + "^{}"], { encoding: "utf8" });
  if (peeled.status !== 0) return;
  const finalSha = peeled.stdout.trim();
  const id = state.nextRunId++;
  const failure = state.workflowMode === "failure";
  const mismatch = state.workflowMode === "mismatch";
  const pending = state.workflowMode === "pending" || state.workflowMode === "watch-lies";
  state.workflowRuns.push({
    id,
    html_url: "https://github.test/nanazt/azuki/actions/runs/" + id,
    status: pending ? "in_progress" : "completed",
    conclusion: pending ? null : failure ? "failure" : "success",
    event: "push",
    head_branch: tag,
    head_sha: mismatch ? "0000000000000000000000000000000000000000" : finalSha,
    name: "Docker Build & Push",
    path: ".github/workflows/docker.yml"
  });
}

if (networkOp) {
  const target = targetAfter(networkOp);
  if (target !== "origin" && target !== approved) {
    console.error("test git shim blocked unapproved network destination: " + String(target));
    process.exit(97);
  }
  if (target === "origin") {
    const lookup = networkOp === "push"
      ? ["remote", "get-url", "--push", "--all", "origin"]
      : ["remote", "get-url", "--all", "origin"];
    const configured = spawnSync(realGit, lookup, { encoding: "utf8", env: process.env });
    const urls = configured.status === 0 ? configured.stdout.trim().split(/\r?\n/) : [];
    if (urls.length !== 1 || urls[0] !== approved) {
      console.error("test git shim blocked origin with an unapproved effective URL");
      process.exit(97);
    }
  }
  const state = load();
  state.gitNetworkCalls.push(args);
  if (networkOp === "push" && state.pushMode === "fail-before") {
    save(state);
    console.error("simulated push interruption before remote mutation");
    process.exit(75);
  }
  const invocation = ["-c", "protocol.file.allow=always", "-c", "url.file://" + remote + "/.insteadOf=" + approved, ...args];
  const result = spawnSync(realGit, invocation, { stdio: "inherit", env: process.env });
  if (networkOp === "push" && result.status === 0) {
    registerWorkflow(state);
    save(state);
    if (state.pushMode === "uncertain-after-success") {
      console.error("simulated lost push acknowledgement");
      process.exit(75);
    }
  } else {
    save(state);
  }
  process.exit(result.status ?? 128);
}

const result = spawnSync(realGit, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 128);
`;

const SSH_SHIM = String.raw`#!/usr/bin/env node
import { readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.AZUKI_TEST_STATE, "utf8"));
const login = state.sshIdentity;
process.stderr.write("Hi " + login + "! You've successfully authenticated, but GitHub does not provide shell access.\n");
process.exit(1);
`;

const CARGO_SHIM = String.raw`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const root = process.cwd();
const state = JSON.parse(readFileSync(process.env.AZUKI_TEST_STATE, "utf8"));
const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const manifestPath = join(root, "crates", "azuki", "Cargo.toml");
const id = "path+file://" + join(root, "crates", "azuki") + "#azuki@" + version;
if (args[0] === "metadata") {
  process.stdout.write(JSON.stringify({
    packages: [{ name: "azuki", version, id, source: null, manifest_path: manifestPath, dependencies: [], targets: [] }],
    workspace_members: [id],
    workspace_default_members: [id],
    resolve: null,
    target_directory: join(root, "target"),
    workspace_root: root,
    metadata: {},
    version: 1
  }));
  process.exit(0);
}
if (args[0] === "update" && args.includes("--workspace")) {
  let lock = readFileSync(join(root, "Cargo.lock"), "utf8");
  lock = lock.replace(/(name = "azuki"\nversion = ")[^"]+("\n)/, "$1" + version + "$2");
  if (state.lockDrift === "unrelated-version") {
    lock = lock.replace(/(name = "fixture-dependency"\nversion = ")1\.0\.0("\n)/, "$1" + "1.0.1" + "$2");
  } else if (state.lockDrift === "dependency-edge") {
    lock = lock.replace(/(name = "azuki"\nversion = "[^"]+"\n)/, "$1dependencies = [\"fixture-dependency\"]\n");
  }
  writeFileSync(join(root, "Cargo.lock"), lock);
  process.exit(0);
}
console.error("unsupported cargo fixture command: " + args.join(" "));
process.exit(96);
`;

const MISE_SHIM = String.raw`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.AZUKI_TEST_STATE;
function load() { return JSON.parse(readFileSync(statePath, "utf8")); }
function save(state) {
  const next = statePath + ".next-" + process.pid;
  writeFileSync(next, JSON.stringify(state, null, 2));
  renameSync(next, statePath);
}
function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
function releaseView(release) {
  return {
    id: release.id,
    tag_name: release.tag,
    name: release.name,
    draft: false,
    prerelease: release.prerelease,
    html_url: release.url,
    body: release.body
  };
}
if (args[0] !== "run") {
  console.error("unsupported mise fixture command: " + args.join(" "));
  process.exit(96);
}
if (args[1] === "check" || args[1] === "test") {
  const state = load();
  state.buildCalls.push(args.slice(1));
  save(state);
  if (state.failCheck === args[1]) {
    console.error("simulated " + args[1] + " failure");
    process.exit(42);
  }
  process.exit(0);
}
if (args[1] !== "gh-nanazt" || args[2] !== "--") {
  console.error("mise fixture blocked command outside gh-nanazt: " + args.join(" "));
  process.exit(96);
}
const gh = args.slice(3);
const state = load();
state.ghCalls.push(gh);
save(state);
if (gh[0] === "api") {
  const endpoint = gh.find((arg) => arg === "user" || arg.startsWith("repos/"));
  if (endpoint === "user") {
    process.stdout.write(gh.includes("--jq") ? state.apiIdentity + "\n" : JSON.stringify({ login: state.apiIdentity }));
    process.exit(0);
  }
  if (endpoint?.includes("/actions/workflows/docker.yml/runs?")) {
    const pages = [{ workflow_runs: structuredClone(state.workflowRuns) }];
    const publishedRun = state.workflowRuns.find((run) => /^v/.test(run.head_branch));
    if (state.workflowFlipIdentity && publishedRun && !state.workflowIdentityFlipped) {
      publishedRun.head_sha = "0000000000000000000000000000000000000000";
      state.workflowIdentityFlipped = true;
      save(state);
    }
    process.stdout.write(JSON.stringify(pages) + "\n");
    process.exit(0);
  }
  if (endpoint?.includes("/releases?")) {
    const pages = [state.releases.map(releaseView)];
    if (state.rollbackRemoteAfterReleaseList && state.releases.length > 0) {
      state.releaseListsAfterCreate += 1;
      if (state.releaseListsAfterCreate === 2) {
        const rollback = spawnSync(
          process.env.AZUKI_TEST_REAL_GIT,
          ["--git-dir", process.env.AZUKI_TEST_REMOTE, "update-ref", "refs/heads/master", state.rollbackRemoteTo],
          { encoding: "utf8" },
        );
        if (rollback.status !== 0) {
          console.error("failed to apply sandbox remote rollback: " + rollback.stderr);
          process.exit(96);
        }
        state.remoteRollbackApplied = true;
      }
      save(state);
    }
    process.stdout.write(JSON.stringify(pages) + "\n");
    process.exit(0);
  }
  console.error("unsupported gh api fixture endpoint: " + String(endpoint));
  process.exit(96);
}
if (gh[0] === "run" && gh[1] === "watch") {
  const run = state.workflowRuns.find((candidate) => String(candidate.id) === gh[2]);
  if (!run) {
    console.error("workflow run does not exist");
    process.exit(1);
  }
  if (state.workflowMode === "pending" || state.workflowMode === "watch-lies") {
    run.status = "completed";
    run.conclusion = state.workflowMode === "pending" ? "success" : "cancelled";
    save(state);
    process.exit(0);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    console.error("workflow did not complete successfully");
    process.exit(1);
  }
  process.exit(0);
}
if (gh[0] === "release" && gh[1] === "create") {
  const tag = gh[2];
  const notesPath = valueAfter(gh, "--notes-file");
  const body = readFileSync(notesPath, "utf8");
  const existing = state.releases.find((release) => release.tag === tag);
  if (existing) {
    console.error("release already exists");
    process.exit(1);
  }
  const id = state.nextReleaseId++;
  const release = {
    id,
    tag,
    name: valueAfter(gh, "--title"),
    prerelease: gh.includes("--prerelease"),
    url: "https://github.test/nanazt/azuki/releases/tag/" + tag,
    body
  };
  state.releaseCreateCalls += 1;
  state.releases.push(release);
  save(state);
  process.stdout.write(release.url + "\n");
  if (state.createMode === "uncertain-after-success") {
    console.error("simulated lost release-create acknowledgement");
    process.exit(75);
  }
  process.exit(0);
}
console.error("unsupported gh fixture command: " + gh.join(" "));
process.exit(96);
`;

const BUILD_SHIM = String.raw`#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const statePath = process.env.AZUKI_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const tool = process.argv[1].split("/").pop();
state.buildCalls.push([tool, ...process.argv.slice(2)]);
const next = statePath + ".next-" + process.pid;
writeFileSync(next, JSON.stringify(state, null, 2));
renameSync(next, statePath);
if (state.failCheck === tool) {
  console.error("simulated " + tool + " failure");
  process.exit(42);
}
process.exit(0);
`;

function defaultServiceState(overrides = {}) {
  return {
    apiIdentity: "nanazt",
    sshIdentity: "nanazt",
    failCheck: null,
    lockDrift: null,
    pushMode: "normal",
    workflowMode: "success",
    workflowFlipIdentity: false,
    workflowIdentityFlipped: false,
    rollbackRemoteAfterReleaseList: false,
    rollbackRemoteTo: null,
    releaseListsAfterCreate: 0,
    remoteRollbackApplied: false,
    createMode: "normal",
    workflowRuns: [],
    releases: [],
    gitNetworkCalls: [],
    ghCalls: [],
    buildCalls: [],
    releaseCreateCalls: 0,
    nextRunId: 1000,
    nextReleaseId: 2000,
    ...overrides,
  };
}

function parseCliJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return undefined;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return undefined;
  }
}

async function writeFixtureTree(repo, workspaceVersion) {
  await mkdir(join(repo, "crates", "azuki", "src"), { recursive: true });
  await mkdir(join(repo, "frontend"), { recursive: true });
  await mkdir(join(repo, ".github", "workflows"), { recursive: true });
  await mkdir(join(repo, "workflows"), { recursive: true });
  await writeFile(join(repo, "Cargo.toml"), `[workspace]\nmembers = ["crates/azuki"]\nresolver = "3"\n\n[workspace.package]\nedition = "2024"\nversion = "${workspaceVersion}"\n`);
  await writeFile(join(repo, "Cargo.lock"), `# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "azuki"\nversion = "${workspaceVersion}"\n\n[[package]]\nname = "fixture-dependency"\nversion = "1.0.0"\n`);
  await writeFile(join(repo, "crates", "azuki", "Cargo.toml"), `[package]\nname = "azuki"\nedition.workspace = true\nversion.workspace = true\n`);
  await writeFile(join(repo, "crates", "azuki", "src", "lib.rs"), "pub fn fixture() -> bool { true }\n");
  await writeFile(join(repo, "frontend", "package.json"), `{"name":"fixture-frontend","private":true,"scripts":{"build":"exit 0"}}\n`);
  await cp(join(PROJECT_ROOT, ".github", "workflows", "docker.yml"), join(repo, ".github", "workflows", "docker.yml"));
  await cp(join(PROJECT_ROOT, "workflows", "docker.ts"), join(repo, "workflows", "docker.ts"));
  await writeFile(join(repo, "README.md"), "# Fixture\n\nInitial release content.\n");
}

async function gitCommit(fixture, message, paths = ["."]) {
  await successful(fixture.realGit, ["add", ...paths], { cwd: fixture.repo, env: fixture.gitEnv });
  await successful(fixture.realGit, ["commit", "-m", message], { cwd: fixture.repo, env: fixture.gitEnv });
  return successful(fixture.realGit, ["rev-parse", "HEAD"], { cwd: fixture.repo, env: fixture.gitEnv });
}

export async function createReleaseFixture({
  workspaceVersion = "0.2.0",
  baselineVersions = ["0.1.0"],
  releaseChange = true,
  unreachableRelease = false,
  service = {},
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "azuki-release-cli-"));
  const repo = join(base, "work");
  const remote = join(base, "remote.git");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const statePath = join(base, "service-state.json");
  await Promise.all([mkdir(repo), mkdir(bin), mkdir(home)]);
  const [realGit, realNode] = await Promise.all([discover("git"), discover("node")]);
  const fixture = {
    base,
    repo,
    remote,
    bin,
    home,
    statePath,
    realGit,
    realNode,
    gitEnv: {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: FIXTURE_DATE,
      GIT_COMMITTER_DATE: FIXTURE_DATE,
    },
  };
  await writeFile(statePath, JSON.stringify(defaultServiceState(service), null, 2), { mode: 0o600 });
  await Promise.all([
    executable(join(bin, "git"), GIT_SHIM),
    executable(join(bin, "ssh"), SSH_SHIM),
    executable(join(bin, "cargo"), CARGO_SHIM),
    executable(join(bin, "mise"), MISE_SHIM),
    executable(join(bin, "npm"), BUILD_SHIM),
    executable(join(bin, "npx"), BUILD_SHIM),
  ]);
  await successful(realGit, ["init", "--bare", remote], { env: fixture.gitEnv });
  await successful(realGit, ["init", "-b", "master", repo], { env: fixture.gitEnv });
  await successful(realGit, ["config", "user.name", "Fixture Releaser"], { cwd: repo, env: fixture.gitEnv });
  await successful(realGit, ["config", "user.email", "fixture@example.test"], { cwd: repo, env: fixture.gitEnv });
  await successful(realGit, ["remote", "add", "origin", APPROVED_REMOTE], { cwd: repo, env: fixture.gitEnv });
  await writeFixtureTree(repo, workspaceVersion);
  fixture.initialSha = await gitCommit(fixture, "feat: initial fixture release");
  for (const version of baselineVersions) {
    await successful(realGit, ["tag", "-a", `v${version}`, "-m", `v${version}`, fixture.initialSha], { cwd: repo, env: fixture.gitEnv });
  }
  if (unreachableRelease) {
    const emptyTree = await successful(realGit, ["mktree"], { cwd: repo, env: fixture.gitEnv, input: "" });
    const orphan = await successful(realGit, ["commit-tree", emptyTree, "-m", "historical release"], { cwd: repo, env: fixture.gitEnv });
    await successful(realGit, ["tag", "-a", "v0.1.0", "-m", "v0.1.0", orphan], { cwd: repo, env: fixture.gitEnv });
  }
  await successful(realGit, ["push", remote, "refs/heads/master:refs/heads/master", ...baselineVersions.map((version) => `refs/tags/v${version}:refs/tags/v${version}`), ...(unreachableRelease ? ["refs/tags/v0.1.0:refs/tags/v0.1.0"] : [])], { cwd: repo, env: fixture.gitEnv });
  await successful(realGit, ["fetch", remote, "refs/heads/master:refs/remotes/origin/master"], { cwd: repo, env: fixture.gitEnv });
  await successful(realGit, ["branch", "--set-upstream-to", "origin/master", "master"], { cwd: repo, env: fixture.gitEnv });
  if (releaseChange) {
    await writeFile(join(repo, "README.md"), "# Fixture\n\nInitial release content.\n\nA complete consumer-visible improvement.\n");
    fixture.sourceSha = await gitCommit(fixture, "feat: add consumer-visible improvement", ["README.md"]);
    await successful(realGit, ["push", remote, "refs/heads/master:refs/heads/master"], { cwd: repo, env: fixture.gitEnv });
    await successful(realGit, ["fetch", remote, "refs/heads/master:refs/remotes/origin/master"], { cwd: repo, env: fixture.gitEnv });
  } else {
    fixture.sourceSha = fixture.initialSha;
  }
  fixture.env = {
    HOME: home,
    PATH: `${bin}:${dirname(realNode)}:${ORIGINAL_PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
    AZUKI_TEST_REAL_GIT: realGit,
    AZUKI_TEST_REMOTE: remote,
    AZUKI_TEST_STATE: statePath,
  };
  fixture.cleanup = () => rm(base, { recursive: true, force: true });
  fixture.readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  fixture.updateState = async (patch) => {
    const current = await fixture.readState();
    const next = typeof patch === "function" ? patch(structuredClone(current)) : { ...current, ...patch };
    await writeFile(statePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  };
  fixture.runCli = async (...args) => {
    const result = await runProcess(process.execPath, [CLI_PATH, ...args.flat()], {
      cwd: repo,
      env: fixture.env,
      timeoutMs: 60_000,
    });
    return { ...result, json: parseCliJson(result.stdout) };
  };
  fixture.git = (...args) => successful(realGit, args.flat(), { cwd: repo, env: fixture.gitEnv });
  fixture.remoteGit = (...args) => successful(realGit, ["--git-dir", remote, ...args.flat()], { env: fixture.gitEnv });
  fixture.writeNotes = async (version, body = `# v${version}\n\n## Added\n\n- A complete fixture improvement.\n`) => {
    const path = join(base, `notes-${version.replaceAll("/", "-")}.md`);
    await writeFile(path, body);
    return path;
  };
  fixture.commitChange = async (name = "post-plan.txt", contents = "changed after approval\n") => {
    await writeFile(join(repo, name), contents);
    return gitCommit(fixture, "feat: change source after planning", [name]);
  };
  fixture.refState = async (tag = "v0.3.0") => {
    const head = await fixture.git("rev-parse", "HEAD");
    const commits = Number(await fixture.git("rev-list", "--count", "HEAD"));
    const localTagResult = await runProcess(realGit, ["rev-parse", `refs/tags/${tag}`], { cwd: repo, env: fixture.gitEnv });
    const remoteHeadResult = await runProcess(realGit, ["--git-dir", remote, "rev-parse", "refs/heads/master"], { env: fixture.gitEnv });
    const remoteTagResult = await runProcess(realGit, ["--git-dir", remote, "rev-parse", `refs/tags/${tag}`], { env: fixture.gitEnv });
    const serviceState = await fixture.readState();
    return {
      head,
      commits,
      localTag: localTagResult.code === 0 ? localTagResult.stdout.trim() : null,
      remoteHead: remoteHeadResult.code === 0 ? remoteHeadResult.stdout.trim() : null,
      remoteTag: remoteTagResult.code === 0 ? remoteTagResult.stdout.trim() : null,
      releases: serviceState.releases.map(({ tag: releaseTag, name, prerelease, url, body }) => ({ tag: releaseTag, name, prerelease, url, body })),
    };
  };
  fixture.setConflictingRemoteTag = async (tag, target = fixture.initialSha) => {
    const scratch = `fixture-conflict-${tag}`;
    await fixture.git("tag", "-a", scratch, "-m", scratch, target);
    await successful(realGit, ["push", remote, `refs/tags/${scratch}:refs/tags/${tag}`], { cwd: repo, env: fixture.gitEnv });
    await fixture.git("tag", "-d", scratch);
    return fixture.remoteGit("rev-parse", `refs/tags/${tag}^{}`);
  };
  return fixture;
}

export function assertCliSuccess(result, command) {
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.json?.ok, true, `missing success JSON:\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.json?.command, command);
  return result.json;
}

export function assertCliFailure(result, expectedCodes) {
  assert.notEqual(result.code, 0, `command unexpectedly succeeded:\n${result.stdout}`);
  assert.equal(result.json?.ok, false, `missing failure JSON:\n${result.stdout}\n${result.stderr}`);
  const accepted = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  assert.ok(accepted.every((code) => typeof code === "string" && code.length > 0), "expected error code is required");
  assert.ok(accepted.includes(result.json?.code), `expected ${accepted.join(" or ")}, received ${result.json?.code}`);
  return result.json;
}

export async function preparePlan(fixture, version = "0.3.0", notesBody) {
  const inspected = fixture.runCli("inspect");
  const inspectionResult = await inspected;
  const inspection = assertCliSuccess(inspectionResult, "inspect");
  const notes = await fixture.writeNotes(version, notesBody);
  const planResult = await fixture.runCli("plan", "--inspection", inspection.inspection, "--version", version, "--notes", notes);
  const plan = assertCliSuccess(planResult, "plan");
  return { inspection, inspectionResult, notes, plan, planResult };
}

export async function assertAnnotatedPublication(fixture, { tag, finalSha, notes, prerelease = false }) {
  assert.equal(await fixture.git("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(await fixture.git("rev-parse", `refs/tags/${tag}^{}`), finalSha);
  assert.equal(await fixture.remoteGit("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(await fixture.remoteGit("rev-parse", `refs/tags/${tag}^{}`), finalSha);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), finalSha);
  const state = await fixture.readState();
  const release = state.releases.find((candidate) => candidate.tag === tag);
  assert.ok(release, `missing API release ${tag}`);
  assert.equal(release.name, tag);
  assert.equal(release.body, notes);
  assert.equal(release.prerelease, prerelease);
  const workflow = state.workflowRuns.find((run) => run.head_branch === tag && run.head_sha === finalSha);
  assert.equal(workflow?.status, "completed");
  assert.equal(workflow?.conclusion, "success");
  return { release, workflow, state };
}

export async function runSmokeScenario({ keep = false, version = "0.3.0" } = {}) {
  const fixture = await createReleaseFixture();
  try {
    const before = await fixture.refState(`v${version}`);
    const { plan, notes } = await preparePlan(fixture, version);
    const approvedNotes = await readFile(notes, "utf8");
    const result = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
    const published = assertCliSuccess(result, "publish");
    const evidence = await assertAnnotatedPublication(fixture, {
      tag: `v${version}`,
      finalSha: published.finalSha,
      notes: approvedNotes,
    });
    return {
      result: published,
      before,
      after: await fixture.refState(`v${version}`),
      release: evidence.release,
      workflow: evidence.workflow,
      sandbox: keep ? fixture.base : undefined,
    };
  } finally {
    if (!keep) await fixture.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSmokeScenario({ keep: process.argv.includes("--keep") })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  GitHubRetentionClient,
  RegistryClient,
  compatibilityRef,
  publishSnapshot,
  resolveSnapshot,
  restoreSnapshot,
  runPostPublicationRetention,
} from './docker-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'nanazt/azuki';
const CACHE_REPOSITORY = 'nanazt/azuki-build-cache';
const REGISTRY = 'https://ghcr.io';
const LAYER_REF = 'ghcr.io/nanazt/azuki-build-cache:buildkit-linux-amd64-v1';
const TRANSFER_IMAGE = 'docker.io/library/debian:trixie-slim@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f';
const COMPATIBILITY = Object.freeze({ platform: 'linux/amd64', schemaVersion: 1, kacheVersion: '0.20.0', fixedRef: 'kache-linux-amd64-s1-kache-0.20.0' });
const LIMITS = Object.freeze({ maxTransferBytes: 4_294_967_296, maxUnpackedBytes: 4_294_967_296, maxDiskBytes: 12_884_901_888, maxFiles: 100_000, maxMetadataBytes: 1_048_576, maxCommandOutputBytes: 1_048_576, timeoutMs: 600_000 });
const RETENTION_LIMITS = Object.freeze({ targetSnapshots: 2, maxPages: 10, maxVersions: 500, perPage: 100, timeoutMs: 60_000, maxWarnings: 8 });
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const HELPER_TIMEOUT_MS = 15 * 60_000;
const WORK_BUDGET_MS = 32 * 60_000;
const CLEANUP_BUDGET_MS = 3 * 60_000;
const DISK_SAMPLE_INTERVAL_MS = 5_000;
const LOG_LIMIT = 1_048_576;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const MODES = new Set(['seed', 'warm', 'control', 'fault', 'retain']);

class VerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.details = details;
  }
}

function expect(value, code, message, details = {}) {
  if (!value) throw new VerificationError(code, message, details);
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    details: error?.details && typeof error.details === 'object' ? error.details : {},
  };
}

class Ring {
  constructor(limit = LOG_LIMIT) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
  }

  add(chunk) {
    let value = Buffer.from(chunk);
    if (value.length >= this.limit) {
      this.chunks = [value.subarray(value.length - this.limit)];
      this.size = this.limit;
      this.truncated = true;
      return;
    }
    this.chunks.push(value);
    this.size += value.length;
    while (this.size > this.limit) {
      const first = this.chunks[0];
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
      this.truncated = true;
    }
  }

  bytes() {
    return Buffer.concat(this.chunks, this.size);
  }
}

const owned = { builder: null, images: new Set(), containers: new Set() };
let outputDir;
let workDir;
let inputDir;
let tmpDir;
let diskState;
let diskTimer;
let result;
let workDeadline;
let cleanupDeadline;
const timings = { helperOperations: [] };

function redacted(bytes) {
  let text = bytes.toString('utf8');
  for (const secret of [process.env.REGISTRY_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text;
}

function remainingBudget(maximum, budget = 'work') {
  const deadline = budget === 'cleanup' ? cleanupDeadline : workDeadline;
  expect(Number.isSafeInteger(deadline), 'DEADLINE_UNSET', `${budget} deadline is not configured.`);
  const remaining = deadline - Date.now();
  expect(remaining > 0, budget === 'cleanup' ? 'CLEANUP_DEADLINE' : 'WORK_DEADLINE', `${budget} deadline was reached before starting more work.`);
  return Math.min(maximum, remaining);
}
class VertexTracker {
  constructor() { this.decoder = new StringDecoder('utf8'); this.pending = ''; this.vertices = new Map(); }
  add(chunk) {
    this.pending += this.decoder.write(chunk);
    const lines = this.pending.split('\n');
    this.pending = lines.pop().slice(-262_144);
    for (const line of lines) {
      const definition = /^(#\d+) .*RUN .*VERIFY_CARGO_RUN_DONE/u.exec(line);
      if (definition && !this.vertices.has(definition[1])) this.vertices.set(definition[1], null);
      const status = /^(#\d+) (DONE|CACHED)(?:\s|$)/u.exec(line);
      if (status && this.vertices.has(status[1])) this.vertices.set(status[1], status[2]);
    }
  }
  result() { this.add(Buffer.from('\n')); return [...this.vertices].map(([step, status]) => ({ step, status })); }
}

async function run(binary, args, { cwd = ROOT, env = process.env, timeoutMs = COMMAND_TIMEOUT_MS, allowFailure = false, exactStdout = false, logFile, budget = 'work' } = {}) {
  const started = performance.now();
  const availableMs = remainingBudget(timeoutMs + 5_000, budget);
  expect(availableMs > 5_000, budget === 'cleanup' ? 'CLEANUP_DEADLINE' : 'WORK_DEADLINE', `Insufficient ${budget} budget remains for process termination.`);
  const boundedTimeoutMs = Math.min(timeoutMs, availableMs - 5_000);
  const stdout = new Ring(exactStdout ? LOG_LIMIT : LOG_LIMIT);
  const stderr = new Ring(LOG_LIMIT);
  const combined = new Ring(LOG_LIMIT);
  const vertices = [new VertexTracker(), new VertexTracker()];
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  let killTimer;
  const terminate = (signal = 'SIGTERM') => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    terminate();
    killTimer ??= setTimeout(() => terminate('SIGKILL'), 5_000).unref();
  };
  child.stdout.on('data', (chunk) => { stdout.add(chunk); combined.add(chunk); vertices[0].add(chunk); });
  child.stderr.on('data', (chunk) => { stderr.add(chunk); combined.add(chunk); vertices[1].add(chunk); });
  const onSignal = () => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer = setTimeout(() => { timedOut = true; stop(); }, boundedTimeoutMs).unref();
  let closed;
  try {
    closed = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  const details = { command: binary, exitCode: closed.code, signal: closed.signal, stderr: redacted(stderr.bytes()).slice(-8192), outputTruncated: combined.truncated, durationMs: performance.now() - started, timeoutMs: boundedTimeoutMs };
  if (logFile) await writeFile(logFile, redacted(combined.bytes()), { mode: 0o600 });
  if (timedOut) throw new VerificationError('COMMAND_TIMEOUT', `${binary} exceeded its bounded wait.`, details);
  if (!allowFailure && closed.code !== 0) throw new VerificationError('COMMAND_FAILED', `${binary} failed.`, details);
  if (exactStdout && stdout.truncated) throw new VerificationError('COMMAND_OUTPUT_LIMIT', `${binary} exceeded its exact output limit.`, details);
  return { ...details, stdout: redacted(stdout.bytes()), stderr: redacted(stderr.bytes()), vertices: vertices.flatMap((tracker) => tracker.result()) };
}

async function streamHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { remainingBudget(1); hash.update(chunk); }
  return `sha256:${hash.digest('hex')}`;
}

async function rawManifestDigest(reference) {
  const observed = await run('docker', ['buildx', 'imagetools', 'inspect', reference], { exactStdout: true, timeoutMs: HELPER_TIMEOUT_MS });
  const digest = /^\s*Digest:\s*(sha256:[0-9a-f]{64})\s*$/imu.exec(observed.stdout)?.[1];
  expect(DIGEST.test(digest ?? ''), 'MANIFEST_DIGEST_UNREPORTED', 'Buildx did not report the registry manifest digest.', { reference });
  return digest;
}

async function sourceFingerprint() {
  const hash = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  const excludedDirectory = new Set(['.git', 'node_modules', 'dist']);
  const excludedFile = (relative) => /(?:^|\/)\.env(?:\.|$)/u.test(relative)
    || /(?:\.db|\.sqlite|\.sqlite3)(?:-(?:wal|shm|journal))?$/iu.test(relative);
  const visit = async (absolute, relative) => {
    remainingBudget(1);
    const info = await lstat(absolute);
    expect(!info.isSymbolicLink(), 'SOURCE_SYMLINK', 'Fingerprint inputs must not contain symbolic links.', { path: relative });
    if (info.isDirectory()) {
      if (excludedDirectory.has(path.basename(relative))) return;
      hash.update(`D\0${relative}\0`);
      for (const entry of (await readdir(absolute)).sort()) await visit(path.join(absolute, entry), path.posix.join(relative, entry));
      return;
    }
    expect(info.isFile(), 'SOURCE_TYPE', 'Fingerprint inputs must be regular files.', { path: relative });
    if (excludedFile(relative)) return;
    fileCount += 1;
    totalBytes += info.size;
    expect(fileCount <= 100_000 && totalBytes <= 1_073_741_824, 'SOURCE_LIMIT', 'Fingerprint inputs exceeded their bounded size.', { fileCount, totalBytes });
    hash.update(`F\0${relative}\0${info.size}\0`);
    for await (const chunk of createReadStream(absolute)) { remainingBudget(1); hash.update(chunk); }
  };
  const roots = (await readdir(ROOT)).filter((name) => name === 'Dockerfile' || name.startsWith('Cargo') || name.startsWith('.kache') || ['crates', 'migrations', 'frontend'].includes(name)).sort();
  for (const name of roots) await visit(path.join(ROOT, name), name);
  return { algorithm: 'sha256-path-size-content-v1', digest: `sha256:${hash.digest('hex')}`, fileCount, totalBytes, excluded: ['.git', 'node_modules', 'dist', '.env*', '*.{db,sqlite,sqlite3}{,-wal,-shm,-journal}'] };
}

function absoluteChild(parent, candidate, name) {
  expect(path.isAbsolute(candidate), 'INVALID_PATH', `${name} must be absolute.`);
  const relative = path.relative(parent, candidate);
  expect(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'INVALID_PATH', `${name} must be a distinct child of RUNNER_TEMP.`);
  return path.resolve(candidate);
}

async function requireEnvironment(mode) {
  const jobStartedAtMs = Number(process.env.VERIFY_JOB_STARTED_AT_MS);
  expect(Number.isSafeInteger(jobStartedAtMs) && jobStartedAtMs > 0 && jobStartedAtMs <= Date.now(), 'INVALID_JOB_DEADLINE', 'VERIFY_JOB_STARTED_AT_MS must be a past millisecond timestamp from the Prepare step.');
  workDeadline = jobStartedAtMs + WORK_BUDGET_MS;
  remainingBudget(1);
  expect(process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true', 'NOT_GITHUB_ACTIONS', 'Verification is restricted to GitHub Actions.');
  expect(process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'NOT_HOSTED_RUNNER', 'Verification is restricted to a GitHub-hosted runner.');
  expect(process.env.GITHUB_REPOSITORY?.toLowerCase() === REPOSITORY, 'WRONG_REPOSITORY', `Verification is restricted to ${REPOSITORY}.`);
  expect(SHA.test(process.env.GITHUB_SHA ?? ''), 'INVALID_SOURCE_SHA', 'GITHUB_SHA must be a full commit SHA.');
  expect(/^[1-9][0-9]{0,19}$/u.test(process.env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,9}$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? ''), 'INVALID_PRODUCER', 'GitHub run identity is invalid.');
  expect(process.env.REGISTRY_USERNAME && process.env.REGISTRY_TOKEN, 'MISSING_CREDENTIALS', 'Registry credentials must be supplied through the environment.');
  expect(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_WORKFLOW === 'Cache Verification', 'WRONG_WORKFLOW', 'Verification is restricted to the manual Cache Verification workflow.');
  const runnerTemp = path.resolve(process.env.RUNNER_TEMP ?? '');
  expect(path.isAbsolute(runnerTemp) && runnerTemp !== '/', 'INVALID_RUNNER_TEMP', 'RUNNER_TEMP must be an absolute private workspace.');
  outputDir = absoluteChild(runnerTemp, process.env.VERIFY_OUTPUT_DIR ?? '', 'VERIFY_OUTPUT_DIR');
  workDir = absoluteChild(runnerTemp, process.env.VERIFY_WORK_DIR ?? '', 'VERIFY_WORK_DIR');
  inputDir = absoluteChild(runnerTemp, process.env.VERIFY_INPUT_DIR ?? '', 'VERIFY_INPUT_DIR');
  tmpDir = absoluteChild(runnerTemp, process.env.TMPDIR ?? '', 'TMPDIR');
  expect(new Set([outputDir, workDir, inputDir, tmpDir]).size === 4, 'INVALID_PATH', 'Verification directories must be distinct.');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').map((line) => line.split(' ')).filter((parts) => {
    if (parts.length <= 6) return false;
    const mountpoint = parts[4].replaceAll('\\040', ' ');
    return mountpoint === '/' || tmpDir === mountpoint || tmpDir.startsWith(`${mountpoint}${path.sep}`);
  });
  mounts.sort((a, b) => b[4].length - a[4].length);
  const separator = mounts[0]?.indexOf('-');
  const fsType = separator >= 0 ? mounts[0][separator + 1] : undefined;
  expect(fsType && !['tmpfs', 'ramfs'].includes(fsType), 'TMPFS_FORBIDDEN', 'TMPDIR must be backed by runner disk.', { fsType });
  if (mode !== 'seed') expect(/^[1-9][0-9]{0,19}$/u.test(process.env.VERIFY_SEED_RUN_ID ?? ''), 'INVALID_INPUT_RUN', 'VERIFY_SEED_RUN_ID is required.');
  if (mode === 'retain') expect(/^[1-9][0-9]{0,19}$/u.test(process.env.VERIFY_COMPARE_RUN_ID ?? ''), 'INVALID_INPUT_RUN', 'VERIFY_COMPARE_RUN_ID is required.');
}
function operationLimits() {
  const remaining = remainingBudget(LIMITS.timeoutMs + 10_000);
  expect(remaining > 10_000, 'WORK_DEADLINE', 'Insufficient work budget remains for a bounded cache helper operation.');
  return { ...LIMITS, timeoutMs: Math.min(LIMITS.timeoutMs, remaining - 10_000) };
}

function retentionLimits() {
  return { ...RETENTION_LIMITS, timeoutMs: remainingBudget(RETENTION_LIMITS.timeoutMs) };
}

function registryClient(Class = RegistryClient) {
  const client = new Class({ registry: REGISTRY, repository: CACHE_REPOSITORY, username: process.env.REGISTRY_USERNAME, token: process.env.REGISTRY_TOKEN, limits: operationLimits() });
  const fetchWithTimeout = client.fetchWithTimeout.bind(client);
  client.fetchWithTimeout = (url, options = {}) => fetchWithTimeout(url, { ...options, timeoutMs: Math.min(options.timeoutMs ?? client.limits.timeoutMs, operationLimits().timeoutMs) });
  return client;
}
function refreshClientDeadline(client) {
  client.limits.timeoutMs = operationLimits().timeoutMs;
  return client;
}

async function boundedJson(response, limit = LOG_LIMIT) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    remainingBudget(1);
    size += value.length;
    expect(size <= limit, 'GITHUB_BODY_LIMIT', 'GitHub API response exceeded its bounded size.');
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function packageState({ requireVisible = false } = {}) {
  const endpoints = ['/users/nanazt/packages/container/azuki-build-cache', '/user/packages/container/azuki-build-cache'];
  let last;
  for (let attempt = 1; attempt <= (requireVisible ? 6 : 1); attempt += 1) {
    const probes = [];
    let observed;
    for (const endpoint of endpoints) {
      const response = await fetch(new URL(endpoint, 'https://api.github.com'), {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.REGISTRY_TOKEN}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'azuki-cache-verification' },
        redirect: 'error',
        signal: AbortSignal.timeout(remainingBudget(10_000)),
      });
      remainingBudget(1);
      if (response.status === 200) {
        const value = await boundedJson(response);
        const probe = { endpoint, status: 200, visibility: value?.visibility ?? null, packageType: value?.package_type ?? null, repository: value?.repository?.full_name?.toLowerCase() ?? null, id: value?.id ?? null };
        probes.push(probe);
        expect(value?.name === 'azuki-build-cache' && value.package_type === 'container' && value.visibility === 'private' && probe.repository === REPOSITORY, 'PACKAGE_SCOPE_MISMATCH', 'An observed cache package has unsafe visibility, type, or repository association.', probe);
        observed ??= probe;
      } else {
        probes.push({ endpoint, status: response.status, ambiguity: [403, 404].includes(response.status) ? 'absent-or-inaccessible' : undefined });
        await response.body?.cancel().catch(() => {});
      }
    }
    if (observed) return { status: 'visible', observed, probes };
    last = { status: 'ambiguous', probes };
    expect(probes.every((probe) => [403, 404].includes(probe.status)), 'PACKAGE_PREFLIGHT_FAILED', 'Cache package probes returned an unexpected status.', last);
    if (requireVisible && attempt < 6) await new Promise((resolve) => setTimeout(resolve, remainingBudget(2_000 * attempt)));
  }
  if (!requireVisible) return last;
  throw new VerificationError('PACKAGE_NOT_VISIBLE', 'Published cache package was not observed as the expected private repository-linked container package.', last);
}

function validateInput(value, expectedMode, expectedRunId) {
  expect(value?.mode === expectedMode && value.status === 'passed', 'INVALID_INPUT', `Expected a passed ${expectedMode} result.`);
  expect(value.sourceSha === process.env.GITHUB_SHA && value.producer?.sourceSha === process.env.GITHUB_SHA, 'INPUT_SOURCE_MISMATCH', 'Input source SHA differs from this checkout.');
  expect(value.producer?.repository === REPOSITORY && value.producer?.runId === expectedRunId && /^[1-9][0-9]{0,9}$/u.test(value.producer?.runAttempt ?? ''), 'INPUT_PRODUCER_MISMATCH', 'Input producer identity differs from the downloaded workflow run.');
  expect(DIGEST.test(value.layerCache?.digest ?? '') && value.layerCache.ref === LAYER_REF, 'INVALID_INPUT', 'Input layer cache identity is invalid.');
  expect(DIGEST.test(value.snapshot?.manifestDigest ?? '') && typeof value.snapshot?.immutableRef === 'string', 'INVALID_INPUT', 'Input snapshot identity is invalid.');
  expect(value.sourceFingerprint?.digest && value.tools && value.baseDigests, 'INVALID_INPUT', 'Input parity evidence is incomplete.');
  return value;
}

async function readInput(name, expectedMode, runId) {
  const value = JSON.parse(await readFile(path.join(inputDir, name, 'result.json'), 'utf8'));
  return validateInput(value, expectedMode, runId);
}

async function sampleDisk() {
  const info = await statfs(workDir, { bigint: true }).catch(() => statfs(path.dirname(workDir), { bigint: true }));
  const total = Number(info.blocks * info.bsize);
  const free = Number(info.bavail * info.bsize);
  const used = total - free;
  diskState ??= { totalBytes: total, initialFreeBytes: free, minimumFreeBytes: free, peakUsedBytes: used, sampleCount: 0 };
  diskState.minimumFreeBytes = Math.min(diskState.minimumFreeBytes, free);
  diskState.lastFreeBytes = free;
  diskState.peakUsedBytes = Math.max(diskState.peakUsedBytes, used);
  diskState.sampleCount += 1;
}

async function createBuilder(mode) {
  const name = `azuki-cache-verify-${mode}-${process.env.GITHUB_RUN_ID}-${randomUUID().slice(0, 8)}`.slice(0, 120);
  const collision = await run('docker', ['buildx', 'inspect', name], { allowFailure: true, timeoutMs: 30_000 });
  expect(collision.exitCode !== 0, 'BUILDER_COLLISION', 'Refusing to reuse an existing Buildx builder.', { name });
  await run('docker', ['buildx', 'create', '--name', name, '--driver', 'docker-container'], { timeoutMs: 60_000 });
  owned.builder = name;
  const bootstrapped = await run('docker', ['buildx', 'inspect', name, '--bootstrap'], { timeoutMs: HELPER_TIMEOUT_MS });
  const inspectOutput = `${bootstrapped.stdout}\n${bootstrapped.stderr}`;
  const buildkit = /BuildKit:\s+v?([^\s]+)/u.exec(inspectOutput)?.[1];
  expect(/^\s*Driver:\s+docker-container\s*$/imu.test(inspectOutput) && buildkit, 'BUILDER_BOOTSTRAP_INVALID', 'Owned builder did not report the docker-container driver and BuildKit version.');
  return { name, driver: 'docker-container', buildkit };
}

async function toolVersions(builder) {
  const dockerResult = await run('docker', ['version', '--format', '{{json .}}'], { exactStdout: true, timeoutMs: 30_000 });
  const buildxResult = await run('docker', ['buildx', 'version'], { exactStdout: true, timeoutMs: 30_000 });
  const docker = JSON.parse(dockerResult.stdout);
  const buildx = buildxResult.stdout.trim();
  expect(docker?.Client?.Version && docker?.Server?.Version && buildx, 'TOOL_VERSION_UNREPORTED', 'Docker client, server, or Buildx version was not reported.');
  return { node: process.version, docker, buildx, buildkit: builder.buildkit };
}

async function baseDigests(seed) {
  const refs = ['node:25', 'rust:trixie', 'ubuntu:24.04'];
  if (!seed) {
    const entries = [];
    for (const ref of refs) entries.push([ref, await rawManifestDigest(ref)]);
    return Object.fromEntries(entries);
  }
  for (const ref of refs) expect(DIGEST.test(seed[ref] ?? ''), 'INVALID_INPUT', 'Seed base image digest is invalid.', { ref });
  return Object.fromEntries(refs.map((ref) => [ref, seed[ref]]));
}

function pinDockerfileBases(production, bases) {
  for (const required of ['FROM node:25 AS frontend-builder', 'FROM rust:trixie AS rust-builder', 'FROM ubuntu:24.04 AS runtime']) expect(production.includes(required), 'DOCKERFILE_DRIFT', 'Production Dockerfile base stages no longer match verification.', { required });
  return production
    .replace('FROM node:25 AS frontend-builder', `FROM node:25@${bases['node:25']} AS frontend-builder`)
    .replace('FROM rust:trixie AS rust-builder', `FROM rust:trixie@${bases['rust:trixie']} AS rust-builder`)
    .replace('FROM ubuntu:24.04 AS runtime', `FROM ubuntu:24.04@${bases['ubuntu:24.04']} AS runtime`);
}

function derivedDockerfile(production, bases, nonce) {
  expect(production.includes('cargo build --locked --release --bin azuki'), 'DOCKERFILE_DRIFT', 'Production Dockerfile Cargo build no longer matches the verification derivation.');
  let text = pinDockerfileBases(production, bases)
    .replace('ARG KACHE_LOG\n', 'ARG KACHE_LOG\nARG VERIFY_BUILD_NONCE\nARG EXPECT_KACHE_CONTENT\n');
  const start = text.indexOf('RUN --mount=type=cache,id=azuki-cargo-registry-linux-amd64-v1,target=/usr/local/cargo/registry');
  const end = text.indexOf('\n\n# Stage 3: Runtime', start);
  expect(start >= 0 && end > start, 'DOCKERFILE_DRIFT', 'Could not isolate the production Cargo build step.');
  const cargoRun = `RUN --mount=type=cache,id=azuki-cargo-registry-linux-amd64-v1,target=/usr/local/cargo/registry \\
    --mount=type=cache,id=azuki-cargo-git-linux-amd64-v1,target=/usr/local/cargo/git \\
    --mount=type=cache,id=\${CARGO_TARGET_CACHE_ID},target=/app/target \\
    --mount=type=cache,id=\${KACHE_CACHE_ID},sharing=locked,target=/var/cache/kache \\
    --mount=type=tmpfs,target=/run/kache \\
    set -eux; \\
    test "\${VERIFY_BUILD_NONCE}" = "${nonce}"; \\
    test -z "$(find /app/target -mindepth 1 -print -quit)"; \\
    test -z "$(find /usr/local/cargo/registry -mindepth 1 -print -quit)"; \\
    test -z "$(find /usr/local/cargo/git -mindepth 1 -print -quit)"; \\
    if [ "\${EXPECT_KACHE_CONTENT}" = nonempty ]; then test -n "$(find /var/cache/kache -mindepth 1 -print -quit)"; else test -z "$(find /var/cache/kache -mindepth 1 -print -quit)"; fi; \\
    export KACHE_EVENT_ROOT=/app; \\
    echo VERIFY_CARGO_RUN_STARTED; \\
    cargo build --locked --release --bin azuki; \\
    install -m 0755 /app/target/release/azuki /usr/local/bin/azuki; \\
    mkdir -p /verify; \\
    kache report --format json --last-build --root /app > /verify/kache-report.json; \\
    echo VERIFY_CARGO_RUN_DONE; \\
    snapshot_ready=true; touch /var/cache/kache/.snapshot-uncertain; \\
    if ! timeout --signal=TERM --kill-after=5s 120s kache gc --json; then snapshot_ready=false; echo "warning: bounded kache synchronous GC failed; cache snapshot remains ineligible" >&2; fi; \\
    if ! timeout --signal=TERM --kill-after=5s 15s kache daemon stop; then snapshot_ready=false; echo "warning: bounded kache daemon shutdown request failed; cache snapshot remains ineligible" >&2; fi; \\
    if ! timeout --signal=TERM --kill-after=5s 50s flock --exclusive --wait 45 /run/kache/daemon.run.lock true; then snapshot_ready=false; echo "warning: kache daemon did not finish draining; cache snapshot remains ineligible" >&2; fi; \\
    if [ "\${snapshot_ready}" = true ]; then rm -f /var/cache/kache/.snapshot-uncertain; fi`;
  text = `${text.slice(0, start)}${cargoRun}${text.slice(end)}\n\nFROM scratch AS verification-report\nCOPY --from=rust-builder /verify/kache-report.json /kache-report.json\n`;
  return text;
}

function cargoStepStatus(execution) {
  expect(execution.vertices.length === 1, 'CARGO_STEP_UNOBSERVED', 'Build output did not identify exactly one instrumented Cargo RUN vertex.', { vertices: execution.vertices });
  return execution.vertices[0].status ?? 'UNKNOWN';
}

function reportSummary(report, expectedSeedCount, mode) {
  expect(report?.schema_version === 1 && report?.meta?.kache_version === '0.20.0' && Array.isArray(report.all_events), 'REPORT_SCHEMA', 'Kache report schema or version is unexpected.');
  const events = report.all_events;
  for (const event of events) {
    expect(Number.isSafeInteger(event?.compiler_runs) && event.compiler_runs >= 0 && Number.isSafeInteger(event?.dep_info_runs) && event.dep_info_runs >= 0, 'REPORT_EVENT_INVALID', 'A report event has invalid compiler_runs or dep_info_runs counts.');
  }
  const rust = events.filter((event) => event.dep_info_runs > 0);
  const native = events.filter((event) => event.dep_info_runs === 0);
  const classify = (items) => {
    const resultCounts = {};
    for (const event of items) resultCounts[String(event?.result)] = (resultCounts[String(event?.result)] ?? 0) + 1;
    return {
      actionCount: items.length,
      localHits: items.filter((event) => event?.result === 'local_hit').length,
      misses: items.filter((event) => Number.isFinite(event?.compiler_runs) && event.compiler_runs > 0).length,
      compilerRuns: items.reduce((sum, event) => sum + (Number.isFinite(event?.compiler_runs) ? event.compiler_runs : 0), 0),
      depInfoRuns: items.reduce((sum, event) => sum + (Number.isFinite(event?.dep_info_runs) ? event.dep_info_runs : 0), 0),
      resultCounts,
    };
  };
  const summary = { schemaVersion: report.schema_version, kacheVersion: report.meta.kache_version, rust: classify(rust), native: classify(native) };
  expect(summary.rust.actionCount > 0, 'NO_RUST_ACTIONS', 'Kache report did not classify any Rust actions through dep_info_runs.');
  if (expectedSeedCount !== undefined) expect(summary.rust.actionCount === expectedSeedCount, 'RUST_ACTION_PARITY', 'Rust action count differs from the seed.', { expected: expectedSeedCount, actual: summary.rust.actionCount });
  if (mode === 'warm' || mode === 'retain') expect(summary.rust.localHits > 0 && summary.rust.compilerRuns === 0, 'WARM_CACHE_MISS', 'Warm verification requires positive Rust local hits and zero Rust compiler runs.', { rust: summary.rust });
  else expect(summary.rust.compilerRuns > 0, 'COMPILER_NOT_RUN', 'Cold or fault verification requires real Rust compiler execution.', { rust: summary.rust });
  return summary;
}

async function probeCache(cacheId, label, populated) {
  const directory = await mkdtemp(path.join(workDir, `probe-${label}-`));
  const file = path.join(directory, 'Dockerfile');
  const test = populated ? 'test -n' : 'test -z';
  await writeFile(file, `# syntax=docker/dockerfile:1\nFROM ${TRANSFER_IMAGE}\nARG NONCE\nRUN --mount=type=cache,id=${cacheId},sharing=locked,target=/var/cache/kache set -eu; : "\${NONCE}"; ${test} "$(find /var/cache/kache -mindepth 1 -print -quit)"\n`, { mode: 0o600 });
  await run('docker', ['buildx', 'build', '--builder', owned.builder, '--file', file, '--progress', 'plain', '--build-arg', `NONCE=${randomUUID()}`, '--output', 'type=cacheonly', directory], { timeoutMs: HELPER_TIMEOUT_MS });
  await rm(directory, { recursive: true, force: true });
}

async function childOperation(operation, request) {
  const currentProducer = { repository: REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, sourceSha: process.env.GITHUB_SHA };
  if (operation === 'publish' || operation === 'retention') expect(JSON.stringify(request.producer) === JSON.stringify(currentProducer), 'CHILD_PRODUCER_MISMATCH', 'Child mutation producer must equal the current GitHub run identity.');
  if (operation !== 'retention') {
    expect(request.builder?.startsWith(`azuki-cache-verify-${request.mode}-${process.env.GITHUB_RUN_ID}-`) && request.cacheId?.endsWith(`-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`), 'CHILD_RESOURCE_MISMATCH', 'Child helper resources must belong to the current verification run.');
  }
  const common = { client: registryClient(), compatibility: COMPATIBILITY, limits: operationLimits() };
  class SnapshotRedirectClient extends RegistryClient {
    async getManifest(reference, options) {
      if (reference !== COMPATIBILITY.fixedRef) return super.getManifest(reference, options);
      expect(DIGEST.test(request.snapshotDigest ?? ''), 'FAULT_SNAPSHOT_DIGEST_INVALID', 'Fault restore requires the exact seed snapshot digest.');
      const observed = await super.getManifest(request.snapshotDigest, options);
      expect(observed?.digest === request.snapshotDigest, 'FAULT_SNAPSHOT_MISMATCH', 'Exact seed snapshot digest did not resolve as requested.', { expected: request.snapshotDigest, actual: observed?.digest ?? null });
      return observed;
    }
  }
  if (operation === 'restore') {
    const client = request.mode === 'fault' ? registryClient(SnapshotRedirectClient) : common.client;
    return restoreSnapshot({ ...common, client, builder: request.builder, cacheId: request.cacheId, cacheTarget: '/var/cache/kache', transferImage: TRANSFER_IMAGE, secrets: [process.env.REGISTRY_TOKEN] });
  }
  if (operation === 'fault-restore') {
    class CorruptingClient extends SnapshotRedirectClient {
      async downloadBlob(digest, destination, expectedSize) {
        await super.downloadBlob(digest, destination, expectedSize);
        expect(expectedSize > 3, 'FAULT_PAYLOAD_TOO_SMALL', 'Fault injection requires a nontrivial verified gzip payload.', { expectedSize });
        const handle = await open(destination, 'r+');
        try {
          const byte = Buffer.alloc(1);
          await handle.read(byte, 0, 1, 2);
          byte[0] ^= 0x01;
          await handle.write(byte, 0, 1, 2);
        } finally { await handle.close(); }
      }
    }
    try {
      await restoreSnapshot({ ...common, client: registryClient(CorruptingClient), builder: request.builder, cacheId: request.cacheId, cacheTarget: '/var/cache/kache', transferImage: TRANSFER_IMAGE, secrets: [process.env.REGISTRY_TOKEN] });
    } catch (error) {
      expect(['INVALID_GZIP_PAYLOAD', 'DECOMPRESSED_PAYLOAD_MISMATCH'].includes(error?.code), 'FAULT_WRONG_FAILURE', 'Fault restore failed outside verified gzip rejection.', { observedCode: error?.code ?? null });
      return { status: 'expected-failure', error: safeError(error), corruption: 'post-download-gzip-compression-method-byte-flip-at-offset-2' };
    }
    throw new VerificationError('FAULT_NOT_DETECTED', 'Corrupted verified download unexpectedly restored.');
  }
  if (operation === 'publish') {
    expect(request.expectedFixedDigest === null || DIGEST.test(request.expectedFixedDigest ?? ''), 'CHILD_FIXED_GUARD_INVALID', 'Publish child requires the previously observed fixed-reference digest.');
    class GuardedClient extends RegistryClient {
      async putManifest(reference, bytes) {
        if (reference === COMPATIBILITY.fixedRef) {
          const observed = await this.getManifest(reference, { missing: true });
          expect((observed?.digest ?? null) === request.expectedFixedDigest, 'SNAPSHOT_REPOINTED', 'Fixed snapshot reference changed before promotion.', { expected: request.expectedFixedDigest, actual: observed?.digest ?? null });
        }
        return super.putManifest(reference, bytes);
      }
    }
    return publishSnapshot({ ...common, client: registryClient(GuardedClient), builder: request.builder, cacheId: request.cacheId, cacheTarget: '/var/cache/kache', transferImage: TRANSFER_IMAGE, producer: request.producer, secrets: [process.env.REGISTRY_TOKEN] });
  }
  if (operation === 'retention') {
    const limits = retentionLimits();
    const github = new GitHubRetentionClient({ token: process.env.REGISTRY_TOKEN, registry: common.client.registry, limits });
    return runPostPublicationRetention({ client: common.client, github, compatibility: COMPATIBILITY, producer: request.producer, limits });
  }
  throw new VerificationError('CHILD_USAGE', 'Unknown child operation.');
}

async function invokeHelper(operation, request) {
  const started = performance.now();
  let status = 'failed';
  try {
    const directory = await mkdtemp(path.join(workDir, `helper-${operation}-`));
    const requestFile = path.join(directory, 'request.json');
    const responseFile = path.join(directory, 'response.json');
    await writeFile(requestFile, JSON.stringify({ mode: result.mode, ...request }), { mode: 0o600 });
    await run(process.execPath, [fileURLToPath(import.meta.url), '--child', operation, requestFile, responseFile], { timeoutMs: HELPER_TIMEOUT_MS });
    const response = JSON.parse(await readFile(responseFile, 'utf8'));
    await rm(directory, { recursive: true, force: true });
    if (!response.ok) throw new VerificationError(response.error.code, response.error.message, response.error.details);
    status = 'passed';
    return response.value;
  } finally {
    timings.helperOperations.push({ operation, status, durationMs: performance.now() - started });
  }
}

async function inspectRuntime(image, mode) {
  const container = `azuki-cache-verify-${mode}-${randomUUID().slice(0, 8)}`;
  await run('docker', ['create', '--name', container, image], { timeoutMs: 60_000 });
  owned.containers.add(container);
  const files = { appBinary: '/usr/local/bin/azuki', frontendIndex: '/app/frontend/dist/index.html', ytdlp: '/usr/local/bin/yt-dlp' };
  const hashes = {};
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(workDir, `${mode}-${name}`);
    await run('docker', ['cp', `${container}:${source}`, destination], { timeoutMs: 60_000 });
    hashes[name] = await streamHash(destination);
    await rm(destination, { force: true });
  }
  await run('docker', ['rm', '-f', '-v', container], { timeoutMs: 60_000 });
  owned.containers.delete(container);
  await run('docker', ['image', 'rm', image], { timeoutMs: 60_000 });
  owned.images.delete(image);
  return hashes;
}

async function packageInventory(client, maximumMs = RETENTION_LIMITS.timeoutMs) {
  const timeoutMs = remainingBudget(Math.min(RETENTION_LIMITS.timeoutMs, maximumMs));
  client.limits = { ...client.limits, timeoutMs: remainingBudget(Math.min(LIMITS.timeoutMs, maximumMs)) };
  const limits = { ...RETENTION_LIMITS, timeoutMs };
  const github = new GitHubRetentionClient({ token: process.env.REGISTRY_TOKEN, registry: client.registry, limits });
  const deadline = Date.now() + limits.timeoutMs;
  return (await github.listPackageVersions(REPOSITORY, CACHE_REPOSITORY, deadline)).map((version) => ({ id: version.id, digest: version.name, tags: version.metadata?.container?.tags ?? [], createdAt: version.created_at }));
}
async function waitInventory(client, requiredDigests) {
  let inventory;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    inventory = await packageInventory(client);
    if (requiredDigests.every((digest) => inventory.some((version) => version.digest === digest))) return inventory;
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, remainingBudget(attempt * 2_000)));
  }
  throw new VerificationError('PACKAGE_INVENTORY_STALE', 'GitHub package inventory did not expose the newly published snapshot and receipt before retention.', { requiredDigests });
}

async function waitRetentionPropagation(client, expected) {
  const deadline = Date.now() + remainingBudget(90_000);
  let lastObservation = null;
  let lastError = null;
  let attempts = 0;
  const propagationClient = () => {
    const remaining = deadline - Date.now();
    expect(remaining > 0, 'RETENTION_PROPAGATION_TIMEOUT', 'Bounded post-delete observation deadline expired.');
    client.limits = { ...client.limits, timeoutMs: remainingBudget(Math.min(LIMITS.timeoutMs, remaining)) };
    return client;
  };
  while (attempts < 8 && Date.now() < deadline) {
    attempts += 1;
    try {
      const inventory = await packageInventory(client, deadline - Date.now());
      const seed = await propagationClient().getManifest(expected.seedRef, { missing: true });
      const current = await propagationClient().getManifest(expected.currentRef);
      const predecessor = await propagationClient().getManifest(expected.predecessorRef);
      lastObservation = {
        attempts,
        inventory,
        references: {
          seed: seed?.digest ?? null,
          current: current.digest,
          predecessor: predecessor.digest,
        },
      };
      const seedVersionsAbsent = !inventory.some((version) => version.digest === expected.seedDigest || version.digest === expected.seedReceiptDigest);
      if (seedVersionsAbsent && seed === null && current.digest === expected.currentDigest && predecessor.digest === expected.predecessorDigest) return lastObservation;
    } catch (error) {
      lastError = safeError(error);
    }
    if (attempts < 8 && Date.now() < deadline) {
      const delay = Math.min(attempts * 2_000, deadline - Date.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, remainingBudget(delay)));
    }
  }
  throw new VerificationError('RETENTION_PROPAGATION_TIMEOUT', 'Bounded post-delete reads did not observe the seed snapshot and receipt absent while the protected snapshots remained resolvable.', { lastObservation, lastError });
}

async function cleanup() {
  await sampleDisk().catch(() => {});
  cleanupDeadline = Date.now() + CLEANUP_BUDGET_MS;
  if (result?.resources?.deadlines) result.resources.deadlines.cleanupDeadlineMs = cleanupDeadline;
  const errors = [];
  for (const container of [...owned.containers]) {
    try { await run('docker', ['rm', '-f', '-v', container], { timeoutMs: 60_000, budget: 'cleanup' }); owned.containers.delete(container); } catch (error) { errors.push(safeError(error)); }
  }
  for (const image of [...owned.images]) {
    try { await run('docker', ['image', 'rm', image], { timeoutMs: 60_000, budget: 'cleanup' }); owned.images.delete(image); } catch (error) { errors.push(safeError(error)); }
  }
  if (owned.builder) {
    try { await run('docker', ['buildx', 'rm', owned.builder], { timeoutMs: HELPER_TIMEOUT_MS, budget: 'cleanup' }); owned.builder = null; } catch (error) { errors.push(safeError(error)); }
  }
  if (workDir) {
    try { await rm(workDir, { recursive: true, force: true }); } catch (error) { errors.push(safeError(error)); }
  }
  if (tmpDir) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch (error) { errors.push(safeError(error)); }
  }
  await sampleDisk().catch(() => {});
  if (diskState) diskState.peakAdditionalUsedBytes = diskState.initialFreeBytes - diskState.minimumFreeBytes;
  return errors;
}

async function verify(mode) {
  await requireEnvironment(mode);
  expect(compatibilityRef(COMPATIBILITY) === COMPATIBILITY.fixedRef, 'FIXED_REF_DRIFT', 'Compatibility reference differs from the production fixed reference.');
  const checkout = (await run('git', ['rev-parse', 'HEAD'], { exactStdout: true, timeoutMs: 30_000 })).stdout.trim();
  expect(checkout === process.env.GITHUB_SHA, 'CHECKOUT_MISMATCH', 'Current checkout does not equal GITHUB_SHA.', { checkout });
  const producer = { repository: REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, sourceSha: process.env.GITHUB_SHA };
  const started = performance.now();
  timings.jobStartedAtMs = Number(process.env.VERIFY_JOB_STARTED_AT_MS);
  result = { mode, status: 'running', sourceSha: process.env.GITHUB_SHA, producer, baseDigests: {}, layerCache: { ref: LAYER_REF, digest: null }, snapshot: { manifestDigest: null, immutableRef: null }, report: null, timings, images: {}, resources: { deadlines: { workBudgetMs: WORK_BUDGET_MS, workDeadlineMs: workDeadline, cleanupBudgetMs: CLEANUP_BUDGET_MS }, diskSampling: { intervalMs: DISK_SAMPLE_INTERVAL_MS, measurement: 'sampled filesystem used/free bytes; peak is the largest observed sample' }, limits: { helper: LIMITS, helperOuterTimeoutMs: HELPER_TIMEOUT_MS, commandTimeoutMs: COMMAND_TIMEOUT_MS, logBytes: LOG_LIMIT, retention: RETENTION_LIMITS }, stopConditions: ['32-minute shared work deadline anchored at Prepare', 'separate 3-minute cleanup budget', 'process-group SIGTERM then SIGKILL after 5s', 'helper outer deadline at most 15 minutes', 'bounded 1 MiB command evidence', 'no global builder selection or prune'] } };
  await sampleDisk();
  diskTimer = setInterval(() => { void sampleDisk().catch((error) => { if (diskState) diskState.sampleErrors = (diskState.sampleErrors ?? 0) + 1; }); }, DISK_SAMPLE_INTERVAL_MS).unref();
  result.resources.packageBefore = await packageState();
  result.sourceFingerprint = await sourceFingerprint();
  const seed = mode === 'seed' ? null : await readInput('seed', 'seed', process.env.VERIFY_SEED_RUN_ID);
  const warm = mode === 'retain' ? await readInput('warm', 'warm', process.env.VERIFY_COMPARE_RUN_ID) : null;
  if (warm) {
    expect(warm.layerCache.digest === seed.layerCache.digest && JSON.stringify(warm.baseDigests) === JSON.stringify(seed.baseDigests) && JSON.stringify(warm.sourceFingerprint) === JSON.stringify(seed.sourceFingerprint) && JSON.stringify(warm.tools) === JSON.stringify(seed.tools) && JSON.stringify(warm.images) === JSON.stringify(seed.images), 'WARM_INPUT_PARITY', 'Warm input does not preserve seed source, tool, layer, base, and selected runtime artifact hash parity.');
  }
  const parityInput = seed;
  if (parityInput) expect(JSON.stringify(result.sourceFingerprint) === JSON.stringify(parityInput.sourceFingerprint), 'SOURCE_PARITY', 'Source input fingerprint differs from the seed.');
  const builder = await createBuilder(mode);
  result.resources.builder = builder;
  result.tools = await toolVersions(builder);
  if (parityInput) expect(JSON.stringify(result.tools) === JSON.stringify(parityInput.tools), 'TOOL_PARITY', 'Node, Docker, Buildx, or BuildKit version differs from the seed.');
  result.baseDigests = await baseDigests(seed?.baseDigests);
  if (seed) expect(JSON.stringify(result.baseDigests) === JSON.stringify(seed.baseDigests), 'BASE_PARITY', 'Base image digests differ from the seed.');
  const client = registryClient();
  const expectedPrevious = mode === 'warm' ? seed : mode === 'retain' ? warm : null;
  const readsMutableFixedRef = mode === 'seed' || mode === 'warm' || mode === 'retain';
  const initial = readsMutableFixedRef ? await resolveSnapshot(refreshClientDeadline(client), COMPATIBILITY) : null;
  if (expectedPrevious) expect(initial?.manifestDigest === expectedPrevious.snapshot.manifestDigest, 'SNAPSHOT_REPOINTED', 'Fixed snapshot reference does not match the expected prior run.', { expected: expectedPrevious.snapshot.manifestDigest, actual: initial?.manifestDigest ?? null });
  const guardedDigest = initial?.manifestDigest ?? null;
  result.resources.fixedRefBefore = readsMutableFixedRef ? { manifestDigest: guardedDigest, producer: initial?.metadata?.producer ?? null } : { status: 'not-read', reason: 'immutable-seed-input-only' };
  let cacheId;
  let restore;
  if (mode === 'warm' || mode === 'retain') {
    cacheId = `azuki-kache-verify-${mode}-${producer.runId}-${producer.runAttempt}`;
    restore = await invokeHelper('restore', { builder: builder.name, cacheId });
    expect(restore.status === 'restored' && restore.manifestDigest === expectedPrevious.snapshot.manifestDigest && JSON.stringify(restore.producer) === JSON.stringify(expectedPrevious.producer), 'RESTORE_MISMATCH', 'Restored snapshot does not match the expected producer and digest.');
  } else if (mode === 'fault') {
    const failedId = `azuki-kache-verify-failed-${producer.runId}-${producer.runAttempt}`;
    const populated = await invokeHelper('restore', { builder: builder.name, cacheId: failedId, snapshotDigest: seed.snapshot.manifestDigest });
    expect(populated.status === 'restored' && populated.manifestDigest === seed.snapshot.manifestDigest && JSON.stringify(populated.producer) === JSON.stringify(seed.producer), 'FAULT_SETUP_RESTORE_MISMATCH', 'Fault setup did not populate the mount from the exact seed snapshot and producer.');
    await probeCache(failedId, 'populated-before-fault', true);
    restore = await invokeHelper('fault-restore', { builder: builder.name, cacheId: failedId, snapshotDigest: seed.snapshot.manifestDigest });
    expect(restore.status === 'expected-failure', 'FAULT_NOT_DETECTED', 'Fault restore did not fail as expected.');
    await probeCache(failedId, 'cleared-after-fault', false);
    cacheId = `azuki-kache-verify-fallback-${producer.runId}-${producer.runAttempt}`;
    await probeCache(cacheId, 'fallback', false);
    result.resources.fault = { failedRestoreCacheId: failedId, fallbackCacheId: cacheId, populated, restore };
  } else {
    cacheId = `azuki-kache-verify-${mode}-${producer.runId}-${producer.runAttempt}`;
  }
  result.resources.cacheId = cacheId;
  if (restore && mode !== 'fault') result.resources.restore = restore;
  if (seed) {
    const importedLayerDigest = await rawManifestDigest(`ghcr.io/${CACHE_REPOSITORY}@${seed.layerCache.digest}`);
    expect(importedLayerDigest === seed.layerCache.digest, 'LAYER_CACHE_MISMATCH', 'Exact seed layer cache manifest is not resolvable.');
  }
  const nonce = randomUUID();
  const productionDockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerfile = path.join(workDir, 'Dockerfile.verify');
  await writeFile(dockerfile, derivedDockerfile(productionDockerfile, result.baseDigests, nonce), { mode: 0o600 });
  const image = `azuki-cache-verify:${mode}-${producer.runId}-${producer.runAttempt}`;
  const targetCacheId = `azuki-target-verify-${mode}-${producer.runId}-${producer.runAttempt}`;
  const commonBuild = ['buildx', 'build', '--builder', builder.name, '--platform', 'linux/amd64', '--file', dockerfile, '--progress', 'plain', '--build-arg', `KACHE_CACHE_ID=${cacheId}`, '--build-arg', `CARGO_TARGET_CACHE_ID=${targetCacheId}`, '--build-arg', 'KACHE_MAX_SIZE=3GiB', '--build-arg', `VERIFY_BUILD_NONCE=${nonce}`, '--build-arg', `EXPECT_KACHE_CONTENT=${mode === 'warm' || mode === 'retain' ? 'nonempty' : 'empty'}`];
  if (seed) commonBuild.push('--cache-from', `type=registry,ref=ghcr.io/${CACHE_REPOSITORY}@${seed.layerCache.digest}`);
  else commonBuild.push('--cache-from', `type=registry,ref=${LAYER_REF}`);
  const buildLog = path.join(outputDir, 'build.log');
  const buildArgs = [...commonBuild, '--target', 'runtime', '--load', '--tag', image];
  buildArgs.push(ROOT);
  const buildStarted = performance.now();
  const built = await run('docker', buildArgs, { logFile: buildLog });
  owned.images.add(image);
  timings.buildMs = performance.now() - buildStarted;
  const buildCargoStatus = cargoStepStatus(built);
  result.resources.buildEvidence = { log: 'build.log', outputTruncated: built.outputTruncated, cargoVertexStatus: buildCargoStatus };
  expect(buildCargoStatus === 'DONE', 'CARGO_STEP_NOT_EXECUTED', 'The actual application Cargo RUN was not completed.');
  const reportDirectory = path.join(workDir, 'report-export');
  await mkdir(reportDirectory, { mode: 0o700 });
  const reportLog = path.join(outputDir, 'report-build.log');
  const reportBuild = await run('docker', [...commonBuild, '--target', 'verification-report', '--output', `type=local,dest=${reportDirectory}`, ROOT], { logFile: reportLog });
  const reportCargoStatus = cargoStepStatus(reportBuild);
  expect(reportCargoStatus === 'CACHED', 'REPORT_EXPORT_REBUILT', 'Report export did not reuse the completed Cargo RUN.');
  result.resources.reportEvidence = { log: 'report-build.log', report: 'kache-report.json', outputTruncated: reportBuild.outputTruncated, cargoVertexStatus: reportCargoStatus };
  const rawReportPath = path.join(reportDirectory, 'kache-report.json');
  expect((await stat(rawReportPath)).size <= LOG_LIMIT, 'REPORT_LIMIT', 'Kache report exceeded the 1 MiB evidence limit.');
  const rawReport = JSON.parse(await readFile(rawReportPath, 'utf8'));
  result.report = reportSummary(rawReport, seed?.report?.rust?.actionCount, mode);
  await cp(rawReportPath, path.join(outputDir, 'kache-report.json'));
  result.images = await inspectRuntime(image, mode);
  if (seed) expect(JSON.stringify(result.images) === JSON.stringify(seed.images), 'IMAGE_PARITY', 'Selected runtime artifact hashes (app binary, frontend index, or yt-dlp) differ from the seed.', { expected: seed.images, actual: result.images });
  if (mode === 'seed') {
    const productionLayerDockerfile = path.join(workDir, 'Dockerfile.production-layer');
    await writeFile(productionLayerDockerfile, pinDockerfileBases(productionDockerfile, result.baseDigests), { mode: 0o600 });
    const productionLayerLog = path.join(outputDir, 'production-layer-export.log');
    const productionLayerStarted = performance.now();
    const exported = await run('docker', ['buildx', 'build', '--builder', builder.name, '--platform', 'linux/amd64', '--file', productionLayerDockerfile, '--progress', 'plain', '--build-arg', `KACHE_CACHE_ID=${cacheId}`, '--build-arg', `CARGO_TARGET_CACHE_ID=${targetCacheId}`, '--build-arg', 'KACHE_MAX_SIZE=3GiB', '--output', 'type=cacheonly', '--cache-to', `type=registry,ref=${LAYER_REF},mode=max`, ROOT], { logFile: productionLayerLog });
    timings.productionLayerExportMs = performance.now() - productionLayerStarted;
    result.resources.productionLayerExport = { log: 'production-layer-export.log', outputTruncated: exported.outputTruncated, dockerfile: 'production Dockerfile with FROM digests pinned; Cargo RUN unchanged' };
    result.layerCache.digest = await rawManifestDigest(LAYER_REF);
  } else {
    result.layerCache.digest = seed.layerCache.digest;
  }
  if (mode === 'seed' || mode === 'warm' || mode === 'retain') {
    const beforePublish = await resolveSnapshot(refreshClientDeadline(client), COMPATIBILITY);
    expect((beforePublish?.manifestDigest ?? null) === guardedDigest, 'SNAPSHOT_REPOINTED', 'Fixed snapshot reference changed while verification was running.', { expected: guardedDigest, actual: beforePublish?.manifestDigest ?? null });
    let inventoryBeforePublication;
    if (mode === 'retain') inventoryBeforePublication = await packageInventory(client);
    const publication = await invokeHelper('publish', { builder: builder.name, cacheId, producer, expectedFixedDigest: guardedDigest });
    result.snapshot = { manifestDigest: publication.manifestDigest, immutableRef: publication.immutableRef, fixedRef: publication.fixedRef, payloadDigest: publication.payloadDigest, receipt: publication.receipt };
    result.resources.publication = { transferBytes: publication.transferBytes, tarBytes: publication.tarBytes, payloadFileBytes: publication.payloadFileBytes, fileCount: publication.fileCount, timingMs: publication.timingMs };
    expect(publication.publication === 'promoted' && publication.receipt?.status === 'acknowledged' && publication.retention?.status === 'not-run', 'PUBLICATION_INCOMPLETE', 'Snapshot publication, receipt, or no-retention contract was not confirmed.', { publication: publication.publication, receipt: publication.receipt?.status, retention: publication.retention });
    result.resources.packageAfterPublication = await packageState({ requireVisible: true });
    if (mode === 'seed' || mode === 'warm') {
      try {
        result.resources.packageInventoryAfterPublication = { status: 'available', versions: await packageInventory(client) };
      } catch (error) {
        result.resources.packageInventoryAfterPublication = { status: 'unavailable', error: safeError(error) };
      }
    }
    if (mode === 'retain') {
      const inventoryBeforeRetention = await waitInventory(client, [publication.manifestDigest, publication.receipt.digest]);
      const retention = await invokeHelper('retention', { producer });
      result.resources.retention = { result: retention, versionsBeforePublication: inventoryBeforePublication, versionsBeforeRetention: inventoryBeforeRetention, versionsAfter: null, propagation: null };
      expect(retention.status === 'completed' && retention.warnings?.length === 0, 'RETENTION_INCOMPLETE', 'Receipt-backed retention did not complete cleanly.', retention);
      expect(retention.currentDigest === publication.manifestDigest && retention.predecessorDigest === warm.snapshot.manifestDigest, 'RETENTION_PROTECTION_MISMATCH', 'Retention protected the wrong current or predecessor snapshot.', retention);
      const deletedSeed = retention.deleted.find((entry) => entry.snapshotDigest === seed.snapshot.manifestDigest);
      expect(deletedSeed?.receiptDeleted === true && DIGEST.test(deletedSeed.receiptDigest ?? ''), 'RETENTION_DID_NOT_DELETE_SEED', 'Retention did not acknowledge deletion of the completed seed snapshot and receipt.', retention);
      const propagation = await waitRetentionPropagation(client, {
        seedDigest: seed.snapshot.manifestDigest,
        seedReceiptDigest: deletedSeed.receiptDigest,
        seedRef: seed.snapshot.immutableRef,
        currentDigest: publication.manifestDigest,
        currentRef: publication.immutableRef,
        predecessorDigest: warm.snapshot.manifestDigest,
        predecessorRef: warm.snapshot.immutableRef,
      });
      result.resources.retention.versionsAfter = propagation.inventory;
      result.resources.retention.propagation = { attempts: propagation.attempts, references: propagation.references };
      result.resources.packageAfterRetention = await packageState({ requireVisible: true });
    }
  } else {
    result.snapshot = { manifestDigest: seed.snapshot.manifestDigest, immutableRef: seed.snapshot.immutableRef, fixedRef: COMPATIBILITY.fixedRef, publication: 'not-run' };
  }
  result.status = 'passed';
  timings.totalMs = performance.now() - started;
}

async function main() {
  if (process.argv[2] === '--child') {
    const [, , , operation, requestFile, responseFile] = process.argv;
    try {
      const request = JSON.parse(await readFile(requestFile, 'utf8'));
      expect(MODES.has(request.mode), 'CHILD_USAGE', 'Child request mode is invalid.');
      await requireEnvironment(request.mode);
      const allowed = { restore: ['warm', 'fault', 'retain'], 'fault-restore': ['fault'], publish: ['seed', 'warm', 'retain'], retention: ['retain'] };
      expect(allowed[operation]?.includes(request.mode), 'CHILD_USAGE', 'Child operation is not allowed for this verification mode.');
      const value = await childOperation(operation, request);
      await writeFile(responseFile, JSON.stringify({ ok: true, value }), { mode: 0o600 });
    } catch (error) {
      await writeFile(responseFile, JSON.stringify({ ok: false, error: safeError(error) }), { mode: 0o600 });
    }
    return;
  }
  const mode = process.argv[2];
  let failure;
  try {
    expect(process.argv.length === 3 && MODES.has(mode), 'USAGE', 'Usage: node scripts/verify-remote-docker-cache.mjs MODE (seed|warm|control|fault|retain)');
    await verify(mode);
  } catch (error) {
    failure = safeError(error);
    result ??= { mode, status: 'failed', sourceSha: process.env.GITHUB_SHA ?? null, producer: { repository: REPOSITORY, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, sourceSha: process.env.GITHUB_SHA ?? null }, baseDigests: {}, layerCache: { ref: LAYER_REF, digest: null }, snapshot: { manifestDigest: null, immutableRef: null }, report: null, timings, images: {}, resources: {} };
    result.status = 'failed';
    result.error = failure;
  } finally {
    clearInterval(diskTimer);
    const cleanupStarted = performance.now();
    const cleanupErrors = await cleanup().catch((error) => [safeError(error)]);
    timings.cleanupMs = performance.now() - cleanupStarted;
    if (result) {
      result.resources ??= {};
      result.resources.disk = diskState ?? null;
      result.resources.cleanup = { completed: cleanupErrors.length === 0, errors: cleanupErrors };
      if (cleanupErrors.length && result.status === 'passed') {
        result.status = 'failed';
        result.error = { code: 'CLEANUP_FAILED', message: 'Owned temporary resources were not fully removed.', details: { errors: cleanupErrors } };
        failure = result.error;
      }
      if (outputDir) await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    }
  }
  if (failure) {
    console.error(`[${failure.code}] ${failure.message}`);
    process.exitCode = 1;
  }
}

await main();

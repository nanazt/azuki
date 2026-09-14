#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KACHE_VERSION = '0.20.0';
const TRANSFER_IMAGE = 'docker.io/library/debian:trixie-slim@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f';
const FIXED_REF = 'kache-linux-amd64-s1-kache-0.20.0';
const CACHE_TARGET = '/var/cache/kache';
const RESULT = 'cache-regression-ok';
const OUTPUT_LIMIT = 128 * 1024;
const SHORT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 600_000;

class IntegrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.details = details;
  }
}

function usage() {
  return `Usage: node scripts/test-docker-cache-integration.mjs --kache /absolute/path/to/kache\n\nThe test only accepts a local Unix-socket Docker endpoint and creates disposable Docker resources.`;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--kache') throw new IntegrationError(usage());
  if (!path.isAbsolute(argv[1])) throw new IntegrationError('--kache must be an absolute path.');
  return { kache: argv[1] };
}

function commandText(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(' ');
}

function outputTail(output) {
  return output.toString('utf8').slice(-8_192);
}

async function run(command, args, {
  cwd,
  env = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
  allowFailure = false,
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputBytes = 0;
  let timedOut = false;
  let overflow = false;
  let killTimer;
  const terminate = (signal = 'SIGTERM') => {
    if (!child.pid) return;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    terminate();
    killTimer ??= setTimeout(() => terminate('SIGKILL'), 2_000).unref();
  };
  const collect = (current, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > OUTPUT_LIMIT) {
      overflow = true;
      stop();
      return current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs).unref();
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    throw new IntegrationError(`Could not start required command: ${commandText(command, args)}`, { cause: error?.message ?? String(error) });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
  const result = { ...outcome, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  if (timedOut) throw new IntegrationError(`Command timed out after ${timeoutMs}ms: ${commandText(command, args)}`, result);
  if (overflow) throw new IntegrationError(`Command exceeded its ${OUTPUT_LIMIT}-byte log limit: ${commandText(command, args)}`, result);
  if (!allowFailure && outcome.code !== 0) {
    throw new IntegrationError(`Command failed: ${commandText(command, args)}`, result);
  }
  return result;
}

function commandEnvironment() {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.REGISTRY_TOKEN;
  delete env.AZUKI_CACHE_INTEGRATION_GITHUB_TOKEN;
  return env;
}

async function requireKache(kachePath) {
  await access(kachePath, 0o1).catch(() => {
    throw new IntegrationError(`The --kache file is not executable: ${kachePath}`);
  });
  const metadata = await stat(kachePath);
  if (!metadata.isFile()) throw new IntegrationError(`The --kache path is not a regular file: ${kachePath}`);
  const resolved = await realpath(kachePath);
  const version = await run(resolved, ['--version'], { timeoutMs: SHORT_TIMEOUT_MS });
  const observedOutput = `${version.stdout}\n${version.stderr}`;
  const observedVersion = /^\s*kache(?:\s+version)?\s+v?([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/imu.exec(observedOutput)?.[1];
  if (observedVersion !== KACHE_VERSION) {
    throw new IntegrationError(`--kache must be version ${KACHE_VERSION}.`, { observed: outputTail(Buffer.from(observedOutput)) });
  }
  return resolved;
}

async function requireLocalDocker() {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) {
    throw new IntegrationError(`Refusing nonlocal Docker endpoint from DOCKER_HOST: ${process.env.DOCKER_HOST}`);
  }
  const context = (await run('docker', ['context', 'show'], { timeoutMs: SHORT_TIMEOUT_MS })).stdout.trim();
  if (!context) throw new IntegrationError('Docker did not report an active context.');
  const endpointResult = await run('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], { timeoutMs: SHORT_TIMEOUT_MS });
  let endpoint;
  try {
    endpoint = JSON.parse(endpointResult.stdout.trim());
  } catch {
    throw new IntegrationError(`Docker context ${context} did not expose a readable endpoint.`, { output: outputTail(Buffer.from(endpointResult.stdout)) });
  }
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) {
    throw new IntegrationError(`Refusing Docker context ${context} because its endpoint is not a local Unix socket.`, { endpoint });
  }
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: SHORT_TIMEOUT_MS });
  await run('docker', ['buildx', 'version'], { timeoutMs: SHORT_TIMEOUT_MS });
  return { context, endpoint };
}

function buildkitConfig(registryHost) {
  return `[registry.${JSON.stringify(registryHost)}]\n  http = true\n  insecure = true\n`;
}

function fixtureDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM rust:trixie AS build
COPY kache /usr/local/bin/kache
COPY Cargo.toml /workspace/Cargo.toml
COPY src/main.rs /workspace/src/main.rs
WORKDIR /workspace
ARG KACHE_CACHE_ID
ARG CARGO_TARGET_CACHE_ID
ARG SNAPSHOT_NONCE
RUN --mount=type=cache,id=\${KACHE_CACHE_ID},sharing=locked,target=/var/cache/kache \
    --mount=type=cache,id=\${CARGO_TARGET_CACHE_ID},sharing=locked,target=/workspace/target \
    --mount=type=tmpfs,target=/run/kache \
    set -eu; \
    test -z "$(find /workspace/target -mindepth 1 -print -quit)"; \
    : "\${SNAPSHOT_NONCE}"; \
    chmod 0755 /usr/local/bin/kache; \
    export RUSTC_WRAPPER=/usr/local/bin/kache KACHE_CACHE_DIR=/var/cache/kache KACHE_RUNTIME_DIR=/run/kache KACHE_LOCAL_ONLY=true KACHE_AUTO_GC=false KACHE_PREFETCH_ENABLED=false KACHE_LOCAL_HIT_DAEMON=false KACHE_ADAPTIVE_INCREMENTAL=false KACHE_EVENT_ROOT=/workspace; \
    cargo build --release --offline; \
    /workspace/target/release/cache-fixture > /out-result; \
    mkdir /out; \
    mv /out-result /out/result; \
    kache report --format json --last-build --root /workspace > /out/kache-report.json; \
    touch /var/cache/kache/.snapshot-uncertain; \
    timeout --signal=TERM --kill-after=5s 120s kache gc --json; \
    timeout --signal=TERM --kill-after=5s 15s kache daemon stop; \
    timeout --signal=TERM --kill-after=5s 50s flock --exclusive --wait 45 /run/kache/daemon.run.lock true; \
    rm -f /var/cache/kache/.snapshot-uncertain; \
    find /var/cache/kache -mindepth 1 -type f -print -quit > /out/store-file; \
    test -s /out/store-file
FROM scratch
COPY --from=build /out/ /
`;
}

function mountProbeDockerfile(cacheId) {
  return `# syntax=docker/dockerfile:1
FROM ${TRANSFER_IMAGE} AS probe
ARG SNAPSHOT_NONCE
RUN --mount=type=cache,id=${cacheId},sharing=locked,target=${CACHE_TARGET} set -eu; : "\${SNAPSHOT_NONCE}"; mkdir /out; find ${CACHE_TARGET} -mindepth 1 -type f -print -quit > /out/restored-store-file; test -s /out/restored-store-file
FROM scratch
COPY --from=probe /out/ /
`;
}

async function writeFixture(directory, kachePath) {
  await copyFile(kachePath, path.join(directory, 'kache'));
  await writeFile(path.join(directory, 'Cargo.toml'), '[package]\nname = "cache-fixture"\nversion = "0.1.0"\nedition = "2024"\n');
  await writeFile(path.join(directory, 'src', 'main.rs'), `fn main() { println!("${RESULT}"); }\n`);
  await writeFile(path.join(directory, 'Dockerfile'), fixtureDockerfile());
}

function verifyReport(report) {
  const summary = report?.summary;
  if (report?.schema_version !== 1 || report?.meta?.kache_version !== KACHE_VERSION) {
    throw new IntegrationError('kache emitted an unexpected report schema or version.', { report });
  }
  if (!Number.isFinite(summary?.local_hits) || summary.local_hits <= 0) {
    throw new IntegrationError('kache report did not record a restored local cache hit.', { summary });
  }
  if (!Array.isArray(report.all_events) || !report.all_events.some((event) => event?.result === 'local_hit' && event.compiler_runs === 0 && Number.isFinite(event.size) && event.size > 0)) {
    throw new IntegrationError('kache report contains no valid local_hit event for the restored build.', { events: report.all_events });
  }
  return summary;
}

async function waitForRegistry(registry) {
  const deadline = Date.now() + SHORT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${registry}/v2/`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`registry returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new IntegrationError(`Local registry at ${registry} did not become ready.`, { cause: lastError?.message });
}

async function dockerPort(name) {
  const result = await run('docker', ['port', name, '5000/tcp'], { timeoutMs: SHORT_TIMEOUT_MS });
  const match = /^127\.0\.0\.1:(\d+)$/mu.exec(result.stdout.trim());
  if (!match) throw new IntegrationError('Registry was not bound exclusively to loopback.', { output: outputTail(Buffer.from(result.stdout)) });
  return `127.0.0.1:${match[1]}`;
}

async function createBuilder(name, config) {
  await run('docker', ['buildx', 'create', '--name', name, '--driver', 'docker-container', '--driver-opt', 'network=host', '--buildkitd-config', config], { timeoutMs: COMMAND_TIMEOUT_MS });
  await run('docker', ['buildx', 'inspect', '--bootstrap', name], { timeoutMs: COMMAND_TIMEOUT_MS });
}

async function buildFixture({ builder, context, cacheId, targetId, output }) {
  await rm(output, { recursive: true, force: true });
  await run('docker', [
    'buildx', 'build', '--builder', builder, '--progress', 'plain',
    '--build-arg', `KACHE_CACHE_ID=${cacheId}`,
    '--build-arg', `CARGO_TARGET_CACHE_ID=${targetId}`,
    '--build-arg', `SNAPSHOT_NONCE=${randomUUID()}`,
    '--output', `type=local,dest=${output}`,
    context,
  ], { timeoutMs: BUILD_TIMEOUT_MS });
}

async function probeRestoredMount({ builder, context, cacheId, output }) {
  await rm(output, { recursive: true, force: true });
  const probe = path.join(context, 'Probe.Dockerfile');
  await writeFile(probe, mountProbeDockerfile(cacheId));
  await run('docker', [
    'buildx', 'build', '--builder', builder, '--file', probe, '--progress', 'plain',
    '--build-arg', `SNAPSHOT_NONCE=${randomUUID()}`,
    '--output', `type=local,dest=${output}`,
    context,
  ], { timeoutMs: BUILD_TIMEOUT_MS });
  const restored = (await readFile(path.join(output, 'restored-store-file'), 'utf8')).trim();
  if (!restored) throw new IntegrationError('Restore completed but the builder B kache mount is empty.');
  return restored;
}

function helperArguments(command, common) {
  return [
    command,
    '--registry', `http://${common.registry}`,
    '--repository', common.cacheRepository,
    '--platform', 'linux/amd64',
    '--kache-version', KACHE_VERSION,
    '--schema-version', '1',
    '--fixed-ref', FIXED_REF,
    '--builder', common.builder,
    '--cache-id', common.cacheId,
    '--cache-target', CACHE_TARGET,
    '--transfer-image', TRANSFER_IMAGE,
    '--max-transfer-bytes', String(256 * 1024 * 1024),
    '--max-unpacked-bytes', String(256 * 1024 * 1024),
    '--max-disk-bytes', String(384 * 1024 * 1024),
    '--max-files', '10000',
    '--max-metadata-bytes', String(128 * 1024),
    '--max-command-output-bytes', String(OUTPUT_LIMIT),
    '--timeout-ms', String(COMMAND_TIMEOUT_MS),
  ];
}

async function invokeHelper(command, common) {
  const args = helperArguments(command, common);
  if (command === 'publish') {
    args.push(
      '--producer-repository', common.producerRepository,
      '--run-id', String(Date.now()),
      '--run-attempt', '1',
      '--source-sha', '0123456789abcdef0123456789abcdef01234567',
      '--github-token-env', 'AZUKI_CACHE_INTEGRATION_GITHUB_TOKEN',
    );
  }
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docker-cache.mjs');
  const result = await run(process.execPath, [helper, ...args], { env: commandEnvironment(), timeoutMs: BUILD_TIMEOUT_MS });
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    throw new IntegrationError(`Production helper emitted invalid JSON during ${command}.`, { output: outputTail(Buffer.from(result.stdout)), stderr: outputTail(Buffer.from(result.stderr)) });
  }
  if (payload?.status === 'failed') throw new IntegrationError(`Production helper reported ${command} failure: ${payload.message ?? 'unknown error'}`, payload);
  if (command === 'publish' && !result.stderr.includes('[GITHUB_TOKEN_MISSING]')) {
    throw new IntegrationError('Publish did not report its intentional no-GitHub-token retention skip.', { stderr: outputTail(Buffer.from(result.stderr)) });
  }
  return payload;
}

async function cleanup(resources) {
  const failures = [];
  const attempt = async (label, args) => {
    try {
      const result = await run('docker', args, { timeoutMs: SHORT_TIMEOUT_MS, allowFailure: true });
      if (result.code !== 0) {
        failures.push(`${label}: ${outputTail(Buffer.from(`${result.stdout}\n${result.stderr}`))}`);
      }
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };
  if (resources.builderB) await attempt('builder B', ['buildx', 'rm', '--force', resources.builderB]);
  if (resources.builderA) await attempt('builder A', ['buildx', 'rm', '--force', resources.builderA]);
  if (resources.registry) await attempt('registry', ['rm', '--force', resources.registry]);
  if (resources.workspace) {
    try {
      await rm(resources.workspace, { recursive: true, force: true });
    } catch (error) {
      failures.push(`workspace: ${error.message}`);
    }
  }
  return failures;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const kache = await requireKache(options.kache);
  await requireLocalDocker();
  const suffix = `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const resources = { workspace: await mkdtemp(path.join(tmpdir(), `azuki-cache-integration-${suffix}-`)) };
  let primaryError;
  try {
    const fixture = path.join(resources.workspace, 'fixture');
    const outputA = path.join(resources.workspace, 'output-a');
    const outputB = path.join(resources.workspace, 'output-b');
    const probeOutput = path.join(resources.workspace, 'probe-output');
    await mkdir(path.join(fixture, 'src'), { recursive: true });
    await writeFixture(fixture, kache);

    resources.registry = `azuki-cache-it-registry-${suffix}`;
    resources.builderA = `azuki-cache-it-a-${suffix}`;
    resources.builderB = `azuki-cache-it-b-${suffix}`;
    await run('docker', ['run', '--name', resources.registry, '--rm', '--detach', '--tmpfs', '/var/lib/registry', '--publish', '127.0.0.1::5000', 'registry:2'], { timeoutMs: BUILD_TIMEOUT_MS });
    const registry = await dockerPort(resources.registry);
    await waitForRegistry(registry);

    const configA = path.join(resources.workspace, 'buildkitd-a.toml');
    const configB = path.join(resources.workspace, 'buildkitd-b.toml');
    await writeFile(configA, buildkitConfig(registry));
    await writeFile(configB, buildkitConfig(registry));
    await createBuilder(resources.builderA, configA);
    await createBuilder(resources.builderB, configB);

    const producerRepository = `azuki-it-${suffix.replaceAll('-', '')}/cache-fixture`;
    const cacheRepository = `${producerRepository}-build-cache`;
    const cacheId = `azuki-it-kache-${suffix}`;
    await buildFixture({ builder: resources.builderA, context: fixture, cacheId, targetId: `azuki-it-target-a-${suffix}`, output: outputA });

    const publish = await invokeHelper('publish', {
      registry,
      cacheRepository,
      producerRepository,
      builder: resources.builderA,
      cacheId,
    });
    const restore = await invokeHelper('restore', {
      registry,
      cacheRepository,
      builder: resources.builderB,
      cacheId,
    });
    const restoredStoreFile = await probeRestoredMount({ builder: resources.builderB, context: fixture, cacheId, output: probeOutput });
    await buildFixture({ builder: resources.builderB, context: fixture, cacheId, targetId: `azuki-it-target-b-${suffix}`, output: outputB });

    const actualResult = (await readFile(path.join(outputB, 'result'), 'utf8')).trim();
    if (actualResult !== RESULT) throw new IntegrationError('The restored-builder fixture did not run the expected compiled binary.', { actualResult });
    let report;
    try {
      report = JSON.parse(await readFile(path.join(outputB, 'kache-report.json'), 'utf8'));
    } catch (error) {
      throw new IntegrationError('kache did not emit valid structured JSON for the restored build.', { cause: error.message });
    }
    const reportSummary = verifyReport(report);

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      registry: `http://${registry}`,
      cacheRepository,
      restoredStoreFile,
      report: reportSummary,
      publish,
      restore,
    })}\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures = await cleanup(resources);
    if (cleanupFailures.length > 0) {
      const message = `Integration cleanup had failures: ${cleanupFailures.join('; ')}`;
      if (primaryError) process.stderr.write(`${message}\n`);
      else throw new IntegrationError(message);
    }
  }
}

function formatFailure(error) {
  const details = error?.details;
  if (!details || typeof details !== 'object') return error?.message ?? String(error);
  const { stdout, stderr, ...metadata } = details;
  const sections = [error?.message ?? String(error)];
  if (Object.keys(metadata).length > 0) sections.push(`details: ${outputTail(Buffer.from(JSON.stringify(metadata)))}`);
  if (stderr) sections.push(`stderr (tail):\n${outputTail(Buffer.from(stderr))}`);
  if (stdout) sections.push(`stdout (tail):\n${outputTail(Buffer.from(stdout))}`);
  return sections.join('\n');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${formatFailure(error)}\n`);
  process.exitCode = 1;
});

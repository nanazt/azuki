#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants, createGunzip, createGzip } from 'node:zlib';

export const SNAPSHOT_KIND = 'io.github.nanazt.azuki.kache-snapshot';
export const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
export const CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
export const LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';
export const RECEIPT_KIND = 'io.github.nanazt.azuki.kache-publication-receipt';
export const RECEIPT_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION_LIMITS = Object.freeze({
  targetSnapshots: 2,
  maxPages: 10,
  maxVersions: 500,
  perPage: 100,
  timeoutMs: 60_000,
  maxWarnings: 8,
});
export const DEFAULT_LIMITS = Object.freeze({
  maxTransferBytes: 4 * 1024 * 1024 * 1024,
  maxUnpackedBytes: 4 * 1024 * 1024 * 1024,
  maxDiskBytes: 12 * 1024 * 1024 * 1024,
  maxFiles: 1_000_000,
  maxMetadataBytes: 1024 * 1024,
  maxCommandOutputBytes: 1024 * 1024,
  timeoutMs: 30 * 60 * 1000,
});

const TAR_BLOCK = 512;
const PAYLOAD_STREAM_CHUNK_BYTES = 1024 * 1024;
const ZERO_BLOCKS = Buffer.alloc(TAR_BLOCK * 2);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REGISTRY_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REGISTRY_REDIRECT_LIMIT = 5;
const GHCR_BLOB_ORIGIN = 'https://pkg-containers.githubusercontent.com';
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const CACHE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const DOCKER_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_INDEX_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.list.v2+json';

export class CacheTransportError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'CacheTransportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}, options = {}) {
  throw new CacheTransportError(code, message, details, options);
}

function expect(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sanitizeTagPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

export function compatibilityRef({ platform, schemaVersion, kacheVersion }) {
  validateCompatibility({ platform, schemaVersion, kacheVersion });
  return `kache-${sanitizeTagPart(platform.replace('/', '-'))}-s${schemaVersion}-kache-${sanitizeTagPart(kacheVersion)}`;
}

function validateCompatibility({ platform, schemaVersion, kacheVersion }) {
  expect(PLATFORM_PATTERN.test(platform), 'INVALID_PLATFORM', 'Platform must be an explicit os/architecture pair.', { platform });
  expect(Number.isSafeInteger(schemaVersion) && schemaVersion > 0, 'INVALID_SCHEMA', 'Schema version must be a positive integer.', { schemaVersion });
  expect(VERSION_PATTERN.test(kacheVersion), 'INVALID_KACHE_VERSION', 'Kache version must be explicit SemVer without a leading v.', { kacheVersion });
}

function validateMount({ builder, cacheId, cacheTarget, transferImage, registry }) {
  expect(typeof builder === 'string' && builder.length > 0 && builder.length <= 128, 'INVALID_BUILDER', 'Buildx builder name is required.');
  expect(CACHE_ID_PATTERN.test(cacheId), 'INVALID_CACHE_ID', 'Cache mount ID contains unsupported characters.', { cacheId });
  expect(path.posix.isAbsolute(cacheTarget), 'INVALID_CACHE_TARGET', 'Cache target must be an absolute POSIX path.', { cacheTarget });
  expect(!cacheTarget.split('/').includes('..') && /^\/[A-Za-z0-9._/-]+$/u.test(cacheTarget), 'INVALID_CACHE_TARGET', 'Cache target contains an unsafe path component.', { cacheTarget });
  expect(typeof transferImage === 'string' && transferImage.length > 0 && transferImage.length <= 512, 'INVALID_TRANSFER_IMAGE', 'Transfer image is required.');
  if (!registry.isLoopback) {
    expect(/@sha256:[0-9a-f]{64}$/u.test(transferImage), 'UNPINNED_TRANSFER_IMAGE', 'Production transfer images must be pinned by sha256 digest.');
  }
}

function positiveInteger(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  expect(Number.isSafeInteger(parsed) && parsed > 0, 'INVALID_LIMIT', `${name} must be a positive safe integer.`, { name, value });
  return parsed;
}

function normalizeLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_LIMITS)) limits[key] = positiveInteger(limits[key], key);
  expect(limits.maxTransferBytes <= DEFAULT_LIMITS.maxTransferBytes, 'INVALID_LIMIT', 'Compressed transfer limit cannot exceed 4 GiB.');
  expect(limits.maxUnpackedBytes <= DEFAULT_LIMITS.maxUnpackedBytes, 'INVALID_LIMIT', 'Raw tar and payload file limits cannot exceed 4 GiB.');
  expect(limits.maxDiskBytes <= DEFAULT_LIMITS.maxDiskBytes, 'INVALID_LIMIT', 'Aggregate staging disk limit cannot exceed 12 GiB.');
  expect(limits.maxDiskBytes >= limits.maxTransferBytes, 'INVALID_LIMIT', 'Disk limit must cover at least one bounded transfer.');
  return limits;
}

function normalizeRegistryUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('INVALID_REGISTRY', 'Registry must be an absolute origin URL.', { registry: raw });
  }
  expect(url.username === '' && url.password === '' && url.pathname.replaceAll('/', '') === '' && url.search === '' && url.hash === '', 'INVALID_REGISTRY', 'Registry URL must contain only an origin.', { registry: raw });
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  expect(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback), 'INSECURE_REGISTRY', 'Plain HTTP is allowed only for a loopback registry fixture.', { registry: raw });
  expect(isLoopback || url.origin === 'https://ghcr.io', 'UNTRUSTED_REGISTRY', 'Production snapshots are restricted to the configured GHCR origin.', { registry: raw });
  return { origin: url.origin, isLoopback };
}

function registryBlobRedirect(location, base, registry, blobPath) {
  if (typeof location !== 'string' || location.trim() === '' || location.includes('#')) {
    fail('REGISTRY_REDIRECT', 'Registry blob redirect was rejected.');
  }
  let target;
  try {
    target = new URL(location, base);
  } catch {
    fail('REGISTRY_REDIRECT', 'Registry blob redirect was rejected.');
  }
  const hostname = target.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const safeUrl = target.username === '' && target.password === '' && target.hash === '';
  const trustedOrigin = registry.isLoopback
    ? loopback && (target.protocol === 'http:' || target.protocol === 'https:')
    : target.origin === registry.origin || target.origin === GHCR_BLOB_ORIGIN;
  expect(safeUrl && trustedOrigin, 'REGISTRY_REDIRECT', 'Registry blob redirect was rejected.');
  expect(target.origin !== registry.origin || target.pathname === blobPath, 'REGISTRY_REDIRECT', 'Registry blob redirect was rejected.');
  return target;
}

function validateRepository(repository) {
  expect(REPOSITORY_PATTERN.test(repository), 'INVALID_REPOSITORY', 'Registry repository must be a lower-case namespaced path.', { repository });
}

function producerRepositoryForCache(cacheRepository) {
  validateRepository(cacheRepository);
  const parts = cacheRepository.split('/');
  expect(parts.length === 2, 'UNSAFE_CACHE_SCOPE', 'Snapshot operations require an exact owner/build-cache repository path.');
  const packageName = parts.at(-1);
  expect(packageName.endsWith('-build-cache') && packageName.length > '-build-cache'.length, 'UNSAFE_CACHE_SCOPE', 'Snapshot operations require a dedicated producer build-cache repository.');
  parts[parts.length - 1] = packageName.slice(0, -'-build-cache'.length);
  const producerRepository = parts.join('/');
  validateRepository(producerRepository);
  return producerRepository;
}

function validateCacheScope(client, producerRepository) {
  const expectedProducer = producerRepositoryForCache(client.repository);
  if (producerRepository !== undefined) {
    expect(expectedProducer === producerRepository, 'UNSAFE_CACHE_SCOPE', 'Cache repository must equal producer.repository plus the build-cache suffix.');
  }
  return expectedProducer;
}
function validateProducer(producer) {
  expect(producer && typeof producer === 'object', 'INVALID_PRODUCER', 'Producer identity is required.');
  validateRepository(producer.repository);
  expect(producer.repository.split('/').length === 2, 'INVALID_PRODUCER', 'Producer repository must be an exact GitHub owner/repository pair.');
  expect(/^[1-9][0-9]{0,19}$/u.test(producer.runId), 'INVALID_PRODUCER', 'Producer run ID must be a bounded positive decimal string.');
  expect(/^[1-9][0-9]{0,9}$/u.test(producer.runAttempt), 'INVALID_PRODUCER', 'Producer run attempt must be a bounded positive decimal string.');
  expect(SOURCE_SHA_PATTERN.test(producer.sourceSha), 'INVALID_PRODUCER', 'Producer source SHA must be exactly 40 lower-case hex characters.');
}


function validateReference(reference, name = 'reference') {
  expect(REFERENCE_PATTERN.test(reference), 'INVALID_REFERENCE', `${name} is not a valid OCI tag.`, { reference });
}

function encodeReference(value) {
  return encodeURIComponent(value);
}

const responseDeadlines = new WeakMap();

function finishResponse(response) {
  const deadline = responseDeadlines.get(response);
  if (deadline) {
    clearTimeout(deadline.timer);
    responseDeadlines.delete(response);
  }
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } finally {
    finishResponse(response);
  }
}

async function readBounded(response, limit, label) {
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const size = Number(declared);
      expect(Number.isSafeInteger(size) && size >= 0 && size <= limit, 'RESPONSE_LIMIT', `${label} exceeds its declared size limit.`, { declared: size, limit });
    }
    const chunks = [];
    let size = 0;
    if (!response.body) return Buffer.alloc(0);
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > limit) {
        await response.body.cancel().catch(() => {});
        fail('RESPONSE_LIMIT', `${label} exceeded its streaming size limit.`, { observed: size, limit });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (responseDeadlines.get(response)?.controller.signal.aborted) {
      fail('REGISTRY_TIMEOUT', `${label} exceeded its bounded wait.`);
    }
    throw error;
  } finally {
    finishResponse(response);
  }
}

function parseBearerChallenge(value) {
  if (!value?.startsWith('Bearer ')) return null;
  const fields = {};
  for (const match of value.slice(7).matchAll(/([A-Za-z]+)="([^"]*)"(?:,\s*)?/gu)) fields[match[1].toLowerCase()] = match[2];
  return fields.realm ? fields : null;
}

function registryScopeKey(scope) {
  // Scope entries and their actions are unordered, but resource names and permission sets remain distinct.
  return (scope ?? '').split(/\s+/u).filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf(':');
    if (separator < 0) return entry;
    const actions = entry.slice(separator + 1).split(',').sort().join(',');
    return `${entry.slice(0, separator + 1)}${actions}`;
  }).sort().join(' ');
}

export class RegistryClient {
  constructor({ registry, repository, username, token, limits = {} }) {
    this.registry = normalizeRegistryUrl(registry);
    validateRepository(repository);
    expect((username === undefined) === (token === undefined), 'INVALID_CREDENTIALS', 'Registry username and token must be supplied together.');
    this.repository = repository;
    this.username = username;
    this.token = token;
    this.limits = normalizeLimits(limits);
    this.bearerTokens = new Map();
    this.scopeTokens = new Map();
  }

  endpoint(suffix) {
    return new URL(`/v2/${this.repository}/${suffix}`, this.registry.origin);
  }

  assertRegistryLocation(location, base) {
    const url = new URL(location, base);
    expect(url.origin === this.registry.origin, 'REGISTRY_REDIRECT', 'Registry upload redirected outside its authenticated origin.', { origin: url.origin });
    expect(url.pathname.startsWith(`/v2/${this.repository}/`), 'REGISTRY_REDIRECT', 'Registry upload redirected outside its repository.', { path: url.pathname });
    return url;
  }

  async bearerToken(challenge, scope, timeoutMs = this.limits.timeoutMs) {
    const realm = new URL(challenge.realm);
    const realmHost = realm.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    const loopbackRealm = ['localhost', '127.0.0.1', '::1'].includes(realmHost);
    expect(realm.protocol === 'https:' || (this.registry.isLoopback && loopbackRealm && realm.protocol === 'http:'), 'AUTH_REALM', 'Registry authentication realm is not trusted.', { realm: realm.origin });
    if (!this.registry.isLoopback) expect(realm.hostname === new URL(this.registry.origin).hostname, 'AUTH_REALM', 'Production registry authentication must stay on the registry host.', { realm: realm.origin });
    const effectiveScope = challenge.scope || scope;
    const scopeKey = registryScopeKey(effectiveScope);
    const key = `${realm.href}\n${challenge.service || ''}\n${scopeKey}`;
    if (this.bearerTokens.has(key)) return this.bearerTokens.get(key);
    if (challenge.service) realm.searchParams.set('service', challenge.service);
    if (effectiveScope) realm.searchParams.set('scope', effectiveScope);
    const headers = {};
    if (this.token !== undefined) headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`;
    const response = await this.fetchWithTimeout(realm, { headers, redirect: 'error', timeoutMs });
    const body = await readBounded(response, this.limits.maxMetadataBytes, 'registry auth response');
    expect(response.ok, 'AUTH_FAILED', 'Registry token exchange failed.', { status: response.status });
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      fail('AUTH_FAILED', 'Registry token exchange returned invalid JSON.');
    }
    const value = parsed.token ?? parsed.access_token;
    expect(typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024, 'AUTH_FAILED', 'Registry token exchange returned no bounded token.');
    this.bearerTokens.set(key, value);
    this.scopeTokens.set(scopeKey, value);
    return value;
  }

  async fetchWithTimeout(url, { timeoutMs = this.limits.timeoutMs, ...options }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('registry request timeout')), Math.min(timeoutMs, this.limits.timeoutMs)).unref();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      responseDeadlines.set(response, { controller, timer });
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) fail('REGISTRY_TIMEOUT', 'Registry request exceeded its bounded wait.', { method: options.method ?? 'GET', origin: url.origin });
      fail('REGISTRY_IO', 'Registry request failed.', { method: options.method ?? 'GET', origin: url.origin, reason: errorMessage(error) });
    }
  }

  async request(url, { method = 'GET', headers = {}, body, expected = [200], scope = `repository:${this.repository}:pull`, maxErrorBytes = 64 * 1024, timeoutMs = this.limits.timeoutMs } = {}) {
    const target = url instanceof URL ? url : this.endpoint(url);
    expect(target.origin === this.registry.origin, 'REGISTRY_ORIGIN', 'Registry request escaped the configured origin.');
    const blobPrefix = `/v2/${this.repository}/blobs/`;
    const blobDigest = target.pathname.startsWith(blobPrefix) ? target.pathname.slice(blobPrefix.length) : '';
    const redirectableBlob = method === 'GET'
      && target.search === ''
      && target.hash === ''
      && SHA256_PATTERN.test(blobDigest);
    const requestDeadline = Date.now() + Math.min(timeoutMs, this.limits.timeoutMs);
    const requestTimeout = () => {
      const remaining = requestDeadline - Date.now();
      expect(remaining > 0, 'REGISTRY_TIMEOUT', 'Registry request exceeded its total bounded wait.', { method, origin: target.origin });
      return remaining;
    };
    const requestHeaders = { ...headers };
    const knownBearer = this.scopeTokens.get(registryScopeKey(scope));
    if (knownBearer) requestHeaders.authorization = `Bearer ${knownBearer}`;
    else if (this.token !== undefined) requestHeaders.authorization = `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`;
    let current = target;
    let response = await this.fetchWithTimeout(current, { method, headers: requestHeaders, body, duplex: body ? 'half' : undefined, redirect: 'manual', timeoutMs: requestTimeout() });
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (challenge) {
        const replayable = body === undefined || typeof body?.getReader !== 'function';
        await discardResponse(response);
        expect(replayable, 'AUTH_REPLAY_UNSAFE', 'Registry challenged a streaming request before authentication was established.');
        requestHeaders.authorization = `Bearer ${await this.bearerToken(challenge, scope, requestTimeout())}`;
        response = await this.fetchWithTimeout(current, { method, headers: requestHeaders, body, duplex: body ? 'half' : undefined, redirect: 'manual', timeoutMs: requestTimeout() });
      }
    }
    let redirects = 0;
    let crossedOrigin = false;
    while (REGISTRY_REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await discardResponse(response);
      expect(redirectableBlob, 'REGISTRY_REDIRECT', 'Registry blob redirect was rejected.');
      expect(redirects < REGISTRY_REDIRECT_LIMIT, 'REGISTRY_REDIRECT_LIMIT', 'Registry blob redirect limit was exceeded.');
      const redirected = registryBlobRedirect(location, current, this.registry, target.pathname);
      if (redirected.origin !== current.origin) crossedOrigin = true;
      current = redirected;
      redirects += 1;
      response = await this.fetchWithTimeout(current, {
        method,
        headers: crossedOrigin ? {} : requestHeaders,
        redirect: 'manual',
        timeoutMs: requestTimeout(),
      });
    }
    if (!expected.includes(response.status)) {
      if (redirects > 0) {
        const status = response.status;
        await discardResponse(response);
        fail('REGISTRY_STATUS', 'Registry returned an unexpected status after a blob redirect.', { method, status, repository: this.repository });
      }
      const errorBody = await readBounded(response, maxErrorBytes, 'registry error response').catch(() => Buffer.alloc(0));
      fail('REGISTRY_STATUS', 'Registry returned an unexpected status.', {
        method,
        status: response.status,
        repository: this.repository,
        response: errorBody.toString('utf8').slice(0, 1024),
      });
    }
    return response;
  }

  async blobExists(digest, size) {
    const response = await this.request(`blobs/${digest}`, { method: 'HEAD', expected: [200, 404] });
    try {
      if (response.status === 404) return false;
      const declared = Number(response.headers.get('content-length'));
      expect(Number.isSafeInteger(declared) && declared === size, 'BLOB_SIZE_MISMATCH', 'Existing registry blob has an unexpected size.', { digest, expected: size, actual: declared });
      return true;
    } finally {
      finishResponse(response);
    }
  }

  async uploadBlob({ digest, size, bodyFactory }) {
    expect(SHA256_PATTERN.test(digest), 'INVALID_DIGEST', 'Blob digest is invalid.', { digest });
    expect(Number.isSafeInteger(size) && size >= 0 && size <= this.limits.maxTransferBytes, 'TRANSFER_LIMIT', 'Blob exceeds upload limit.', { size });
    if (await this.blobExists(digest, size)) return;
    const scope = `repository:${this.repository}:pull,push`;
    const started = await this.request('blobs/uploads/', { method: 'POST', expected: [202], scope });
    const startedLocation = started.headers.get('location');
    const startedUrl = started.url || this.registry.origin;
    await discardResponse(started);
    expect(startedLocation, 'REGISTRY_PROTOCOL', 'Registry did not return an upload location.');
    const upload = this.assertRegistryLocation(startedLocation, startedUrl);
    const patched = await this.request(upload, {
      method: 'PATCH',
      headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
      body: bodyFactory(),
      expected: [202],
      scope,
    });
    const patchedLocation = patched.headers.get('location') || upload.href;
    const patchedUrl = patched.url || upload.href;
    await discardResponse(patched);
    const completed = this.assertRegistryLocation(patchedLocation, patchedUrl);
    completed.searchParams.set('digest', digest);
    const committed = await this.request(completed, { method: 'PUT', headers: { 'content-length': '0' }, expected: [201], scope });
    await discardResponse(committed);
    expect(await this.blobExists(digest, size), 'BLOB_VERIFY_FAILED', 'Uploaded blob could not be verified.', { digest });
  }

  async uploadBytes(bytes) {
    expect(bytes.length <= this.limits.maxMetadataBytes, 'METADATA_LIMIT', 'Metadata blob exceeds its limit.');
    const digest = sha256Buffer(bytes);
    await this.uploadBlob({ digest, size: bytes.length, bodyFactory: () => bytes });
    return { digest, size: bytes.length };
  }

  async uploadFile(file, digest, size) {
    await this.uploadBlob({ digest, size, bodyFactory: () => Readable.toWeb(createReadStream(file)) });
  }

  async putManifest(reference, bytes) {
    validateReference(reference);
    expect(bytes.length <= this.limits.maxMetadataBytes, 'METADATA_LIMIT', 'OCI manifest exceeds its limit.');
    const response = await this.request(`manifests/${encodeReference(reference)}`, {
      method: 'PUT',
      headers: { 'content-length': String(bytes.length), 'content-type': MANIFEST_MEDIA_TYPE },
      body: bytes,
      expected: [201],
      scope: `repository:${this.repository}:pull,push`,
    });
    await discardResponse(response);
    return sha256Buffer(bytes);
  }

  async getManifest(reference, { missing = false, timeoutMs = this.limits.timeoutMs } = {}) {
    const response = await this.request(`manifests/${encodeReference(reference)}`, {
      headers: { accept: MANIFEST_MEDIA_TYPE },
      expected: missing ? [200, 404] : [200],
      timeoutMs,
    });
    if (response.status === 404) {
      await discardResponse(response);
      return null;
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim();
    const bytes = await readBounded(response, this.limits.maxMetadataBytes, 'OCI manifest');
    expect(contentType === MANIFEST_MEDIA_TYPE, 'INVALID_MANIFEST', 'Registry manifest response has the wrong media type.', { contentType });
    const digest = sha256Buffer(bytes);
    const headerDigest = response.headers.get('docker-content-digest');
    if (headerDigest !== null) expect(headerDigest === digest, 'MANIFEST_DIGEST_MISMATCH', 'Registry manifest digest header did not match its bytes.', { headerDigest, digest });
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('INVALID_MANIFEST', 'Registry manifest is not valid JSON.');
    }
    return { bytes, digest, manifest };
  }

  async getAnyManifest(reference, { timeoutMs = this.limits.timeoutMs } = {}) {
    const accepted = [MANIFEST_MEDIA_TYPE, OCI_INDEX_MEDIA_TYPE, DOCKER_MANIFEST_MEDIA_TYPE, DOCKER_INDEX_MEDIA_TYPE];
    const response = await this.request(`manifests/${encodeReference(reference)}`, {
      headers: { accept: accepted.join(', ') },
      expected: [200],
      timeoutMs,
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim();
    const bytes = await readBounded(response, this.limits.maxMetadataBytes, 'registry manifest');
    expect(accepted.includes(contentType), 'INVALID_MANIFEST', 'Registry object uses an unsupported manifest media type.', { contentType });
    const digest = sha256Buffer(bytes);
    const headerDigest = response.headers.get('docker-content-digest');
    if (headerDigest !== null) expect(headerDigest === digest, 'MANIFEST_DIGEST_MISMATCH', 'Registry manifest digest header did not match its bytes.', { headerDigest, digest });
    const manifest = parseJsonBytes(bytes, 'INVALID_MANIFEST', 'Registry manifest is not valid JSON.');
    return { bytes, digest, manifest, contentType };
  }

  async downloadBlob(digest, destination, expectedSize) {
    expect(SHA256_PATTERN.test(digest), 'INVALID_DIGEST', 'Blob digest is invalid.', { digest });
    expect(Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= this.limits.maxTransferBytes, 'TRANSFER_LIMIT', 'Blob exceeds download limit.', { expectedSize });
    const response = await this.request(`blobs/${digest}`, { expected: [200] });
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== expectedSize) {
      await discardResponse(response);
      fail('BLOB_SIZE_MISMATCH', 'Blob response size differs from its descriptor.', { digest, expectedSize, declared: Number(declared) });
    }
    const hash = createHash('sha256');
    let observed = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        observed += chunk.length;
        if (observed > expectedSize || observed > thisLimit) callback(new CacheTransportError('TRANSFER_LIMIT', 'Blob exceeded its bounded descriptor.'));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    const thisLimit = this.limits.maxTransferBytes;
    try {
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      await unlink(destination).catch(() => {});
      if (responseDeadlines.get(response)?.controller.signal.aborted) fail('REGISTRY_TIMEOUT', 'Snapshot download exceeded its bounded wait.', { digest });
      if (error instanceof CacheTransportError) throw error;
      fail('DOWNLOAD_FAILED', 'Could not download the snapshot blob.', { digest, reason: errorMessage(error) });
    } finally {
      finishResponse(response);
    }
    if (observed !== expectedSize) {
      await unlink(destination).catch(() => {});
      fail('BLOB_SIZE_MISMATCH', 'Downloaded blob was truncated.', { digest, expectedSize, observed });
    }
    const actualDigest = `sha256:${hash.digest('hex')}`;
    if (actualDigest !== digest) {
      await unlink(destination).catch(() => {});
      fail('BLOB_DIGEST_MISMATCH', 'Downloaded blob failed digest verification.', { expected: digest, actual: actualDigest });
    }
  }

  async getBlobBytes(digest, expectedSize, { timeoutMs = this.limits.timeoutMs } = {}) {
    expect(expectedSize <= this.limits.maxMetadataBytes, 'METADATA_LIMIT', 'Metadata descriptor exceeds its limit.');
    const response = await this.request(`blobs/${digest}`, { timeoutMs });
    const bytes = await readBounded(response, this.limits.maxMetadataBytes, 'OCI config');
    expect(bytes.length === expectedSize, 'BLOB_SIZE_MISMATCH', 'Metadata blob size differs from its descriptor.');
    expect(sha256Buffer(bytes) === digest, 'BLOB_DIGEST_MISMATCH', 'Metadata blob failed digest verification.');
    return bytes;
  }
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  expect(bytes.length <= length, 'TAR_PATH_LIMIT', 'Archive field is too long.', { value });
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const text = value.toString(8);
  expect(text.length <= length - 1, 'TAR_NUMBER_LIMIT', 'Archive numeric field is too large.', { value });
  buffer.write(`${text.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function splitTarPath(relativePath) {
  const bytes = Buffer.byteLength(relativePath);
  if (bytes <= 100) return { name: relativePath, prefix: '' };
  for (let index = relativePath.lastIndexOf('/'); index > 0; index = relativePath.lastIndexOf('/', index - 1)) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail('TAR_PATH_LIMIT', 'Snapshot path cannot be represented safely in ustar.', { path: relativePath });
}

export function makeTarHeader({ relativePath, mode, size, type }) {
  const header = Buffer.alloc(TAR_BLOCK);
  const encodedPath = type === '5' && !relativePath.endsWith('/') ? `${relativePath}/` : relativePath;
  const { name, prefix } = splitTarPath(encodedPath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeTarString(header, 265, 32, 'root');
  writeTarString(header, 297, 32, 'root');
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}
function isKacheCoordinationLock(relativePath) {
  return relativePath === 'store/gc.lock' || /^store\/[0-9a-f]{64}\.lock$/u.test(relativePath);
}

function checkOperationDeadline(deadline, operation) {
  expect(Date.now() <= deadline, 'OPERATION_TIMEOUT', `${operation} exceeded its bounded wait.`);
}

async function scanSnapshotDirectory(root, limits, deadline) {
  const entries = [];
  let unpackedSize = 0;
  async function visit(directory, relativeDirectory) {
    const dir = await opendir(directory);
    const children = [];
    for await (const child of dir) {
      checkOperationDeadline(deadline, 'Snapshot scan');
      expect(entries.length + children.length < limits.maxFiles, 'FILE_LIMIT', 'Snapshot source directory exceeds its file-count limit.', { observed: entries.length + children.length + 1, limit: limits.maxFiles });
      children.push(child.name);
    }
    children.sort();
    if (relativeDirectory === 'store/staging') {
      expect(children.length === 0, 'IN_PROGRESS_STORE', 'Kache staging contains an in-progress store entry; wait for the writer to finish before publishing.', { entries: children.length });
    }
    for (const name of children) {
      checkOperationDeadline(deadline, 'Snapshot scan');
      const absolute = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      expect(!relativePath.includes('\\') && !relativePath.split('/').includes('..'), 'UNSAFE_SOURCE_PATH', 'Snapshot source contains an unsafe path.', { path: relativePath });
      expect(relativePath !== '.snapshot-uncertain', 'UNCERTAIN_SNAPSHOT', 'Kache quiescence was not confirmed; refusing to publish the uncertain store.');
      const info = await lstat(absolute);
      const permissions = info.mode & 0o7777;
      expect((permissions & ~0o777) === 0, 'UNSAFE_SOURCE_MODE', 'Snapshot source contains set-id or sticky mode bits.', { path: relativePath, mode: permissions.toString(8) });
      if (info.isSymbolicLink()) fail('UNSAFE_SOURCE_LINK', 'Snapshot source contains a symbolic link.', { path: relativePath });
      if (info.isDirectory()) {
        entries.push({ absolute, relativePath, mode: permissions, size: 0, type: '5' });
        await visit(absolute, relativePath);
      } else if (info.isFile()) {
        if (/(?:-(?:wal|shm|journal))$/u.test(name)) fail('OPEN_SQLITE_STATE', 'Snapshot source contains SQLite journal state; stop the writer and checkpoint before publishing.', { path: relativePath });
        if (isKacheCoordinationLock(relativePath)) {
          // Kache v0.20.0 persists diagnostic owner metadata in advisory lock files after the OS lock is released.
          continue;
        }
        expect(!/\.(?:lock|sock|log)$/u.test(name), 'UNEXPECTED_RUNTIME_FILE', 'Snapshot source contains a runtime lock, socket marker, or log outside the validated kache lock location.', { path: relativePath });
        unpackedSize += info.size;
        expect(unpackedSize <= limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Snapshot source exceeds its unpacked size limit.', { observed: unpackedSize, limit: limits.maxUnpackedBytes });
        entries.push({ absolute, relativePath, mode: permissions, size: info.size, type: '0', dev: info.dev, ino: info.ino });
      } else {
        fail('UNSAFE_SOURCE_TYPE', 'Snapshot source contains a socket, device, or unsupported file type.', { path: relativePath });
      }
      expect(entries.length <= limits.maxFiles, 'FILE_LIMIT', 'Snapshot source exceeds its file-count limit.', { observed: entries.length, limit: limits.maxFiles });
    }
  }
  await visit(root, '');
  expect(entries.some((entry) => entry.type === '0'), 'EMPTY_SNAPSHOT', 'Refusing to publish an empty cache snapshot.');
  return { entries, unpackedSize };
}

export async function createTarFromDirectory(root, destination, inputLimits = {}) {
  const limits = normalizeLimits(inputLimits);
  const deadline = Date.now() + limits.timeoutMs;
  const rootInfo = await stat(root);
  expect(rootInfo.isDirectory(), 'INVALID_SOURCE', 'Snapshot source is not a directory.', { root });
  const { entries, unpackedSize } = await scanSnapshotDirectory(root, limits, deadline);
  const handle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let archiveSize = 0;
  const append = async (buffer) => {
    checkOperationDeadline(deadline, 'Snapshot creation');
    archiveSize += buffer.length;
    expect(archiveSize <= limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Raw tar exceeds its decompressed size limit.', { observed: archiveSize, limit: limits.maxUnpackedBytes });
    expect(archiveSize + unpackedSize <= limits.maxDiskBytes, 'DISK_LIMIT', 'Snapshot workspace exceeds its disk limit.', { archiveSize, unpackedSize, limit: limits.maxDiskBytes });
    hash.update(buffer);
    await writeAll(handle, buffer);
  };
  try {
    for (const entry of entries) {
      checkOperationDeadline(deadline, 'Snapshot creation');
      await append(makeTarHeader(entry));
      if (entry.type === '0') {
        const source = await open(entry.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const current = await source.stat();
          expect(current.dev === entry.dev && current.ino === entry.ino && current.size === entry.size, 'SOURCE_CHANGED', 'Snapshot source changed during capture.', { path: entry.relativePath });
          let offset = 0;
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          while (offset < entry.size) {
            checkOperationDeadline(deadline, 'Snapshot creation');
            const length = Math.min(buffer.length, entry.size - offset);
            const { bytesRead } = await source.read(buffer, 0, length, offset);
            expect(bytesRead > 0, 'SOURCE_CHANGED', 'Snapshot source was truncated during capture.', { path: entry.relativePath });
            await append(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          expect((await source.stat()).size === entry.size, 'SOURCE_CHANGED', 'Snapshot source changed during capture.', { path: entry.relativePath });
        } finally {
          await source.close();
        }
        const padding = (TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK;
        if (padding) await append(Buffer.alloc(padding));
      }
    }
    await append(ZERO_BLOCKS);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(destination).catch(() => {});
    throw error;
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    size: archiveSize,
    unpackedSize,
    fileCount: entries.length,
  };
}
async function transformPayloadFile({
  source,
  destination,
  limits: inputLimits,
  operation,
  codec,
  maxInputBytes,
  maxOutputBytes,
  reservedDiskBytes = 0,
  failureCode,
}) {
  const limits = normalizeLimits(inputLimits);
  positiveInteger(maxInputBytes, `${operation}.maxInputBytes`);
  positiveInteger(maxOutputBytes, `${operation}.maxOutputBytes`);
  expect(Number.isSafeInteger(reservedDiskBytes) && reservedDiskBytes >= 0, 'INVALID_LIMIT', 'Reserved staging bytes must be a non-negative safe integer.');
  const sourceInfo = await stat(source);
  expect(sourceInfo.isFile(), 'INVALID_PAYLOAD', `${operation} source is not a regular file.`);
  expect(sourceInfo.size <= maxInputBytes, operation === 'Compression' ? 'UNPACKED_LIMIT' : 'TRANSFER_LIMIT', `${operation} input exceeds its size limit.`, { observed: sourceInfo.size, limit: maxInputBytes });
  expect(reservedDiskBytes + sourceInfo.size <= limits.maxDiskBytes, 'DISK_LIMIT', `${operation} input exceeds the aggregate staging disk limit.`, { reservedDiskBytes, inputBytes: sourceInfo.size, limit: limits.maxDiskBytes });
  let outputCreated = false;
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600, highWaterMark: PAYLOAD_STREAM_CHUNK_BYTES });
  output.once('open', () => {
    outputCreated = true;
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${operation} timeout`)), limits.timeoutMs).unref();
  const hash = createHash('sha256');
  let outputBytes = 0;
  const meter = new Transform({
    readableHighWaterMark: PAYLOAD_STREAM_CHUNK_BYTES,
    writableHighWaterMark: PAYLOAD_STREAM_CHUNK_BYTES,
    transform(chunk, _encoding, callback) {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        callback(new CacheTransportError(operation === 'Compression' ? 'TRANSFER_LIMIT' : 'UNPACKED_LIMIT', `${operation} output exceeded its size limit.`, { observed: outputBytes, limit: maxOutputBytes }));
        return;
      }
      if (reservedDiskBytes + sourceInfo.size + outputBytes > limits.maxDiskBytes) {
        callback(new CacheTransportError('DISK_LIMIT', `${operation} exceeded the aggregate staging disk limit.`, { reservedDiskBytes, inputBytes: sourceInfo.size, outputBytes, limit: limits.maxDiskBytes }));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: PAYLOAD_STREAM_CHUNK_BYTES }),
      codec(),
      meter,
      output,
      { signal: controller.signal },
    );
    expect(!controller.signal.aborted, 'OPERATION_TIMEOUT', `${operation} exceeded its bounded wait.`);
  } catch (error) {
    if (outputCreated) await unlink(destination).catch(() => {});
    if (controller.signal.aborted) fail('OPERATION_TIMEOUT', `${operation} exceeded its bounded wait.`);
    if (error instanceof CacheTransportError) throw error;
    fail(failureCode, `${operation} failed.`, { reason: errorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    size: outputBytes,
    inputSize: sourceInfo.size,
  };
}

export async function compressTarToGzip(source, destination, inputLimits = {}, { reservedDiskBytes = 0 } = {}) {
  const limits = normalizeLimits(inputLimits);
  return transformPayloadFile({
    source,
    destination,
    limits,
    operation: 'Compression',
    codec: () => createGzip({ level: zlibConstants.Z_BEST_SPEED, chunkSize: PAYLOAD_STREAM_CHUNK_BYTES, highWaterMark: PAYLOAD_STREAM_CHUNK_BYTES }),
    maxInputBytes: limits.maxUnpackedBytes,
    maxOutputBytes: limits.maxTransferBytes,
    reservedDiskBytes,
    failureCode: 'COMPRESSION_FAILED',
  });
}

export async function decompressGzipToTar(source, destination, inputLimits = {}, { expectedDigest, expectedSize } = {}) {
  const limits = normalizeLimits(inputLimits);
  const outputLimit = expectedSize === undefined ? limits.maxUnpackedBytes : positiveInteger(expectedSize, 'expectedSize');
  expect(outputLimit <= limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Expected raw tar size exceeds the decompressed byte limit.', { observed: outputLimit, limit: limits.maxUnpackedBytes });
  if (expectedDigest !== undefined) expect(SHA256_PATTERN.test(expectedDigest), 'INVALID_DIGEST', 'Expected raw tar digest is invalid.');
  const result = await transformPayloadFile({
    source,
    destination,
    limits,
    operation: 'Decompression',
    codec: () => createGunzip({ chunkSize: PAYLOAD_STREAM_CHUNK_BYTES, highWaterMark: PAYLOAD_STREAM_CHUNK_BYTES }),
    maxInputBytes: limits.maxTransferBytes,
    maxOutputBytes: outputLimit,
    failureCode: 'INVALID_GZIP_PAYLOAD',
  });
  if ((expectedSize !== undefined && result.size !== outputLimit) || (expectedDigest !== undefined && result.digest !== expectedDigest)) {
    await unlink(destination).catch(() => {});
    fail('DECOMPRESSED_PAYLOAD_MISMATCH', 'Decompressed tar does not match its verified snapshot metadata.', {
      expectedDigest,
      actualDigest: result.digest,
      expectedSize: expectedSize === undefined ? undefined : outputLimit,
      actualSize: result.size,
    });
  }
  return result;
}


function parseTarOctal(buffer, offset, length, field) {
  const raw = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/su, '').trim();
  expect(/^[0-7]+$/u.test(raw), 'INVALID_ARCHIVE', `Archive ${field} is not strict octal.`);
  const value = Number.parseInt(raw, 8);
  expect(Number.isSafeInteger(value) && value >= 0, 'INVALID_ARCHIVE', `Archive ${field} is out of range.`);
  return value;
}

function parseTarString(buffer, offset, length) {
  const value = buffer.subarray(offset, offset + length);
  const nul = value.indexOf(0);
  const raw = value.subarray(0, nul === -1 ? value.length : nul);
  if (nul !== -1) expect(value.subarray(nul + 1).every((byte) => byte === 0), 'INVALID_ARCHIVE', 'Archive string field has data after its terminator.');
  const decoded = raw.toString('utf8');
  expect(Buffer.from(decoded, 'utf8').equals(raw), 'INVALID_ARCHIVE', 'Archive string field is not valid UTF-8.');
  return decoded;
}

function validateArchivePath(raw) {
  expect(raw.length > 0 && !raw.includes('\0') && !raw.includes('\\'), 'UNSAFE_ARCHIVE_PATH', 'Archive path is malformed.', { path: raw });
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  expect(trimmed.length > 0 && !path.posix.isAbsolute(trimmed), 'UNSAFE_ARCHIVE_PATH', 'Archive path is absolute.', { path: raw });
  const normalized = path.posix.normalize(trimmed);
  expect(normalized === trimmed && !normalized.split('/').includes('..') && normalized !== '.', 'UNSAFE_ARCHIVE_PATH', 'Archive path escapes or aliases its extraction root.', { path: raw });
  return normalized;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    expect(bytesWritten > 0, 'WRITE_FAILED', 'File write made no progress.');
    offset += bytesWritten;
  }
}

async function readExact(handle, buffer, position, label) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    expect(bytesRead > 0, 'TRUNCATED_ARCHIVE', `Archive ended while reading ${label}.`);
    offset += bytesRead;
  }
}

export async function extractTarToDirectory(archive, destination, inputLimits = {}) {
  const limits = normalizeLimits(inputLimits);
  const deadline = Date.now() + limits.timeoutMs;
  const archiveInfo = await stat(archive);
  expect(archiveInfo.size <= limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Raw tar exceeds its decompressed size limit.', { size: archiveInfo.size, limit: limits.maxUnpackedBytes });
  await mkdir(destination, { recursive: false, mode: 0o700 });
  let handle;
  try {
    handle = await open(archive, 'r');
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  let position = 0;
  let unpackedSize = 0;
  let fileCount = 0;
  let zeroBlocks = 0;
  const seen = new Set();
  const directoryModes = [];
  const directories = new Set();
  try {
    while (position < archiveInfo.size) {
      checkOperationDeadline(deadline, 'Snapshot extraction');
      const header = Buffer.alloc(TAR_BLOCK);
      await readExact(handle, header, position, 'entry header');
      position += TAR_BLOCK;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      expect(zeroBlocks === 0, 'INVALID_ARCHIVE', 'Archive contains data after an end marker.');
      const expectedChecksum = parseTarOctal(header, 148, 8, 'checksum');
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      expect(checksumHeader.reduce((sum, byte) => sum + byte, 0) === expectedChecksum, 'INVALID_ARCHIVE', 'Archive header checksum failed.');
      expect(parseTarString(header, 257, 6) === 'ustar', 'INVALID_ARCHIVE', 'Archive is not strict ustar.');
      const name = parseTarString(header, 0, 100);
      const prefix = parseTarString(header, 345, 155);
      const relativePath = validateArchivePath(prefix ? `${prefix}/${name}` : name);
      expect(relativePath !== '.snapshot-uncertain', 'UNCERTAIN_SNAPSHOT', 'Snapshot carries an uncertain kache quiescence marker and cannot be restored.');
      const parentPath = path.posix.dirname(relativePath);
      expect(parentPath === '.' || directories.has(parentPath), 'INVALID_ARCHIVE', 'Archive entry appears before its declared parent directory.', { path: relativePath });
      expect(!seen.has(relativePath), 'INVALID_ARCHIVE', 'Archive repeats a path.', { path: relativePath });
      seen.add(relativePath);
      const mode = parseTarOctal(header, 100, 8, 'mode');
      expect((mode & ~0o777) === 0, 'UNSAFE_ARCHIVE_MODE', 'Archive contains set-id or sticky mode bits.', { path: relativePath, mode: mode.toString(8) });
      const size = parseTarOctal(header, 124, 12, 'size');
      const type = String.fromCharCode(header[156] || 0x30);
      expect(type === '0' || type === '5', 'UNSAFE_ARCHIVE_TYPE', 'Archive links, devices, and special entries are forbidden.', { path: relativePath, type });
      if (type === '5') expect(size === 0, 'INVALID_ARCHIVE', 'Archive directory has a payload.', { path: relativePath });
      unpackedSize += size;
      fileCount += 1;
      expect(unpackedSize <= limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Archive exceeds its unpacked size limit.', { observed: unpackedSize });
      expect(archiveInfo.size + unpackedSize <= limits.maxDiskBytes, 'DISK_LIMIT', 'Extraction workspace exceeds its disk limit.', { archiveSize: archiveInfo.size, unpackedSize });
      expect(fileCount <= limits.maxFiles, 'FILE_LIMIT', 'Archive exceeds its file-count limit.', { observed: fileCount });
      const absolute = path.join(destination, ...relativePath.split('/'));
      expect(path.relative(destination, absolute) !== '..' && !path.relative(destination, absolute).startsWith(`..${path.sep}`), 'UNSAFE_ARCHIVE_PATH', 'Archive path escaped extraction root.');
      if (type === '5') {
        await mkdir(absolute, { recursive: false, mode: 0o700 });
        directoryModes.push([absolute, mode]);
        directories.add(relativePath);
      } else {
        const output = await open(absolute, 'wx', 0o600);
        try {
          let remaining = size;
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          while (remaining > 0) {
            checkOperationDeadline(deadline, 'Snapshot extraction');
            const length = Math.min(buffer.length, remaining);
            const chunk = buffer.subarray(0, length);
            await readExact(handle, chunk, position, 'file payload');
            await writeAll(output, chunk);
            position += length;
            remaining -= length;
          }
        } finally {
          // These are disposable staging files; closing them is sufficient for the next transfer to read them.
          await output.close();
        }
        await chmod(absolute, mode);
      }
      position += (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      expect(position <= archiveInfo.size, 'TRUNCATED_ARCHIVE', 'Archive entry padding exceeds the payload.');
    }
    expect(zeroBlocks === 2, 'TRUNCATED_ARCHIVE', 'Archive has no complete end marker.');
    expect(position === archiveInfo.size, 'INVALID_ARCHIVE', 'Archive has trailing bytes after its end marker.', { trailing: archiveInfo.size - position });
    for (const [directory, mode] of directoryModes.reverse()) await chmod(directory, mode);
    return { unpackedSize, fileCount };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

function manifestDescriptor(value, expectedMediaType, name) {
  expect(value && value.mediaType === expectedMediaType, 'INCOMPATIBLE_SNAPSHOT', `Snapshot ${name} has the wrong media type.`);
  expect(SHA256_PATTERN.test(value.digest), 'INVALID_MANIFEST', `Snapshot ${name} has an invalid digest.`);
  expect(Number.isSafeInteger(value.size) && value.size >= 0, 'INVALID_MANIFEST', `Snapshot ${name} has an invalid size.`);
  return value;
}

function parseConfig(bytes, compatibility) {
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_CONFIG', 'Snapshot config is not valid JSON.');
  }
  expect(config?.snapshot?.kind === SNAPSHOT_KIND, 'INCOMPATIBLE_SNAPSHOT', 'Registry object is not an azuki kache snapshot.');
  const metadata = config.snapshot;
  const [expectedOs, expectedArchitecture] = compatibility.platform.split('/');
  expect(config.os === expectedOs && config.architecture === expectedArchitecture, 'INCOMPATIBLE_SNAPSHOT', 'OCI config platform does not match snapshot compatibility.');
  expect(metadata.schemaVersion === compatibility.schemaVersion, 'INCOMPATIBLE_SNAPSHOT', 'Snapshot schema version does not match.', { expected: compatibility.schemaVersion, actual: metadata.schemaVersion });
  expect(metadata.platform === compatibility.platform, 'INCOMPATIBLE_SNAPSHOT', 'Snapshot platform does not match.', { expected: compatibility.platform, actual: metadata.platform });
  expect(metadata.kacheVersion === compatibility.kacheVersion, 'INCOMPATIBLE_SNAPSHOT', 'Snapshot kache version does not match.', { expected: compatibility.kacheVersion, actual: metadata.kacheVersion });
  expect(metadata.compatibilityRef === compatibility.fixedRef, 'INCOMPATIBLE_SNAPSHOT', 'Snapshot compatibility reference does not match.');
  expect(metadata.producer && REPOSITORY_PATTERN.test(metadata.producer.repository), 'INVALID_CONFIG', 'Snapshot producer repository is invalid.');
  expect(typeof metadata.producer.runId === 'string' && /^[1-9][0-9]{0,19}$/u.test(metadata.producer.runId), 'INVALID_CONFIG', 'Snapshot producer run ID is invalid.');
  expect(typeof metadata.producer.runAttempt === 'string' && /^[1-9][0-9]{0,9}$/u.test(metadata.producer.runAttempt), 'INVALID_CONFIG', 'Snapshot producer run attempt is invalid.');
  expect(SOURCE_SHA_PATTERN.test(metadata.producer.sourceSha), 'INVALID_CONFIG', 'Snapshot source SHA is invalid.');
  expect(metadata.payload && metadata.payload.mediaType === LAYER_MEDIA_TYPE && metadata.payload.compression === 'gzip', 'INVALID_CONFIG', 'Snapshot payload codec metadata is invalid.');
  expect(SHA256_PATTERN.test(metadata.payload.digest), 'INVALID_CONFIG', 'Snapshot compressed payload digest is invalid.');
  expect(Number.isSafeInteger(metadata.payload.size) && metadata.payload.size > 0, 'INVALID_CONFIG', 'Snapshot compressed payload size is invalid.');
  expect(SHA256_PATTERN.test(metadata.payload.tarDigest), 'INVALID_CONFIG', 'Snapshot raw tar digest is invalid.');
  expect(Number.isSafeInteger(metadata.payload.tarSize) && metadata.payload.tarSize > 0, 'INVALID_CONFIG', 'Snapshot raw tar size is invalid.');
  expect(Number.isSafeInteger(metadata.payload.fileBytes) && metadata.payload.fileBytes >= 0, 'INVALID_CONFIG', 'Snapshot payload file bytes are invalid.');
  expect(Number.isSafeInteger(metadata.payload.fileCount) && metadata.payload.fileCount > 0, 'INVALID_CONFIG', 'Snapshot file count is invalid.');
  expect(Array.isArray(config.rootfs?.diff_ids) && config.rootfs.diff_ids.length === 1 && config.rootfs.diff_ids[0] === metadata.payload.tarDigest, 'INVALID_CONFIG', 'OCI config diff ID differs from the raw tar digest.');
  expect(typeof metadata.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(metadata.createdAt) && !Number.isNaN(Date.parse(metadata.createdAt)), 'INVALID_CONFIG', 'Snapshot creation time is not canonical UTC.');
  return metadata;
}

export async function resolveSnapshot(client, compatibility) {
  const expectedProducerRepository = validateCacheScope(client);
  validateCompatibility(compatibility);
  validateReference(compatibility.fixedRef, 'fixed reference');
  expect(compatibility.fixedRef === compatibilityRef(compatibility), 'INVALID_FIXED_REF', 'Fixed reference must be derived only from compatibility inputs.', { expected: compatibilityRef(compatibility), actual: compatibility.fixedRef });
  const resolved = await client.getManifest(compatibility.fixedRef, { missing: true });
  if (!resolved) return null;
  const { manifest } = resolved;
  expect(manifest?.schemaVersion === 2 && manifest.mediaType === MANIFEST_MEDIA_TYPE, 'INVALID_MANIFEST', 'Registry object is not a supported OCI manifest.');
  expect(manifest.artifactType === SNAPSHOT_KIND, 'INCOMPATIBLE_SNAPSHOT', 'OCI manifest artifact type is not an azuki kache snapshot.');
  expect(Array.isArray(manifest.layers) && manifest.layers.length === 1, 'INVALID_MANIFEST', 'Snapshot manifest must contain exactly one layer.');
  const configDescriptor = manifestDescriptor(manifest.config, CONFIG_MEDIA_TYPE, 'config');
  const layerDescriptor = manifestDescriptor(manifest.layers[0], LAYER_MEDIA_TYPE, 'layer');
  expect(layerDescriptor.size <= client.limits.maxTransferBytes, 'TRANSFER_LIMIT', 'Snapshot layer descriptor exceeds download limit.');
  const configBytes = await client.getBlobBytes(configDescriptor.digest, configDescriptor.size);
  const metadata = parseConfig(configBytes, compatibility);
  expect(metadata.producer.repository === expectedProducerRepository, 'INCOMPATIBLE_SNAPSHOT', 'Snapshot producer does not own the configured build-cache repository.');
  expect(metadata.payload.digest === layerDescriptor.digest && metadata.payload.size === layerDescriptor.size, 'INVALID_CONFIG', 'Snapshot payload metadata differs from its OCI layer descriptor.');
  const expectedAnnotations = {
    'org.opencontainers.image.created': metadata.createdAt,
    'org.opencontainers.image.revision': metadata.producer.sourceSha,
    'io.github.nanazt.azuki.cache.kind': SNAPSHOT_KIND,
    'io.github.nanazt.azuki.cache.platform': metadata.platform,
    'io.github.nanazt.azuki.cache.kache-version': metadata.kacheVersion,
    'io.github.nanazt.azuki.cache.schema-version': String(metadata.schemaVersion),
    'io.github.nanazt.azuki.cache.producer-repository': metadata.producer.repository,
    'io.github.nanazt.azuki.cache.producer-run-id': metadata.producer.runId,
    'io.github.nanazt.azuki.cache.producer-run-attempt': metadata.producer.runAttempt,
  };
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    expect(manifest.annotations?.[key] === value, 'INVALID_MANIFEST', 'OCI manifest annotation differs from verified snapshot config.', { annotation: key });
  }
  expect(metadata.payload.tarSize <= client.limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Snapshot raw tar metadata exceeds decompression limit.');
  expect(metadata.payload.fileBytes <= client.limits.maxUnpackedBytes, 'UNPACKED_LIMIT', 'Snapshot payload files exceed unpacked size limit.');
  expect(metadata.payload.size + metadata.payload.tarSize <= client.limits.maxDiskBytes, 'DISK_LIMIT', 'Compressed and raw snapshot staging exceeds disk limit.');
  expect(metadata.payload.tarSize + metadata.payload.fileBytes <= client.limits.maxDiskBytes, 'DISK_LIMIT', 'Raw snapshot and extracted files exceed disk limit.');
  expect(metadata.payload.fileCount <= client.limits.maxFiles, 'FILE_LIMIT', 'Snapshot metadata exceeds file-count limit.');
  return { manifestDigest: resolved.digest, layerDescriptor, metadata };
}

function snapshotConfig({ compatibility, producer, payload, createdAt }) {
  return {
    architecture: compatibility.platform.split('/')[1],
    os: compatibility.platform.split('/')[0],
    created: createdAt,
    rootfs: { type: 'layers', diff_ids: [payload.tarDigest] },
    config: { Labels: { 'io.github.nanazt.azuki.cache.kind': SNAPSHOT_KIND } },
    snapshot: {
      kind: SNAPSHOT_KIND,
      schemaVersion: compatibility.schemaVersion,
      platform: compatibility.platform,
      kacheVersion: compatibility.kacheVersion,
      compatibilityRef: compatibility.fixedRef,
      createdAt,
      producer,
      payload,
    },
  };
}

function immutableReference(compatibility, producer, manifestDigest) {
  const repoHash = createHash('sha256').update(producer.repository).digest('hex').slice(0, 12);
  const compat = createHash('sha256').update(`${compatibility.platform}\n${compatibility.schemaVersion}\n${compatibility.kacheVersion}`).digest('hex').slice(0, 12);
  return `snapshot-${compat}-${repoHash}-run-${producer.runId}-attempt-${producer.runAttempt}-${producer.sourceSha.slice(0, 12)}-${manifestDigest.slice(7, 19)}`;
}

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function githubTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function compatibilityIdentity(compatibility) {
  return `${compatibility.platform}\n${compatibility.schemaVersion}\n${compatibility.kacheVersion}\n${compatibility.fixedRef}`;
}

function sameCompatibility(left, right) {
  return compatibilityIdentity(left) === compatibilityIdentity(right);
}

function receiptReference(compatibility, producer, snapshotDigest) {
  return immutableReference(compatibility, producer, snapshotDigest).replace(/^snapshot-/u, 'receipt-');
}

function normalizeRetentionLimits(input = {}) {
  const limits = { ...DEFAULT_RETENTION_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_RETENTION_LIMITS)) limits[key] = positiveInteger(limits[key], `retention.${key}`);
  expect(limits.targetSnapshots === 2, 'INVALID_RETENTION_LIMIT', 'Retention must preserve the current snapshot and one normal predecessor.');
  expect(limits.perPage <= 100, 'INVALID_RETENTION_LIMIT', 'GitHub package pagination cannot exceed 100 versions per page.');
  expect(limits.maxVersions >= limits.perPage, 'INVALID_RETENTION_LIMIT', 'Version bound must cover at least one complete page.');
  return limits;
}

function remainingTime(deadline, operation) {
  const remaining = deadline - Date.now();
  expect(remaining > 0, 'RETENTION_TIMEOUT', `${operation} exceeded its bounded wait.`);
  return remaining;
}

function normalizeGitHubApiOrigin(raw, registry) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('INVALID_GITHUB_ORIGIN', 'GitHub API origin must be an absolute origin URL.');
  }
  expect(url.username === '' && url.password === '' && url.pathname.replaceAll('/', '') === '' && url.search === '' && url.hash === '', 'INVALID_GITHUB_ORIGIN', 'GitHub API URL must contain only an origin.');
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.origin === GITHUB_API_ORIGIN) return url.origin;
  expect(registry?.isLoopback && loopback, 'UNTRUSTED_GITHUB_ORIGIN', 'A non-GitHub API origin is allowed only for a loopback fixture paired with a loopback registry.');
  expect(url.protocol === 'http:' || url.protocol === 'https:', 'INVALID_GITHUB_ORIGIN', 'Loopback GitHub fixtures must use HTTP or HTTPS.');
  return url.origin;
}

function parseJsonBytes(bytes, code, message) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code, message);
  }
}

export class GitHubRetentionClient {
  constructor({ token, registry, origin = GITHUB_API_ORIGIN, limits = {}, maxBodyBytes = DEFAULT_LIMITS.maxMetadataBytes }) {
    expect(typeof token === 'string' && token.length > 0 && token.length <= 64 * 1024, 'INVALID_GITHUB_TOKEN', 'A bounded GitHub API token must be supplied explicitly.');
    this.origin = normalizeGitHubApiOrigin(origin, registry);
    this.token = token;
    this.limits = normalizeRetentionLimits(limits);
    this.maxBodyBytes = positiveInteger(maxBodyBytes, 'github.maxBodyBytes');
    this.repositoryScopes = new Map();
  }

  async request(target, { method = 'GET', expected = [200], deadline }) {
    const url = target instanceof URL ? target : new URL(target, this.origin);
    expect(url.origin === this.origin, 'GITHUB_REDIRECT', 'GitHub API request escaped its configured origin.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('GitHub API timeout')), remainingTime(deadline, 'GitHub API request')).unref();
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'azuki-docker-cache-retention',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      responseDeadlines.set(response, { controller, timer });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) fail('GITHUB_TIMEOUT', 'GitHub API request exceeded its bounded wait.');
      fail('GITHUB_IO', 'GitHub API request failed.', { reason: errorMessage(error) });
    }
    if (!expected.includes(response.status)) {
      const status = response.status;
      await discardResponse(response);
      fail('GITHUB_STATUS', 'GitHub API returned an unexpected status.', { method, status });
    }
    return response;
  }

  async json(target, { deadline }) {
    const response = await this.request(target, { deadline });
    const link = response.headers.get('link');
    const bytes = await readBounded(response, this.maxBodyBytes, 'GitHub API response');
    return { value: parseJsonBytes(bytes, 'GITHUB_JSON', 'GitHub API returned invalid JSON.'), link };
  }

  async repositoryScope(repository, deadline) {
    if (this.repositoryScopes.has(repository)) return this.repositoryScopes.get(repository);
    const parts = repository.split('/');
    expect(parts.length === 2, 'UNSAFE_RETENTION_SCOPE', 'Producer repository must be an exact owner/repository pair for cleanup.');
    const [owner, name] = parts;
    const { value } = await this.json(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { deadline });
    expect(value?.full_name?.toLowerCase() === repository && value.owner?.login?.toLowerCase() === owner, 'GITHUB_REPOSITORY_MISMATCH', 'GitHub repository lookup did not match the producer scope.');
    expect(value.owner.type === 'Organization' || value.owner.type === 'User', 'GITHUB_REPOSITORY_MISMATCH', 'GitHub repository owner type is unsupported.');
    const scope = value.owner.type === 'Organization' ? `/orgs/${encodeURIComponent(owner)}` : `/users/${encodeURIComponent(owner)}`;
    this.repositoryScopes.set(repository, scope);
    return scope;
  }

  async listPackageVersions(producerRepository, cacheRepository, deadline) {
    expect(cacheRepository === `${producerRepository}-build-cache`, 'UNSAFE_RETENTION_SCOPE', 'Cleanup is restricted to the producer repository build-cache package.');
    const scope = await this.repositoryScope(producerRepository, deadline);
    const packageName = cacheRepository.split('/')[1];
    const basePath = `${scope}/packages/container/${encodeURIComponent(packageName)}/versions`;
    let next = new URL(`${basePath}?per_page=${this.limits.perPage}&state=active&page=1`, this.origin);
    const versions = [];
    const seenPages = new Set();
    for (let page = 1; next; page += 1) {
      expect(page <= this.limits.maxPages, 'INCOMPLETE_PAGINATION', 'GitHub package version pagination exceeded its page bound.');
      expect(!seenPages.has(next.href), 'INCOMPLETE_PAGINATION', 'GitHub package version pagination repeated a page.');
      seenPages.add(next.href);
      const { value, link } = await this.json(next, { deadline });
      expect(Array.isArray(value), 'GITHUB_JSON', 'GitHub package versions response must be an array.');
      versions.push(...value);
      expect(versions.length <= this.limits.maxVersions, 'INCOMPLETE_PAGINATION', 'GitHub package versions exceeded the bounded candidate count.');
      next = this.nextPage(link, basePath);
    }
    return versions;
  }

  nextPage(link, basePath) {
    if (link === null) return null;
    const matches = [...link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
    expect(matches.length > 0, 'INCOMPLETE_PAGINATION', 'GitHub pagination link header was malformed.');
    const nextMatch = matches.find((match) => match[2].split(/\s+/u).includes('next'));
    if (!nextMatch) return null;
    const next = new URL(nextMatch[1]);
    expect(next.origin === this.origin && next.pathname === basePath, 'INCOMPLETE_PAGINATION', 'GitHub pagination escaped the package version collection.');
    expect(next.searchParams.get('state') === 'active' && next.searchParams.get('per_page') === String(this.limits.perPage), 'INCOMPLETE_PAGINATION', 'GitHub pagination changed the bounded query.');
    expect(/^[1-9][0-9]*$/u.test(next.searchParams.get('page') ?? ''), 'INCOMPLETE_PAGINATION', 'GitHub pagination returned an invalid page.');
    return next;
  }

  async workflowAttempt(producer, deadline) {
    const { value } = await this.json(`/repos/${producer.repository.split('/').map(encodeURIComponent).join('/')}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`, { deadline });
    expect(String(value?.id) === producer.runId, 'GITHUB_ATTEMPT_MISMATCH', 'Workflow attempt response returned a different run ID.');
    expect(String(value?.run_attempt) === producer.runAttempt, 'GITHUB_ATTEMPT_MISMATCH', 'Workflow attempt response returned a different attempt.');
    expect(value.repository?.full_name?.toLowerCase() === producer.repository, 'GITHUB_ATTEMPT_MISMATCH', 'Workflow attempt response returned a different repository.');
    return { status: value.status, conclusion: value.conclusion };
  }

  async deletePackageVersion(producerRepository, cacheRepository, versionId, deadline) {
    expect(cacheRepository === `${producerRepository}-build-cache`, 'UNSAFE_RETENTION_SCOPE', 'Cleanup cannot delete a runtime or unrelated package.');
    expect(Number.isSafeInteger(versionId) && versionId > 0, 'INVALID_PACKAGE_VERSION', 'GitHub package version ID must be a positive integer.');
    const scope = await this.repositoryScope(producerRepository, deadline);
    const packageName = cacheRepository.split('/')[1];
    const response = await this.request(`${scope}/packages/container/${encodeURIComponent(packageName)}/versions/${versionId}`, {
      method: 'DELETE',
      expected: [204],
      deadline,
    });
    await discardResponse(response);
  }
}

function receiptConfig({ compatibility, publication, acknowledgedAt }) {
  return {
    architecture: compatibility.platform.split('/')[1],
    os: compatibility.platform.split('/')[0],
    created: acknowledgedAt,
    rootfs: { type: 'layers', diff_ids: [publication.tarDigest] },
    config: { Labels: { 'io.github.nanazt.azuki.cache.kind': RECEIPT_KIND } },
    receipt: {
      kind: RECEIPT_KIND,
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      acknowledgedAt,
      compatibility: {
        platform: compatibility.platform,
        schemaVersion: compatibility.schemaVersion,
        kacheVersion: compatibility.kacheVersion,
        fixedRef: compatibility.fixedRef,
      },
      producer: publication.producer,
      snapshot: {
        kind: SNAPSHOT_KIND,
        manifest: publication.manifestDescriptor,
        config: publication.configDescriptor,
        layer: publication.layerDescriptor,
        tarDigest: publication.tarDigest,
      },
    },
  };
}

export async function publishCompletionReceipt({ client, publication, compatibility, acknowledgedAt = new Date().toISOString() }) {
  expect(publication?.publication === 'promoted', 'INVALID_RECEIPT', 'A receipt requires a verified promoted snapshot.');
  expect(canonicalTimestamp(acknowledgedAt), 'INVALID_RECEIPT', 'Receipt acknowledgement time must be canonical UTC.');
  validateProducer(publication.producer);
  validateCacheScope(client, publication.producer.repository);
  validateCompatibility(compatibility);
  expect(compatibility.fixedRef === compatibilityRef(compatibility), 'INVALID_RECEIPT', 'Receipt compatibility reference is invalid.');
  const snapshotManifestDescriptor = manifestDescriptor(publication.manifestDescriptor, MANIFEST_MEDIA_TYPE, 'receipt snapshot manifest');
  manifestDescriptor(publication.configDescriptor, CONFIG_MEDIA_TYPE, 'receipt snapshot config');
  manifestDescriptor(publication.layerDescriptor, LAYER_MEDIA_TYPE, 'receipt snapshot layer');
  expect(SHA256_PATTERN.test(publication.tarDigest), 'INVALID_RECEIPT', 'Receipt requires the snapshot raw tar digest.');
  expect(publication.manifestDigest === snapshotManifestDescriptor.digest, 'INVALID_RECEIPT', 'Receipt publication digest differs from its manifest descriptor.');
  const promoted = await client.getManifest(compatibility.fixedRef);
  expect(promoted.digest === publication.manifestDigest && promoted.bytes.length === snapshotManifestDescriptor.size, 'RECEIPT_VERIFY_FAILED', 'Receipt cannot acknowledge a snapshot that is no longer the verified fixed reference.');
  const configDescriptor = await client.uploadBytes(jsonBytes(receiptConfig({ compatibility, publication, acknowledgedAt })));
  const receiptRef = receiptReference(compatibility, publication.producer, publication.manifestDigest);
  const manifestBytes = jsonBytes({
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    artifactType: RECEIPT_KIND,
    subject: publication.manifestDescriptor,
    config: { mediaType: CONFIG_MEDIA_TYPE, ...configDescriptor },
    layers: [publication.layerDescriptor],
    annotations: {
      'org.opencontainers.image.created': acknowledgedAt,
      'org.opencontainers.image.revision': publication.producer.sourceSha,
      'io.github.nanazt.azuki.cache.kind': RECEIPT_KIND,
      'io.github.nanazt.azuki.cache.platform': compatibility.platform,
      'io.github.nanazt.azuki.cache.kache-version': compatibility.kacheVersion,
      'io.github.nanazt.azuki.cache.schema-version': String(compatibility.schemaVersion),
      'io.github.nanazt.azuki.cache.producer-repository': publication.producer.repository,
      'io.github.nanazt.azuki.cache.producer-run-id': publication.producer.runId,
      'io.github.nanazt.azuki.cache.producer-run-attempt': publication.producer.runAttempt,
      'io.github.nanazt.azuki.cache.snapshot-digest': publication.manifestDigest,
    },
  });
  const receiptDigest = sha256Buffer(manifestBytes);
  expect(await client.putManifest(receiptRef, manifestBytes) === receiptDigest, 'RECEIPT_VERIFY_FAILED', 'Receipt digest changed while uploading.');
  const observed = await client.getManifest(receiptRef);
  expect(observed.digest === receiptDigest && observed.bytes.equals(manifestBytes), 'RECEIPT_VERIFY_FAILED', 'Receipt did not verify byte-for-byte.');
  return {
    status: 'acknowledged',
    ref: receiptRef,
    digest: receiptDigest,
    manifestDescriptor: { mediaType: MANIFEST_MEDIA_TYPE, digest: receiptDigest, size: manifestBytes.length },
    configDescriptor: { mediaType: CONFIG_MEDIA_TYPE, ...configDescriptor },
    snapshotDigest: publication.manifestDigest,
  };
}

function manifestDependencies(manifest) {
  const dependencies = new Set();
  const descriptors = [manifest?.subject, ...(Array.isArray(manifest?.manifests) ? manifest.manifests : [])];
  for (const descriptor of descriptors) {
    if (SHA256_PATTERN.test(descriptor?.digest ?? '')) dependencies.add(descriptor.digest);
  }
  return dependencies;
}

function validatePackageVersion(version) {
  expect(version && typeof version === 'object', 'INVALID_PACKAGE_VERSION', 'GitHub package version entry must be an object.');
  expect(Number.isSafeInteger(version.id) && version.id > 0, 'INVALID_PACKAGE_VERSION', 'GitHub package version entry has an invalid ID.');
  expect(SHA256_PATTERN.test(version.name), 'INVALID_PACKAGE_VERSION', 'GitHub package version entry has an invalid manifest digest.');
  expect(version.metadata?.package_type === 'container' && Array.isArray(version.metadata.container?.tags), 'INVALID_PACKAGE_VERSION', 'GitHub package version entry is not a container version.');
  expect(version.metadata.container.tags.length <= 256, 'INVALID_PACKAGE_VERSION', 'GitHub package version entry has too many tags.');
  for (const tag of version.metadata.container.tags) {
    expect(typeof tag === 'string' && tag.length > 0 && tag.length <= 128, 'INVALID_PACKAGE_VERSION', 'GitHub package version entry has an invalid tag.');
  }
  expect(new Set(version.metadata.container.tags).size === version.metadata.container.tags.length, 'INVALID_PACKAGE_VERSION', 'GitHub package version entry repeats a tag.');
  expect(githubTimestamp(version.created_at), 'INVALID_PACKAGE_VERSION', 'GitHub package version entry has an invalid creation time.');
  return { id: version.id, digest: version.name, tags: version.metadata.container.tags, createdAt: version.created_at };
}

async function readRetentionSnapshot(client, resolved, version, timeoutMs) {
  const { manifest } = resolved;
  expect(manifest?.schemaVersion === 2 && manifest.mediaType === MANIFEST_MEDIA_TYPE && manifest.artifactType === SNAPSHOT_KIND, 'INVALID_MANAGED_OBJECT', 'Managed snapshot manifest shape is invalid.');
  expect(Array.isArray(manifest.layers) && manifest.layers.length === 1, 'INVALID_MANAGED_OBJECT', 'Managed snapshot must contain one layer.');
  const configDescriptor = manifestDescriptor(manifest.config, CONFIG_MEDIA_TYPE, 'config');
  const layerDescriptor = manifestDescriptor(manifest.layers[0], LAYER_MEDIA_TYPE, 'layer');
  const configBytes = await client.getBlobBytes(configDescriptor.digest, configDescriptor.size, { timeoutMs });
  const raw = parseJsonBytes(configBytes, 'INVALID_CONFIG', 'Snapshot config is not valid JSON.');
  const compatibility = {
    platform: raw?.snapshot?.platform,
    schemaVersion: raw?.snapshot?.schemaVersion,
    kacheVersion: raw?.snapshot?.kacheVersion,
    fixedRef: raw?.snapshot?.compatibilityRef,
  };
  validateCompatibility(compatibility);
  expect(compatibility.fixedRef === compatibilityRef(compatibility), 'INVALID_MANAGED_OBJECT', 'Managed snapshot compatibility reference is invalid.');
  const metadata = parseConfig(configBytes, compatibility);
  expect(metadata.payload.digest === layerDescriptor.digest && metadata.payload.size === layerDescriptor.size, 'INVALID_MANAGED_OBJECT', 'Managed snapshot layer differs from its config.');
  const expectedAnnotations = {
    'org.opencontainers.image.created': metadata.createdAt,
    'org.opencontainers.image.revision': metadata.producer.sourceSha,
    'io.github.nanazt.azuki.cache.kind': SNAPSHOT_KIND,
    'io.github.nanazt.azuki.cache.platform': metadata.platform,
    'io.github.nanazt.azuki.cache.kache-version': metadata.kacheVersion,
    'io.github.nanazt.azuki.cache.schema-version': String(metadata.schemaVersion),
    'io.github.nanazt.azuki.cache.producer-repository': metadata.producer.repository,
    'io.github.nanazt.azuki.cache.producer-run-id': metadata.producer.runId,
    'io.github.nanazt.azuki.cache.producer-run-attempt': metadata.producer.runAttempt,
  };
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    expect(manifest.annotations?.[key] === value, 'INVALID_MANAGED_OBJECT', 'Managed snapshot annotation differs from its config.');
  }
  const immutableRef = immutableReference(compatibility, metadata.producer, resolved.digest);
  expect(version.tags.includes(immutableRef), 'INVALID_MANAGED_OBJECT', 'Managed snapshot version is missing its immutable producer reference.');
  expect(version.tags.every((tag) => tag === immutableRef || tag === compatibility.fixedRef), 'INVALID_MANAGED_OBJECT', 'Managed snapshot version carries an unrelated tag.');
  return {
    type: 'snapshot',
    version,
    digest: resolved.digest,
    manifestDescriptor: { mediaType: MANIFEST_MEDIA_TYPE, digest: resolved.digest, size: resolved.bytes.length },
    configDescriptor: { mediaType: CONFIG_MEDIA_TYPE, ...configDescriptor },
    tarDigest: metadata.payload.tarDigest,
    layerDescriptor,
    compatibility,
    producer: metadata.producer,
    createdAt: metadata.createdAt,
    immutableRef,
    dependencies: manifestDependencies(manifest),
  };
}

async function readRetentionReceipt(client, resolved, version, timeoutMs) {
  const { manifest } = resolved;
  expect(manifest?.schemaVersion === 2 && manifest.mediaType === MANIFEST_MEDIA_TYPE && manifest.artifactType === RECEIPT_KIND, 'INVALID_MANAGED_OBJECT', 'Managed receipt manifest shape is invalid.');
  expect(Array.isArray(manifest.layers) && manifest.layers.length === 1, 'INVALID_MANAGED_OBJECT', 'Managed receipt must contain one shared snapshot layer.');
  const configDescriptor = manifestDescriptor(manifest.config, CONFIG_MEDIA_TYPE, 'receipt config');
  const layerDescriptor = manifestDescriptor(manifest.layers[0], LAYER_MEDIA_TYPE, 'receipt layer');
  const subjectDescriptor = manifestDescriptor(manifest.subject, MANIFEST_MEDIA_TYPE, 'receipt subject');
  const configBytes = await client.getBlobBytes(configDescriptor.digest, configDescriptor.size, { timeoutMs });
  const config = parseJsonBytes(configBytes, 'INVALID_RECEIPT', 'Receipt config is not valid JSON.');
  const receipt = config?.receipt;
  expect(receipt?.kind === RECEIPT_KIND && receipt.schemaVersion === RECEIPT_SCHEMA_VERSION, 'INVALID_RECEIPT', 'Receipt kind or schema is invalid.');
  validateProducer(receipt.producer);
  validateCompatibility(receipt.compatibility);
  expect(receipt.compatibility.fixedRef === compatibilityRef(receipt.compatibility), 'INVALID_RECEIPT', 'Receipt compatibility reference is invalid.');
  expect(canonicalTimestamp(receipt.acknowledgedAt), 'INVALID_RECEIPT', 'Receipt acknowledgement time is invalid.');
  const [expectedOs, expectedArchitecture] = receipt.compatibility.platform.split('/');
  expect(config.os === expectedOs && config.architecture === expectedArchitecture, 'INVALID_RECEIPT', 'Receipt config platform is invalid.');
  expect(config.created === receipt.acknowledgedAt, 'INVALID_RECEIPT', 'Receipt config creation time differs from its acknowledgement.');
  expect(config.config?.Labels?.['io.github.nanazt.azuki.cache.kind'] === RECEIPT_KIND, 'INVALID_RECEIPT', 'Receipt config label is invalid.');
  const snapshotManifest = manifestDescriptor(receipt.snapshot?.manifest, MANIFEST_MEDIA_TYPE, 'receipt snapshot manifest');
  const snapshotConfig = manifestDescriptor(receipt.snapshot?.config, CONFIG_MEDIA_TYPE, 'receipt snapshot config');
  const snapshotLayer = manifestDescriptor(receipt.snapshot?.layer, LAYER_MEDIA_TYPE, 'receipt snapshot layer');
  expect(receipt.snapshot.kind === SNAPSHOT_KIND, 'INVALID_RECEIPT', 'Receipt does not identify a snapshot.');
  expect(subjectDescriptor.digest === snapshotManifest.digest && subjectDescriptor.size === snapshotManifest.size, 'INVALID_RECEIPT', 'Receipt subject differs from its snapshot manifest.');
  expect(layerDescriptor.digest === snapshotLayer.digest && layerDescriptor.size === snapshotLayer.size, 'INVALID_RECEIPT', 'Receipt layer differs from its snapshot layer.');
  expect(SHA256_PATTERN.test(receipt.snapshot.tarDigest), 'INVALID_RECEIPT', 'Receipt raw tar digest is invalid.');
  expect(config.rootfs?.type === 'layers' && Array.isArray(config.rootfs.diff_ids) && config.rootfs.diff_ids.length === 1 && config.rootfs.diff_ids[0] === receipt.snapshot.tarDigest, 'INVALID_RECEIPT', 'Receipt rootfs diff ID differs from its snapshot raw tar digest.');
  const expectedAnnotations = {
    'org.opencontainers.image.created': receipt.acknowledgedAt,
    'org.opencontainers.image.revision': receipt.producer.sourceSha,
    'io.github.nanazt.azuki.cache.kind': RECEIPT_KIND,
    'io.github.nanazt.azuki.cache.platform': receipt.compatibility.platform,
    'io.github.nanazt.azuki.cache.kache-version': receipt.compatibility.kacheVersion,
    'io.github.nanazt.azuki.cache.schema-version': String(receipt.compatibility.schemaVersion),
    'io.github.nanazt.azuki.cache.producer-repository': receipt.producer.repository,
    'io.github.nanazt.azuki.cache.producer-run-id': receipt.producer.runId,
    'io.github.nanazt.azuki.cache.producer-run-attempt': receipt.producer.runAttempt,
    'io.github.nanazt.azuki.cache.snapshot-digest': snapshotManifest.digest,
  };
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    expect(manifest.annotations?.[key] === value, 'INVALID_RECEIPT', 'Receipt annotation differs from its config.');
  }
  const ref = receiptReference(receipt.compatibility, receipt.producer, snapshotManifest.digest);
  expect(version.tags.includes(ref), 'INVALID_RECEIPT', 'Receipt version is missing its immutable reference.');
  expect(version.tags.every((tag) => tag === ref), 'INVALID_RECEIPT', 'Receipt version carries an unrelated tag.');
  return {
    type: 'receipt',
    version,
    digest: resolved.digest,
    ref,
    compatibility: receipt.compatibility,
    producer: receipt.producer,
    acknowledgedAt: receipt.acknowledgedAt,
    snapshotManifest,
    snapshotConfig,
    snapshotLayer,
    snapshotTarDigest: receipt.snapshot.tarDigest,
    dependencies: manifestDependencies(manifest),
  };
}

async function classifyPackageVersion(client, rawVersion, deadline) {
  const version = validatePackageVersion(rawVersion);
  const timeoutMs = remainingTime(deadline, 'Registry classification');
  const resolved = await client.getAnyManifest(version.digest, { timeoutMs });
  expect(resolved.digest === version.digest, 'INVALID_PACKAGE_VERSION', 'GitHub package version digest differs from the registry manifest.');
  const dependencies = manifestDependencies(resolved.manifest);
  if (resolved.contentType === MANIFEST_MEDIA_TYPE && resolved.manifest?.artifactType === SNAPSHOT_KIND) {
    try {
      return await readRetentionSnapshot(client, resolved, version, remainingTime(deadline, 'Snapshot classification'));
    } catch (error) {
      return { type: 'unknown', version, digest: version.digest, dependencies, error };
    }
  }
  if (resolved.contentType === MANIFEST_MEDIA_TYPE && resolved.manifest?.artifactType === RECEIPT_KIND) {
    try {
      return await readRetentionReceipt(client, resolved, version, remainingTime(deadline, 'Receipt classification'));
    } catch (error) {
      return { type: 'unknown', version, digest: version.digest, dependencies, error };
    }
  }
  return { type: 'other', version, digest: version.digest, dependencies };
}

function receiptMatchesSnapshot(receipt, snapshot) {
  return sameCompatibility(receipt.compatibility, snapshot.compatibility)
    && stableJson(receipt.producer) === stableJson(snapshot.producer)
    && receipt.snapshotManifest.digest === snapshot.manifestDescriptor.digest
    && receipt.snapshotManifest.size === snapshot.manifestDescriptor.size
    && receipt.snapshotConfig.digest === snapshot.configDescriptor.digest
    && receipt.snapshotConfig.size === snapshot.configDescriptor.size
    && receipt.snapshotLayer.digest === snapshot.layerDescriptor.digest
    && receipt.snapshotLayer.size === snapshot.layerDescriptor.size
    && receipt.snapshotTarDigest === snapshot.tarDigest;
}

function addRetentionWarning(warnings, limits, code, message) {
  if (warnings.length < limits.maxWarnings) warnings.push({ code, message });
}

async function resolveExactRef(client, reference, digest, deadline) {
  const resolved = await client.getManifest(reference, { missing: true, timeoutMs: remainingTime(deadline, 'Registry reference revalidation') });
  expect(resolved?.digest === digest, 'RETENTION_REF_CHANGED', 'A protected registry reference changed during cleanup.', { reference });
}

async function revalidateProtectedRefs(client, compatibility, current, predecessor, deadline) {
  await resolveExactRef(client, current.immutableRef, current.digest, deadline);
  await resolveExactRef(client, current.receipt.ref, current.receipt.digest, deadline);
  if (predecessor) {
    await resolveExactRef(client, predecessor.immutableRef, predecessor.digest, deadline);
    await resolveExactRef(client, predecessor.receipt.ref, predecessor.receipt.digest, deadline);
  }
  await resolveExactRef(client, compatibility.fixedRef, current.digest, deadline);
}

async function revalidateDeletionRefs(client, compatibility, current, predecessor, candidate, receipt, deadline) {
  await resolveExactRef(client, candidate.immutableRef, candidate.digest, deadline);
  await resolveExactRef(client, receipt.ref, receipt.digest, deadline);
  await revalidateProtectedRefs(client, compatibility, current, predecessor, deadline);
}

export async function runPostPublicationRetention({ client, github, compatibility, producer, limits = {} }) {
  validateProducer(producer);
  validateCompatibility(compatibility);
  const retentionLimits = normalizeRetentionLimits(limits);
  expect(client.repository === `${producer.repository}-build-cache`, 'UNSAFE_RETENTION_SCOPE', 'Cleanup is restricted to the exact producer build-cache repository.');
  expect(client.repository !== producer.repository, 'UNSAFE_RETENTION_SCOPE', 'Cleanup cannot target the runtime repository.');
  const deadline = Date.now() + retentionLimits.timeoutMs;
  const warnings = [];
  const rawVersions = await github.listPackageVersions(producer.repository, client.repository, deadline);
  const objects = [];
  const versionIds = new Set();
  const versionDigests = new Set();
  for (const rawVersion of rawVersions) {
    const object = await classifyPackageVersion(client, rawVersion, deadline);
    expect(!versionIds.has(object.version.id) && !versionDigests.has(object.digest), 'INVALID_PACKAGE_VERSION', 'GitHub package version listing contains a duplicate.');
    versionIds.add(object.version.id);
    versionDigests.add(object.digest);
    objects.push(object);
  }
  const snapshots = objects.filter((object) => object.type === 'snapshot' && sameCompatibility(object.compatibility, compatibility) && object.producer.repository === producer.repository);
  const receipts = objects.filter((object) => object.type === 'receipt' && sameCompatibility(object.compatibility, compatibility) && object.producer.repository === producer.repository);
  for (const snapshot of snapshots) snapshot.receipts = receipts.filter((receipt) => receiptMatchesSnapshot(receipt, snapshot));
  const pairedReceipts = new Set(snapshots.flatMap((snapshot) => snapshot.receipts));
  const fixed = await client.getManifest(compatibility.fixedRef, { missing: true, timeoutMs: remainingTime(deadline, 'Current reference resolution') });
  expect(fixed, 'RETENTION_CURRENT_UNKNOWN', 'Current snapshot reference disappeared before cleanup.');
  const current = snapshots.find((snapshot) => snapshot.digest === fixed.digest);
  expect(current && current.receipts.length === 1, 'RETENTION_CURRENT_UNKNOWN', 'Current snapshot or its exact completion receipt is not fully visible.');
  current.receipt = current.receipts[0];
  const protectedDigests = new Set([current.digest]);
  for (const object of objects) {
    if (pairedReceipts.has(object)) continue;
    for (const dependency of object.dependencies) protectedDigests.add(dependency);
  }
  const completed = [];
  for (const snapshot of snapshots) {
    if (snapshot.version.tags.includes(compatibility.fixedRef)) {
      protectedDigests.add(snapshot.digest);
      continue;
    }
    if (snapshot.digest === current.digest) continue;
    if (snapshot.receipts.length !== 1) {
      protectedDigests.add(snapshot.digest);
      continue;
    }
    snapshot.receipt = snapshot.receipts[0];
    try {
      const attempt = await github.workflowAttempt(snapshot.producer, deadline);
      if (attempt.status === 'completed' && attempt.conclusion === 'success') completed.push(snapshot);
      else protectedDigests.add(snapshot.digest);
    } catch (error) {
      protectedDigests.add(snapshot.digest);
      addRetentionWarning(warnings, retentionLimits, error?.code ?? 'ATTEMPT_UNQUERYABLE', 'A producer attempt could not be confirmed and its snapshot was protected.');
    }
  }
  completed.sort((left, right) => right.version.createdAt.localeCompare(left.version.createdAt) || right.digest.localeCompare(left.digest));
  const predecessor = completed[0] ?? null;
  if (predecessor) protectedDigests.add(predecessor.digest);
  const eligible = completed
    .slice(1)
    .filter((snapshot) => !protectedDigests.has(snapshot.digest))
    .sort((left, right) => left.version.createdAt.localeCompare(right.version.createdAt) || left.digest.localeCompare(right.digest));
  const deleted = [];
  for (const candidate of eligible) {
    try {
      await revalidateDeletionRefs(client, compatibility, current, predecessor, candidate, candidate.receipt, deadline);
      await github.deletePackageVersion(producer.repository, client.repository, candidate.version.id, deadline);
      deleted.push({ snapshotDigest: candidate.digest, snapshotVersionId: candidate.version.id, receiptDigest: candidate.receipt.digest, receiptVersionId: candidate.receipt.version.id, receiptDeleted: false });
      await revalidateProtectedRefs(client, compatibility, current, predecessor, deadline);
      await github.deletePackageVersion(producer.repository, client.repository, candidate.receipt.version.id, deadline);
      deleted.at(-1).receiptDeleted = true;
    } catch (error) {
      addRetentionWarning(warnings, retentionLimits, error?.code ?? 'RETENTION_DELETE_FAILED', 'Snapshot cleanup stopped after a protected reference or exact deletion could not be confirmed.');
      return {
        status: deleted.length > 0 ? 'partial' : 'skipped',
        reason: 'cleanup-uncertain',
        currentDigest: current.digest,
        predecessorDigest: predecessor?.digest ?? null,
        deleted,
        protectedCount: protectedDigests.size,
        warnings,
      };
    }
  }
  return {
    status: 'completed',
    currentDigest: current.digest,
    predecessorDigest: predecessor?.digest ?? null,
    deleted,
    protectedCount: protectedDigests.size,
    warnings,
  };
}

export async function publishSnapshotFromDirectory({ client, sourceDir, compatibility, producer, limits = client.limits, createdAt = new Date().toISOString(), retention, emitWarning = () => {} }) {
  validateCompatibility(compatibility);
  validateReference(compatibility.fixedRef, 'fixed reference');
  expect(compatibility.fixedRef === compatibilityRef(compatibility), 'INVALID_FIXED_REF', 'Fixed reference must be derived only from compatibility inputs.');
  validateProducer(producer);
  validateCacheScope(client, producer.repository);
  expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) && !Number.isNaN(Date.parse(createdAt)), 'INVALID_CREATED_AT', 'Snapshot creation time must be canonical UTC.');
  const workspace = await mkdtemp(path.join(tmpdir(), 'azuki-cache-publish-'));
  const rawArchive = path.join(workspace, 'snapshot.tar');
  const compressedArchive = path.join(workspace, 'snapshot.tar.gz');
  let phase = 'capture';
  let immutableRef;
  let manifestDigest;
  try {
    const rawPayload = await createTarFromDirectory(sourceDir, rawArchive, limits);
    const compressionStartedAt = performance.now();
    phase = 'compress-payload';
    const compressedPayload = await compressTarToGzip(rawArchive, compressedArchive, limits, {
      reservedDiskBytes: rawPayload.unpackedSize,
    });
    const compressionMs = performance.now() - compressionStartedAt;
    const payload = {
      mediaType: LAYER_MEDIA_TYPE,
      compression: 'gzip',
      digest: compressedPayload.digest,
      size: compressedPayload.size,
      tarDigest: rawPayload.digest,
      tarSize: rawPayload.size,
      fileBytes: rawPayload.unpackedSize,
      fileCount: rawPayload.fileCount,
    };
    await unlink(rawArchive);
    const uploadStartedAt = performance.now();
    phase = 'upload-payload';
    await client.uploadFile(compressedArchive, payload.digest, payload.size);
    const configBytes = jsonBytes(snapshotConfig({ compatibility, producer, payload, createdAt }));
    phase = 'upload-config';
    const configDescriptor = await client.uploadBytes(configBytes);
    const manifestBytes = jsonBytes({
      schemaVersion: 2,
      mediaType: MANIFEST_MEDIA_TYPE,
      artifactType: SNAPSHOT_KIND,
      config: { mediaType: CONFIG_MEDIA_TYPE, ...configDescriptor },
      layers: [{ mediaType: LAYER_MEDIA_TYPE, digest: payload.digest, size: payload.size }],
      annotations: {
        'org.opencontainers.image.created': createdAt,
        'org.opencontainers.image.revision': producer.sourceSha,
        'io.github.nanazt.azuki.cache.kind': SNAPSHOT_KIND,
        'io.github.nanazt.azuki.cache.platform': compatibility.platform,
        'io.github.nanazt.azuki.cache.kache-version': compatibility.kacheVersion,
        'io.github.nanazt.azuki.cache.schema-version': String(compatibility.schemaVersion),
        'io.github.nanazt.azuki.cache.producer-repository': producer.repository,
        'io.github.nanazt.azuki.cache.producer-run-id': producer.runId,
        'io.github.nanazt.azuki.cache.producer-run-attempt': producer.runAttempt,
      },
    });
    manifestDigest = sha256Buffer(manifestBytes);
    immutableRef = immutableReference(compatibility, producer, manifestDigest);
    phase = 'upload-candidate';
    expect(await client.putManifest(immutableRef, manifestBytes) === manifestDigest, 'MANIFEST_VERIFY_FAILED', 'Candidate manifest digest changed while uploading.');
    const candidate = await client.getManifest(immutableRef);
    expect(candidate.digest === manifestDigest && candidate.bytes.equals(manifestBytes), 'MANIFEST_VERIFY_FAILED', 'Candidate manifest did not verify byte-for-byte.');
    phase = 'promote';
    try {
      expect(await client.putManifest(compatibility.fixedRef, manifestBytes) === manifestDigest, 'PROMOTION_FAILED', 'Promoted manifest digest changed while uploading.');
    } catch (error) {
      let observed;
      try {
        observed = await client.getManifest(compatibility.fixedRef, { missing: true });
      } catch {
        // A failed observation cannot prove whether a timed-out promotion committed.
      }
      if (observed?.digest !== manifestDigest) {
        throw new CacheTransportError('PROMOTION_FAILED', 'Snapshot promotion did not complete with this producer digest.', {
          publication: error?.code === 'REGISTRY_TIMEOUT' || error?.code === 'REGISTRY_IO' ? 'uncertain' : 'abandoned',
          phase,
          immutableRef,
          manifestDigest,
          observedDigest: observed?.digest ?? null,
        }, { cause: error });
      }
    }
    phase = 'verify-promotion';
    const promoted = await client.getManifest(compatibility.fixedRef);
    expect(promoted.digest === manifestDigest && promoted.bytes.equals(manifestBytes), 'PROMOTION_VERIFY_FAILED', 'Fixed reference does not resolve to this producer snapshot.', { expected: manifestDigest, actual: promoted.digest });
    const uploadMs = performance.now() - uploadStartedAt;
    const publication = {
      status: 'published',
      publication: 'promoted',
      fixedRef: compatibility.fixedRef,
      immutableRef,
      manifestDigest,
      manifestDescriptor: { mediaType: MANIFEST_MEDIA_TYPE, digest: manifestDigest, size: manifestBytes.length },
      configDescriptor: { mediaType: CONFIG_MEDIA_TYPE, ...configDescriptor },
      layerDescriptor: { mediaType: LAYER_MEDIA_TYPE, digest: payload.digest, size: payload.size },
      payloadDigest: payload.digest,
      tarDigest: payload.tarDigest,
      transferBytes: payload.size,
      tarBytes: payload.tarSize,
      payloadFileBytes: payload.fileBytes,
      fileCount: payload.fileCount,
      producer,
      timingMs: { compression: compressionMs, upload: uploadMs },
    };
    let receipt;
    try {
      receipt = await publishCompletionReceipt({ client, publication, compatibility });
    } catch (error) {
      const warning = { code: error?.code ?? 'RECEIPT_UNCONFIRMED', message: 'Snapshot promotion succeeded, but its completion receipt could not be confirmed; the current snapshot remains protected and cleanup was skipped.' };
      try {
        emitWarning(warning);
      } catch {
        // Cache warning output cannot change a successful publication.
      }
      return {
        ...publication,
        receipt: { status: 'unconfirmed' },
        retention: { status: 'skipped', reason: 'receipt-unconfirmed', deleted: [], warnings: [warning] },
      };
    }
    if (!retention?.github) {
      return {
        ...publication,
        receipt,
        retention: { status: 'not-run', reason: 'github-client-not-configured', deleted: [], warnings: [] },
      };
    }
    let retentionResult;
    try {
      retentionResult = await runPostPublicationRetention({
        client,
        github: retention.github,
        compatibility,
        producer,
        limits: retention.limits,
      });
    } catch (error) {
      const warning = { code: error?.code ?? 'RETENTION_UNCERTAIN', message: 'Snapshot promotion and receipt succeeded, but retention could not prove a safe deletion set; cleanup was skipped.' };
      retentionResult = { status: 'skipped', reason: 'cleanup-uncertain', deleted: [], warnings: [warning] };
    }
    for (const warning of retentionResult.warnings) {
      try {
        emitWarning(warning);
      } catch {
        // Cache warning output cannot change a successful publication.
      }
    }
    return { ...publication, receipt, retention: retentionResult };
  } catch (error) {
    if (error instanceof CacheTransportError && error.details.publication) throw error;
    throw new CacheTransportError('PUBLISH_FAILED', 'Cache snapshot publication failed before verified promotion.', {
      publication: phase === 'promote' || phase === 'verify-promotion' ? 'uncertain' : 'abandoned',
      phase,
      immutableRef: immutableRef ?? null,
      manifestDigest: manifestDigest ?? null,
    }, { cause: error });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function downloadSnapshotToDirectory({ client, destination, compatibility, limits = client.limits }) {
  const downloadStartedAt = performance.now();
  const resolved = await resolveSnapshot(client, compatibility);
  if (!resolved) return { status: 'miss', reason: 'not-found', timingMs: { download: performance.now() - downloadStartedAt } };
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(parent, '.azuki-cache-restore-'));
  const compressedArchive = path.join(workspace, 'snapshot.tar.gz');
  const rawArchive = path.join(workspace, 'snapshot.tar');
  const extracted = path.join(workspace, 'store');
  try {
    await client.downloadBlob(resolved.layerDescriptor.digest, compressedArchive, resolved.layerDescriptor.size);
    const downloadMs = performance.now() - downloadStartedAt;
    const decompressionStartedAt = performance.now();
    const decompressed = await decompressGzipToTar(compressedArchive, rawArchive, limits, {
      expectedDigest: resolved.metadata.payload.tarDigest,
      expectedSize: resolved.metadata.payload.tarSize,
    });
    await unlink(compressedArchive);
    const observed = await extractTarToDirectory(rawArchive, extracted, limits);
    expect(observed.unpackedSize === resolved.metadata.payload.fileBytes && observed.fileCount === resolved.metadata.payload.fileCount, 'PAYLOAD_MISMATCH', 'Extracted payload totals differ from verified metadata.', { expected: resolved.metadata.payload, observed });
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
    const decompressionMs = performance.now() - decompressionStartedAt;
    return {
      status: 'restored',
      manifestDigest: resolved.manifestDigest,
      payloadDigest: resolved.layerDescriptor.digest,
      tarDigest: decompressed.digest,
      transferBytes: resolved.layerDescriptor.size,
      tarBytes: decompressed.size,
      payloadFileBytes: observed.unpackedSize,
      fileCount: observed.fileCount,
      producer: resolved.metadata.producer,
      timingMs: { download: downloadMs, decompression: decompressionMs },
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function redact(text, secrets) {
  let output = text;
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join('[REDACTED]');
  return output;
}

async function executeBounded(binary, args, {
  cwd,
  timeoutMs,
  maxOutputBytes,
  secrets = [],
  stdoutFile,
  maxStdoutBytes = maxOutputBytes,
}) {
  const child = spawn(binary, args, {
    cwd,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let total = 0;
  let timedOut = false;
  let overflow = false;
  let pipeError;
  let killTimer;
  const terminate = (signal = 'SIGTERM') => {
    if (!child.pid) return;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    terminate();
    killTimer ??= setTimeout(() => terminate('SIGKILL'), 2_000).unref();
  };
  const collect = (which, chunk) => {
    total += chunk.length;
    if (total > maxOutputBytes) {
      overflow = true;
      stop();
      return which;
    }
    return Buffer.concat([which, chunk]);
  };
  let stdoutPipeline = Promise.resolve();
  if (stdoutFile) {
    let written = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length;
        if (written > maxStdoutBytes) {
          overflow = true;
          stop();
          callback(new CacheTransportError('COMMAND_OUTPUT_LIMIT', 'Command payload exceeded its output limit.'));
        } else {
          callback(null, chunk);
        }
      },
    });
    stdoutPipeline = pipeline(
      child.stdout,
      limiter,
      createWriteStream(stdoutFile, { flags: 'wx', mode: 0o600 }),
    ).catch((error) => {
      pipeError = error;
      stop();
    });
  } else {
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
  }
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
  const onSignal = () => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs).unref();
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await stdoutPipeline;
  } catch (error) {
    fail('COMMAND_UNAVAILABLE', 'Could not start a required cache transport command.', { command: binary, reason: errorMessage(error) });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  const details = {
    command: binary,
    exitCode: result.code,
    signal: result.signal,
    stdout: redact(stdout.toString('utf8'), secrets).slice(-8192),
    stderr: redact(stderr.toString('utf8'), secrets).slice(-8192),
  };
  if (timedOut) fail('COMMAND_TIMEOUT', 'Cache transport command exceeded its bounded wait.', details);
  if (overflow) fail('COMMAND_OUTPUT_LIMIT', 'Cache transport command exceeded its output limit.', details);
  if (pipeError) fail('COMMAND_OUTPUT_FAILED', 'Could not preserve bounded cache transport output.', { ...details, reason: errorMessage(pipeError) });
  expect(result.code === 0, 'COMMAND_FAILED', 'Cache transport command failed.', details);
  return details;
}

async function runMountTransfer({ mode, builder, cacheId, cacheTarget, transferImage, localDirectory, registry, limits, secrets }) {
  validateMount({ builder, cacheId, cacheTarget, transferImage, registry });
  const workspace = await mkdtemp(path.join(tmpdir(), 'azuki-cache-mount-'));
  const dockerfile = path.join(workspace, 'Dockerfile');
  const nonce = randomUUID();
  const mount = `type=cache,id=${cacheId},target=${cacheTarget},sharing=locked`;
  const clean = `find ${shellQuote(cacheTarget)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`;
  try {
    let content;
    let args;
    if (mode === 'extract') {
      const exportedArchive = path.join(workspace, 'mount.tar');
      content = `# syntax=docker/dockerfile:1\nFROM ${transferImage} AS transfer\nARG SNAPSHOT_NONCE\nRUN --mount=${mount} set -eu; mkdir -p /snapshot; cp -a ${shellQuote(`${cacheTarget}/.`)} /snapshot/\nFROM scratch\nCOPY --from=transfer /snapshot/ /\n`;
      // The nonce reruns extraction without discarding the selected BuildKit cache mount.
      args = ['buildx', 'build', '--builder', builder, '--file', dockerfile, '--progress', 'plain', '--build-arg', `SNAPSHOT_NONCE=${nonce}`, '--output', 'type=tar,dest=-', workspace];
      await writeFile(dockerfile, content, { mode: 0o600 });
      await executeBounded('docker', args, {
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxCommandOutputBytes,
        stdoutFile: exportedArchive,
        maxStdoutBytes: limits.maxUnpackedBytes,
        secrets,
      });
      await extractTarToDirectory(exportedArchive, localDirectory, limits);
      return;
    } else {
      if (mode === 'inject') {
        await rename(localDirectory, path.join(workspace, 'store'));
        // Preserve the 0755 root created by COPY instead of propagating the private staging directory's mode.
        content = `# syntax=docker/dockerfile:1\nFROM ${transferImage}\nARG SNAPSHOT_NONCE\nRUN --mount=type=bind,source=store,target=/incoming,readonly --mount=${mount} set -eu; ${clean}; cp -a /incoming/. ${shellQuote(cacheTarget)}/; chmod 0755 ${shellQuote(cacheTarget)}\n`;
      } else {
        content = `# syntax=docker/dockerfile:1\nFROM ${transferImage}\nARG SNAPSHOT_NONCE\nRUN --mount=${mount} set -eu; ${clean}\n`;
      }
      args = ['buildx', 'build', '--builder', builder, '--file', dockerfile, '--progress', 'plain', '--build-arg', `SNAPSHOT_NONCE=${nonce}`, '--output', 'type=cacheonly', workspace];
    }
    await writeFile(dockerfile, content, { mode: 0o600 });
    await executeBounded('docker', args, { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, secrets });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function publishSnapshot(options) {
  validateProducer(options.producer);
  validateCacheScope(options.client, options.producer.repository);
  const workspace = await mkdtemp(path.join(tmpdir(), 'azuki-cache-extract-'));
  const extracted = path.join(workspace, 'store');
  try {
    const extractionStartedAt = performance.now();
    await runMountTransfer({ mode: 'extract', ...options, localDirectory: extracted });
    const extractionMs = performance.now() - extractionStartedAt;
    const result = await publishSnapshotFromDirectory({
      client: options.client,
      sourceDir: extracted,
      compatibility: options.compatibility,
      producer: options.producer,
      limits: options.limits,
      retention: options.retention,
      emitWarning: options.emitWarning,
    });
    return { ...result, timingMs: { extraction: extractionMs, ...result.timingMs } };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function restoreSnapshot(options) {
  const restored = path.join(await mkdtemp(path.join(tmpdir(), 'azuki-cache-download-')), 'store');
  try {
    const result = await downloadSnapshotToDirectory({
      client: options.client,
      destination: restored,
      compatibility: options.compatibility,
      limits: options.limits,
    });
    if (result.status === 'miss') {
      await runMountTransfer({ mode: 'clear', ...options });
      return result;
    }
    const injectionStartedAt = performance.now();
    await runMountTransfer({ mode: 'inject', ...options, localDirectory: restored });
    return { ...result, timingMs: { ...result.timingMs, injection: performance.now() - injectionStartedAt } };
  } catch (error) {
    await runMountTransfer({ mode: 'clear', ...options }).catch((clearError) => {
      throw new CacheTransportError('RESTORE_CLEAR_FAILED', 'Restore failed and the cache mount could not be returned to a clean miss state.', {}, { cause: clearError });
    });
    throw error;
  } finally {
    await rm(path.dirname(restored), { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const command = argv[0];
  expect(command === 'restore' || command === 'publish', 'USAGE', 'First argument must be restore or publish.');
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    expect(flag?.startsWith('--') && index + 1 < argv.length, 'USAGE', 'Every option must be a --name value pair.', { flag });
    expect(!values.has(flag), 'USAGE', 'Option was supplied more than once.', { flag });
    values.set(flag, argv[index + 1]);
  }
  const take = (name, fallback) => {
    const flag = `--${name}`;
    const value = values.has(flag) ? values.get(flag) : fallback;
    values.delete(flag);
    expect(value !== undefined, 'USAGE', `Missing required option ${flag}.`);
    return value;
  };
  const registryRaw = take('registry');
  const registry = normalizeRegistryUrl(registryRaw);
  const repository = take('repository');
  const platform = take('platform');
  const kacheVersion = take('kache-version');
  const schemaVersion = positiveInteger(take('schema-version'), 'schemaVersion');
  const fixedRef = take('fixed-ref');
  const usernameEnv = take('username-env', 'REGISTRY_USERNAME');
  const tokenEnv = take('token-env', 'REGISTRY_TOKEN');
  expect(/^[A-Z_][A-Z0-9_]*$/u.test(usernameEnv) && /^[A-Z_][A-Z0-9_]*$/u.test(tokenEnv), 'USAGE', 'Credential options must name environment variables.');
  const username = process.env[usernameEnv];
  const token = process.env[tokenEnv];
  const limits = normalizeLimits({
    maxTransferBytes: take('max-transfer-bytes', DEFAULT_LIMITS.maxTransferBytes),
    maxUnpackedBytes: take('max-unpacked-bytes', DEFAULT_LIMITS.maxUnpackedBytes),
    maxDiskBytes: take('max-disk-bytes', DEFAULT_LIMITS.maxDiskBytes),
    maxFiles: take('max-files', DEFAULT_LIMITS.maxFiles),
    maxMetadataBytes: take('max-metadata-bytes', DEFAULT_LIMITS.maxMetadataBytes),
    maxCommandOutputBytes: take('max-command-output-bytes', DEFAULT_LIMITS.maxCommandOutputBytes),
    timeoutMs: take('timeout-ms', DEFAULT_LIMITS.timeoutMs),
  });
  const options = {
    command,
    builder: take('builder'),
    cacheId: take('cache-id'),
    cacheTarget: take('cache-target'),
    transferImage: take('transfer-image'),
    registry,
    registryRaw,
    repository,
    compatibility: { platform, kacheVersion, schemaVersion, fixedRef },
    username,
    token,
    limits,
  };
  if (command === 'publish') {
    options.producer = {
      repository: take('producer-repository'),
      runId: take('run-id'),
      runAttempt: take('run-attempt'),
      sourceSha: take('source-sha'),
    };
    validateProducer(options.producer);
    const githubTokenEnv = take('github-token-env', 'REGISTRY_TOKEN');
    expect(/^[A-Z_][A-Z0-9_]*$/u.test(githubTokenEnv), 'USAGE', 'GitHub credential option must name an environment variable.');
    options.github = {
      origin: take('github-api-origin', GITHUB_API_ORIGIN),
      token: process.env[githubTokenEnv],
      tokenEnv: githubTokenEnv,
      limits: normalizeRetentionLimits({
        maxPages: take('retention-max-pages', DEFAULT_RETENTION_LIMITS.maxPages),
        maxVersions: take('retention-max-versions', DEFAULT_RETENTION_LIMITS.maxVersions),
        perPage: take('retention-per-page', DEFAULT_RETENTION_LIMITS.perPage),
        timeoutMs: take('retention-timeout-ms', DEFAULT_RETENTION_LIMITS.timeoutMs),
        maxWarnings: take('retention-max-warnings', DEFAULT_RETENTION_LIMITS.maxWarnings),
      }),
    };
  }
  expect(values.size === 0, 'USAGE', 'Unknown command options were supplied.', { options: [...values.keys()] });
  validateRepository(repository);
  validateMount({ ...options, registry });
  validateCompatibility(options.compatibility);
  validateReference(fixedRef, 'fixed reference');
  expect(fixedRef === compatibilityRef(options.compatibility), 'INVALID_FIXED_REF', 'Fixed reference must be derived only from compatibility inputs.', { expected: compatibilityRef(options.compatibility), actual: fixedRef });
  return options;
}

function publicError(error) {
  const chain = [];
  for (let current = error; current instanceof Error && chain.length < 5; current = current.cause) {
    chain.push({ code: current.code ?? 'ERROR', message: current.message });
  }
  return {
    status: 'failed',
    code: error?.code ?? 'ERROR',
    message: errorMessage(error),
    publication: error?.details?.publication,
    phase: error?.details?.phase,
    immutableRef: error?.details?.immutableRef,
    manifestDigest: error?.details?.manifestDigest,
    observedDigest: error?.details?.observedDigest,
    causes: chain,
  };
}

function emitWorkflowWarning(warning) {
  const value = `[${warning.code}] ${warning.message}`.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  process.stderr.write(`::warning::${value}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    const client = new RegistryClient({
      registry: options.registryRaw,
      repository: options.repository,
      username: options.username,
      token: options.token,
      limits: options.limits,
    });
    let retention;
    if (options.command === 'publish' && options.github.token !== undefined) {
      retention = {
        github: new GitHubRetentionClient({
          token: options.github.token,
          registry: client.registry,
          origin: options.github.origin,
          limits: options.github.limits,
          maxBodyBytes: options.limits.maxMetadataBytes,
        }),
        limits: options.github.limits,
      };
    } else if (options.command === 'publish') {
      emitWorkflowWarning({ code: 'GITHUB_TOKEN_MISSING', message: `Retention was skipped because ${options.github.tokenEnv} was not set; the verified receipt keeps the snapshot protected.` });
    }
    const shared = {
      client,
      builder: options.builder,
      cacheId: options.cacheId,
      cacheTarget: options.cacheTarget,
      transferImage: options.transferImage,
      registry: options.registry,
      compatibility: options.compatibility,
      limits: options.limits,
      secrets: [options.username, options.token, options.github?.token],
    };
    const result = options.command === 'publish'
      ? await publishSnapshot({ ...shared, producer: options.producer, retention, emitWarning: emitWorkflowWarning })
      : await restoreSnapshot(shared);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicError(error))}\n`);
    return error?.code === 'USAGE' ? 2 : 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await main();

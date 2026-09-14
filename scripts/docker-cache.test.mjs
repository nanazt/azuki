import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CacheTransportError,
  GitHubRetentionClient,
  RegistryClient,
  compatibilityRef,
  createTarFromDirectory,
  compressTarToGzip,
  decompressGzipToTar,
  downloadSnapshotToDirectory,
  extractTarToDirectory,
  makeTarHeader,
  publishSnapshotFromDirectory,
  resolveSnapshot,
  runPostPublicationRetention,
} from './docker-cache.mjs';

const REPOSITORY = 'nanazt/azuki-build-cache';
const PRODUCER_A = Object.freeze({
  repository: 'nanazt/azuki',
  runId: '34756435891',
  runAttempt: '1',
  sourceSha: '0123456789abcdef0123456789abcdef01234567',
});
const PRODUCER_B = Object.freeze({
  repository: 'nanazt/azuki',
  runId: '34756435892',
  runAttempt: '2',
  sourceSha: '89abcdef0123456789abcdef0123456789abcdef',
});
const COMPATIBILITY = Object.freeze({
  platform: 'linux/amd64',
  schemaVersion: 1,
  kacheVersion: '0.20.0',
  fixedRef: 'kache-linux-amd64-s1-kache-0.20.0',
});
const TEST_LIMITS = Object.freeze({
  maxTransferBytes: 4 * 1024 * 1024,
  maxUnpackedBytes: 4 * 1024 * 1024,
  maxDiskBytes: 8 * 1024 * 1024,
  maxFiles: 100,
  maxMetadataBytes: 128 * 1024,
  maxCommandOutputBytes: 128 * 1024,
  timeoutMs: 2_000,
});

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'azuki-docker-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function collectRequest(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('fixture request exceeded limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function registryFixture(t) {
  const blobs = new Map();
  const manifests = new Map();
  const tags = new Map();
  const uploads = new Map();
  const state = {
    failFixedPromotion: false,
    corruptBlob: null,
    hangManifest: false,
    fixedPutAttempts: 0,
    failReceipt: false,
    requireAuth: false,
    tokenRequests: 0,
    beforeFixedPromotion: null,
  };
  let nextUpload = 1;
  const prefix = `/v2/${REPOSITORY}/`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/token') {
        if (request.headers.authorization !== `Basic ${Buffer.from('fixture-user:fixture-secret').toString('base64')}`) {
          response.writeHead(401).end();
          return;
        }
        state.tokenRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'fixture-bearer-token' }));
        return;
      }
      if (state.requireAuth && request.headers.authorization !== 'Bearer fixture-bearer-token') {
        response.writeHead(401, {
          'www-authenticate': `Bearer realm=\"http://${request.headers.host}/token\",service=\"fixture\",scope=\"repository:${REPOSITORY}:pull,push\"`,
        }).end();
        return;
      }
      if (url.pathname === '/v2/') {
        response.writeHead(200).end();
        return;
      }
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const suffix = url.pathname.slice(prefix.length);
      if (suffix === 'blobs/uploads/' && request.method === 'POST') {
        const id = String(nextUpload++);
        uploads.set(id, Buffer.alloc(0));
        response.writeHead(202, { location: `${prefix}blobs/uploads/${id}` }).end();
        return;
      }
      const upload = /^blobs\/uploads\/([^/]+)$/u.exec(suffix);
      if (upload && request.method === 'PATCH') {
        const bytes = await collectRequest(request);
        uploads.set(upload[1], bytes);
        response.writeHead(202, { location: `${prefix}blobs/uploads/${upload[1]}` }).end();
        return;
      }
      if (upload && request.method === 'PUT') {
        const bytes = uploads.get(upload[1]);
        const expected = url.searchParams.get('digest');
        if (!bytes || digest(bytes) !== expected) {
          response.writeHead(400).end();
          return;
        }
        blobs.set(expected, bytes);
        uploads.delete(upload[1]);
        response.writeHead(201, { 'docker-content-digest': expected, location: `${prefix}blobs/${expected}` }).end();
        return;
      }
      const blob = /^blobs\/(sha256:[0-9a-f]{64})$/u.exec(decodeURIComponent(suffix));
      if (blob && request.method === 'HEAD') {
        const bytes = blobs.get(blob[1]);
        if (!bytes) response.writeHead(404).end();
        else response.writeHead(200, { 'content-length': String(bytes.length), 'docker-content-digest': blob[1] }).end();
        return;
      }
      if (blob && request.method === 'GET') {
        const stored = blobs.get(blob[1]);
        if (!stored) {
          response.writeHead(404).end();
          return;
        }
        const bytes = state.corruptBlob === blob[1] ? Buffer.from(stored.map((value, index) => index === 0 ? value ^ 0xff : value)) : stored;
        response.writeHead(200, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' });
        response.end(bytes);
        return;
      }
      const manifest = /^manifests\/(.+)$/u.exec(suffix);
      if (manifest) {
        const reference = decodeURIComponent(manifest[1]);
        if (request.method === 'PUT') {
          const bytes = await collectRequest(request);
          const manifestDigest = digest(bytes);
          if (reference === COMPATIBILITY.fixedRef) {
            state.fixedPutAttempts += 1;
            if (state.failFixedPromotion) {
              response.writeHead(503).end('promotion unavailable');
              return;
            }
          }
          if (reference === COMPATIBILITY.fixedRef && state.beforeFixedPromotion) {
            const beforeFixedPromotion = state.beforeFixedPromotion;
            state.beforeFixedPromotion = null;
            await beforeFixedPromotion();
          }
          if (reference.startsWith('receipt-') && state.failReceipt) {
            response.writeHead(503).end('receipt unavailable');
            return;
          }
          manifests.set(manifestDigest, bytes);
          tags.set(reference, manifestDigest);
          response.writeHead(201, { 'docker-content-digest': manifestDigest, location: `${prefix}manifests/${manifestDigest}` }).end();
          return;
        }
        if (request.method === 'GET') {
          if (state.hangManifest) return;
          const manifestDigest = reference.startsWith('sha256:') ? reference : tags.get(reference);
          const bytes = manifests.get(manifestDigest);
          if (!bytes) {
            response.writeHead(404).end();
            return;
          }
          const contentType = JSON.parse(bytes.toString('utf8')).mediaType;
          response.writeHead(200, {
            'content-length': String(bytes.length),
            'content-type': contentType,
            'docker-content-digest': manifestDigest,
          });
          response.end(bytes);
          return;
        }
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    blobs,
    manifests,
    tags,
    state,
  };
}

function registryClient(fixture, limits = TEST_LIMITS) {
  return new RegistryClient({ registry: fixture.origin, repository: REPOSITORY, limits });
}

async function githubFixture(t, registry) {
  const ids = new Map();
  const digestById = new Map();
  const state = {
    attempts: new Map(),
    attemptFailures: new Set(),
    deleted: [],
    deleteFailures: new Set(),
    createdAtOverrides: new Map(),
    beforeDelete: null,
    afterAttempt: null,
    forceNextPage: false,
    wrongPackageType: false,
    hangList: false,
    requestedAttempts: [],
  };
  let nextId = 1;
  const packagePath = '/users/nanazt/packages/container/azuki-build-cache/versions';
  const versions = () => {
    const tagsByDigest = new Map();
    for (const [tag, manifestDigest] of registry.tags) {
      const tags = tagsByDigest.get(manifestDigest) ?? [];
      tags.push(tag);
      tagsByDigest.set(manifestDigest, tags);
    }
    return [...tagsByDigest].map(([manifestDigest, tags]) => {
      if (!ids.has(manifestDigest)) {
        ids.set(manifestDigest, nextId);
        digestById.set(nextId, manifestDigest);
        nextId += 1;
      }
      const manifest = JSON.parse(registry.manifests.get(manifestDigest).toString('utf8'));
      return {
        id: ids.get(manifestDigest),
        name: manifestDigest,
        created_at: state.createdAtOverrides.get(manifestDigest) ?? manifest.annotations?.['org.opencontainers.image.created'] ?? '2026-09-14T00:00:00Z',
        metadata: {
          package_type: state.wrongPackageType ? 'npm' : 'container',
          container: { tags: tags.toSorted() },
        },
      };
    }).toSorted((left, right) => left.id - right.id);
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== 'Bearer fixture-github-token') {
        response.writeHead(401).end();
        return;
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/repos/nanazt/azuki') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          full_name: 'nanazt/azuki',
          owner: { login: 'nanazt', type: 'User' },
        }));
        return;
      }
      if (request.method === 'GET' && url.pathname === packagePath) {
        if (state.hangList) return;
        const page = Number(url.searchParams.get('page'));
        const perPage = Number(url.searchParams.get('per_page'));
        const all = versions();
        const offset = (page - 1) * perPage;
        const body = all.slice(offset, offset + perPage);
        const headers = { 'content-type': 'application/json' };
        if (offset + perPage < all.length || state.forceNextPage) {
          const next = new URL(url);
          next.searchParams.set('page', String(page + 1));
          headers.link = `<http://${request.headers.host}${next.pathname}${next.search}>; rel="next"`;
        }
        response.writeHead(200, headers).end(JSON.stringify(body));
        return;
      }
      const attempt = /^\/repos\/nanazt\/azuki\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(url.pathname);
      if (request.method === 'GET' && attempt) {
        const key = `${attempt[1]}/${attempt[2]}`;
        state.requestedAttempts.push(key);
        if (state.attemptFailures.has(key)) {
          response.writeHead(503).end();
          return;
        }
        const status = state.attempts.get(key) ?? { status: 'completed', conclusion: 'success' };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: Number(attempt[1]),
          run_attempt: Number(attempt[2]),
          repository: { full_name: 'nanazt/azuki' },
          ...status,
        }));
        if (state.afterAttempt) {
          const afterAttempt = state.afterAttempt;
          state.afterAttempt = null;
          await afterAttempt(key);
        }
        return;
      }
      const deletion = /^\/users\/nanazt\/packages\/container\/azuki-build-cache\/versions\/([1-9][0-9]*)$/u.exec(url.pathname);
      if (request.method === 'DELETE' && deletion) {
        const versionId = Number(deletion[1]);
        if (state.beforeDelete) await state.beforeDelete(versionId);
        if (state.deleteFailures.has(versionId)) {
          response.writeHead(503).end();
          return;
        }
        const manifestDigest = digestById.get(versionId);
        if (!manifestDigest || !registry.manifests.has(manifestDigest)) {
          response.writeHead(404).end();
          return;
        }
        for (const [tag, taggedDigest] of registry.tags) {
          if (taggedDigest === manifestDigest) registry.tags.delete(tag);
        }
        registry.manifests.delete(manifestDigest);
        state.deleted.push({ id: versionId, digest: manifestDigest });
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    versionId(manifestDigest) {
      versions();
      return ids.get(manifestDigest);
    },
  };
}

function githubClient(registry, fixture, limits = {}) {
  return new GitHubRetentionClient({
    token: 'fixture-github-token',
    registry: registry.registry,
    origin: fixture.origin,
    limits: { ...DEFAULT_RETENTION_TEST_LIMITS, ...limits },
    maxBodyBytes: TEST_LIMITS.maxMetadataBytes,
  });
}

const DEFAULT_RETENTION_TEST_LIMITS = Object.freeze({
  targetSnapshots: 2,
  maxPages: 4,
  maxVersions: 100,
  perPage: 100,
  timeoutMs: 2_000,
  maxWarnings: 8,
});

function producer(runId, runAttempt = '1') {
  return {
    repository: 'nanazt/azuki',
    runId,
    runAttempt,
    sourceSha: createHash('sha1').update(`${runId}/${runAttempt}`).digest('hex'),
  };
}

async function publishFixtureSnapshot(t, registry, producerIdentity, marker, createdAt, options = {}) {
  const root = await temporaryDirectory(t);
  await kacheFixture(root, marker);
  return publishSnapshotFromDirectory({
    client: registry,
    sourceDir: root,
    compatibility: COMPATIBILITY,
    producer: producerIdentity,
    limits: TEST_LIMITS,
    createdAt,
    ...options,
  });
}

function removeVersion(registry, manifestDigest) {
  registry.manifests.delete(manifestDigest);
  for (const [tag, taggedDigest] of registry.tags) {
    if (taggedDigest === manifestDigest) registry.tags.delete(tag);
  }
}

async function kacheFixture(root, marker = 'first') {
  await mkdir(path.join(root, 'store', 'blobs'), { recursive: true });
  await mkdir(path.join(root, 'store', 'entries'), { recursive: true });
  await mkdir(path.join(root, 'store', 'staging'), { recursive: true });
  await writeFile(path.join(root, 'index.db'), `sqlite-fixture-${marker}`);
  await writeFile(path.join(root, 'store', 'blobs', marker), Buffer.from(`blob-${marker}`));
  await writeFile(path.join(root, 'store', 'entries', 'compiler'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'store', 'gc.lock'), '4312');
  await writeFile(path.join(root, 'store', `${'a'.repeat(64)}.lock`), '4312');
  await chmod(path.join(root, 'store', 'entries', 'compiler'), 0o755);
}

function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const payload = entry.payload ?? Buffer.alloc(0);
    chunks.push(makeTarHeader({ relativePath: entry.path, mode: entry.mode ?? 0o644, size: payload.length, type: entry.type ?? '0' }));
    chunks.push(payload);
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

test('compatibility reference excludes producer and source identity', () => {
  assert.equal(compatibilityRef(COMPATIBILITY), COMPATIBILITY.fixedRef);
  assert.equal(compatibilityRef({ ...COMPATIBILITY, fixedRef: undefined }), COMPATIBILITY.fixedRef);
});

test('ustar round trip preserves payload bytes and executable permission', async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  const archive = path.join(root, 'snapshot.tar');
  const restored = path.join(root, 'restored');
  await kacheFixture(source);

  const created = await createTarFromDirectory(source, archive, TEST_LIMITS);
  const extracted = await extractTarToDirectory(archive, restored, TEST_LIMITS);

  assert.equal(extracted.fileCount, created.fileCount);
  assert.equal(extracted.unpackedSize, created.unpackedSize);
  assert.equal(await readFile(path.join(restored, 'store', 'blobs', 'first'), 'utf8'), 'blob-first');
  assert.equal((await stat(path.join(restored, 'store', 'entries', 'compiler'))).mode & 0o777, 0o755);
  await assert.rejects(stat(path.join(restored, 'store', 'gc.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(restored, 'store', `${'a'.repeat(64)}.lock`)), { code: 'ENOENT' });
});

test('publisher rejects open SQLite state, active staging, and uncertain quiescence', async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  await kacheFixture(source);
  await writeFile(path.join(source, 'index.db-wal'), 'open transaction');

  await assert.rejects(
    createTarFromDirectory(source, path.join(root, 'wal.tar'), TEST_LIMITS),

    (error) => error instanceof CacheTransportError && error.code === 'OPEN_SQLITE_STATE',
  );

  await rm(path.join(source, 'index.db-wal'));
  await writeFile(path.join(source, 'store', 'staging', 'partial'), 'in progress');
  await assert.rejects(
    createTarFromDirectory(source, path.join(root, 'staging.tar'), TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'IN_PROGRESS_STORE',
  );

  await rm(path.join(source, 'store', 'staging', 'partial'));

  await rm(path.join(source, 'store', 'gc.lock'));
  await writeFile(path.join(source, '.snapshot-uncertain'), 'manual GC or daemon shutdown did not finish');
  await assert.rejects(
    createTarFromDirectory(source, path.join(root, 'uncertain.tar'), TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'UNCERTAIN_SNAPSHOT',
  );
});
test('gzip payload round trip preserves the verified raw tar and separates size measurements', async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  const raw = path.join(root, 'snapshot.tar');
  const compressed = path.join(root, 'snapshot.tar.gz');
  const restoredRaw = path.join(root, 'restored.tar');
  const restored = path.join(root, 'restored');
  await kacheFixture(source);

  const tarPayload = await createTarFromDirectory(source, raw, TEST_LIMITS);
  const gzipPayload = await compressTarToGzip(raw, compressed, TEST_LIMITS, { reservedDiskBytes: tarPayload.unpackedSize });
  const decompressed = await decompressGzipToTar(compressed, restoredRaw, TEST_LIMITS, {
    expectedDigest: tarPayload.digest,
    expectedSize: tarPayload.size,
  });
  const extracted = await extractTarToDirectory(restoredRaw, restored, TEST_LIMITS);

  assert.equal(gzipPayload.inputSize, tarPayload.size);
  assert.equal(gzipPayload.digest, digest(await readFile(compressed)));
  assert.equal(gzipPayload.size, (await stat(compressed)).size);
  assert.equal(decompressed.digest, tarPayload.digest);
  assert.equal(decompressed.size, tarPayload.size);
  assert.equal(extracted.unpackedSize, tarPayload.unpackedSize);
  assert.equal(await readFile(path.join(restored, 'index.db'), 'utf8'), 'sqlite-fixture-first');
});

test('truncated and corrupt gzip payloads are rejected without partial raw tar files', async (t) => {
  const root = await temporaryDirectory(t);
  const raw = path.join(root, 'source.tar');
  const compressed = path.join(root, 'source.tar.gz');
  await writeFile(raw, tar([{ path: 'payload', payload: Buffer.alloc(32 * 1024, 0x61) }]));
  await compressTarToGzip(raw, compressed, TEST_LIMITS);
  const gzipBytes = await readFile(compressed);
  const truncated = path.join(root, 'truncated.tar.gz');
  const corrupt = path.join(root, 'corrupt.tar.gz');
  const truncatedOutput = path.join(root, 'truncated.tar');
  const corruptOutput = path.join(root, 'corrupt.tar');
  await writeFile(truncated, gzipBytes.subarray(0, gzipBytes.length - 4));
  const corruptedBytes = Buffer.from(gzipBytes);
  corruptedBytes[Math.floor(corruptedBytes.length / 2)] ^= 0xff;
  await writeFile(corrupt, corruptedBytes);

  await assert.rejects(
    decompressGzipToTar(truncated, truncatedOutput, TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'INVALID_GZIP_PAYLOAD',
  );
  await assert.rejects(
    decompressGzipToTar(corrupt, corruptOutput, TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'INVALID_GZIP_PAYLOAD',
  );
  await assert.rejects(stat(truncatedOutput), { code: 'ENOENT' });
  await assert.rejects(stat(corruptOutput), { code: 'ENOENT' });
});

test('gzip expansion stops at the decompressed byte boundary and removes partial output', async (t) => {
  const root = await temporaryDirectory(t);
  const raw = path.join(root, 'large.tar');
  const compressed = path.join(root, 'large.tar.gz');
  const output = path.join(root, 'expanded.tar');
  const payload = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61);
  await writeFile(raw, payload);
  await compressTarToGzip(raw, compressed, TEST_LIMITS);
  const compressedSize = (await stat(compressed)).size;
  const exactOutput = path.join(root, 'exact-boundary.tar');
  await decompressGzipToTar(compressed, exactOutput, {
    ...TEST_LIMITS,
    maxTransferBytes: compressedSize,
    maxUnpackedBytes: payload.length,
    maxDiskBytes: compressedSize + payload.length,
  }, { expectedSize: payload.length, expectedDigest: digest(payload) });
  assert.deepEqual(await readFile(exactOutput), payload);
  const bounded = {
    ...TEST_LIMITS,
    maxUnpackedBytes: 2 * 1024 * 1024 + 7,
  };

  await assert.rejects(
    decompressGzipToTar(compressed, output, bounded),
    (error) => error instanceof CacheTransportError && error.code === 'UNPACKED_LIMIT',
  );
  await assert.rejects(stat(output), { code: 'ENOENT' });

  const oversizedMetadataOutput = path.join(root, 'oversized-metadata.tar');
  await assert.rejects(
    decompressGzipToTar(compressed, oversizedMetadataOutput, bounded, { expectedSize: bounded.maxUnpackedBytes + 1 }),
    (error) => error instanceof CacheTransportError && error.code === 'UNPACKED_LIMIT',
  );
  await assert.rejects(stat(oversizedMetadataOutput), { code: 'ENOENT' });

  const diskOutput = path.join(root, 'disk-bounded.tar');
  await assert.rejects(
    decompressGzipToTar(compressed, diskOutput, {
      ...TEST_LIMITS,
      maxTransferBytes: 64 * 1024,
      maxUnpackedBytes: payload.length,
      maxDiskBytes: compressedSize + 2 * 1024 * 1024 + 7,
    }),
    (error) => error instanceof CacheTransportError && error.code === 'DISK_LIMIT',
  );
  await assert.rejects(stat(diskOutput), { code: 'ENOENT' });
});

test('snapshot resource limits cannot exceed the fixed 4 GiB transfer, 4 GiB raw, and 12 GiB disk ceilings', async (t) => {
  const root = await temporaryDirectory(t);
  const raw = path.join(root, 'source.tar');
  await writeFile(raw, Buffer.alloc(1024, 0x61));
  const cases = [
    { maxTransferBytes: 4 * 1024 * 1024 * 1024 + 1 },
    { maxUnpackedBytes: 4 * 1024 * 1024 * 1024 + 1 },
    { maxDiskBytes: 12 * 1024 * 1024 * 1024 + 1 },
  ];

  for (const [index, override] of cases.entries()) {
    await assert.rejects(
      compressTarToGzip(raw, path.join(root, `bounded-${index}.tar.gz`), { ...TEST_LIMITS, ...override }),
      (error) => error instanceof CacheTransportError && error.code === 'INVALID_LIMIT',
    );
  }
});

test('strict extraction rejects traversal and link entries without writing outside its root', async (t) => {
  const root = await temporaryDirectory(t);
  const traversal = path.join(root, 'traversal.tar');
  const link = path.join(root, 'link.tar');
  const uncertain = path.join(root, 'uncertain.tar');
  await writeFile(traversal, tar([{ path: '../escaped', payload: Buffer.from('bad') }]));
  await writeFile(link, tar([{ path: 'safe-link', type: '2' }]));
  await writeFile(uncertain, tar([{ path: '.snapshot-uncertain', payload: Buffer.from('unsafe') }]));

  await assert.rejects(
    extractTarToDirectory(traversal, path.join(root, 'traversal-out'), TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'UNSAFE_ARCHIVE_PATH',
  );
  await assert.rejects(
    extractTarToDirectory(link, path.join(root, 'link-out'), TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'UNSAFE_ARCHIVE_TYPE',
  );
  await assert.rejects(
    extractTarToDirectory(uncertain, path.join(root, 'uncertain-out'), TEST_LIMITS),
    (error) => error instanceof CacheTransportError && error.code === 'UNCERTAIN_SNAPSHOT',
  );
  await assert.rejects(stat(path.join(root, 'escaped')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'traversal-out')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'link-out')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'uncertain-out')), { code: 'ENOENT' });
});

test('strict extraction removes partial output when a positive file bound is crossed', async (t) => {
  const root = await temporaryDirectory(t);
  const archive = path.join(root, 'too-many.tar');
  const destination = path.join(root, 'output');
  await writeFile(archive, tar([
    { path: 'one', payload: Buffer.from('1') },
    { path: 'two', payload: Buffer.from('2') },
  ]));

  await assert.rejects(
    extractTarToDirectory(archive, destination, { ...TEST_LIMITS, maxFiles: 1 }),
    (error) => error instanceof CacheTransportError && error.code === 'FILE_LIMIT',
  );
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('strict extraction enforces unpacked and workspace disk bounds independently', async (t) => {
  const root = await temporaryDirectory(t);
  const archive = path.join(root, 'bounded.tar');
  await writeFile(archive, tar([{ path: 'payload', payload: Buffer.alloc(2048, 0x61) }]));

  await assert.rejects(
    extractTarToDirectory(archive, path.join(root, 'unpacked-out'), { ...TEST_LIMITS, maxUnpackedBytes: 1024 }),
    (error) => error instanceof CacheTransportError && error.code === 'UNPACKED_LIMIT',
  );
  await assert.rejects(
    extractTarToDirectory(archive, path.join(root, 'disk-out'), {
      ...TEST_LIMITS,
      maxTransferBytes: 4096,
      maxUnpackedBytes: 4096,
      maxDiskBytes: 4096,
    }),
    (error) => error instanceof CacheTransportError && error.code === 'DISK_LIMIT',
  );
  await assert.rejects(stat(path.join(root, 'unpacked-out')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'disk-out')), { code: 'ENOENT' });
});

test('real OCI data API round trip verifies immutable metadata and payload', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  const restored = path.join(root, 'restored');
  await kacheFixture(source);

  const published = await publishSnapshotFromDirectory({
    client,
    sourceDir: source,
    compatibility: COMPATIBILITY,
    producer: PRODUCER_A,
    limits: TEST_LIMITS,
    createdAt: '2026-09-14T00:00:00.000Z',
  });
  const resolved = await resolveSnapshot(client, COMPATIBILITY);
  const restoredResult = await downloadSnapshotToDirectory({ client, destination: restored, compatibility: COMPATIBILITY, limits: TEST_LIMITS });

  assert.equal(published.publication, 'promoted');
  assert.match(published.immutableRef, /^snapshot-[0-9a-f]{12}-[0-9a-f]{12}-run-34756435891-attempt-1-0123456789ab-[0-9a-f]{12}$/u);
  assert.equal(fixture.tags.get(COMPATIBILITY.fixedRef), published.manifestDigest);
  assert.equal(resolved.manifestDigest, published.manifestDigest);
  assert.deepEqual(resolved.metadata.producer, PRODUCER_A);
  assert.equal(resolved.metadata.payload.digest, published.payloadDigest);
  assert.equal(resolved.metadata.payload.mediaType, 'application/vnd.oci.image.layer.v1.tar+gzip');
  assert.equal(resolved.metadata.payload.compression, 'gzip');
  assert.equal(resolved.metadata.payload.tarDigest, published.tarDigest);
  assert.equal(resolved.metadata.payload.tarSize, published.tarBytes);
  assert.equal(resolved.metadata.payload.fileBytes, published.payloadFileBytes);
  assert.equal(restoredResult.tarDigest, published.tarDigest);
  assert.equal(restoredResult.tarBytes, published.tarBytes);
  assert.equal(restoredResult.payloadFileBytes, published.payloadFileBytes);
  assert.equal(restoredResult.status, 'restored');
  assert.equal(await readFile(path.join(restored, 'index.db'), 'utf8'), 'sqlite-fixture-first');
});

test('authenticated registry exchange keeps credentials out of OCI data', async (t) => {
  const fixture = await registryFixture(t);
  fixture.state.requireAuth = true;
  const client = new RegistryClient({
    registry: fixture.origin,
    repository: REPOSITORY,
    username: 'fixture-user',
    token: 'fixture-secret',
    limits: TEST_LIMITS,
  });
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  await kacheFixture(source);

  const published = await publishSnapshotFromDirectory({
    client,
    sourceDir: source,
    compatibility: COMPATIBILITY,
    producer: PRODUCER_A,
    limits: TEST_LIMITS,
  });

  assert.equal(published.publication, 'promoted');
  assert.ok(fixture.state.tokenRequests >= 1);
  for (const bytes of [...fixture.blobs.values(), ...fixture.manifests.values()]) {
    assert.equal(bytes.includes(Buffer.from('fixture-secret')), false);
    assert.equal(bytes.includes(Buffer.from('fixture-bearer-token')), false);
  }
});


test('failed candidate promotion preserves the prior fixed reference', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const root = await temporaryDirectory(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await kacheFixture(first, 'first');
  await kacheFixture(second, 'second');
  const prior = await publishSnapshotFromDirectory({ client, sourceDir: first, compatibility: COMPATIBILITY, producer: PRODUCER_A, limits: TEST_LIMITS });
  fixture.state.failFixedPromotion = true;

  await assert.rejects(
    publishSnapshotFromDirectory({ client, sourceDir: second, compatibility: COMPATIBILITY, producer: PRODUCER_B, limits: TEST_LIMITS }),
    (error) => error instanceof CacheTransportError && error.details.publication === 'abandoned' && error.details.phase === 'promote',
  );

  assert.equal(fixture.tags.get(COMPATIBILITY.fixedRef), prior.manifestDigest);
  assert.equal(fixture.state.fixedPutAttempts, 2);
  assert.ok([...fixture.tags.keys()].some((reference) => reference.includes('run-34756435892-attempt-2')));
});

test('receipt failure preserves the newly promoted snapshot and skips cleanup without claiming rollback', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const prior = await publishFixtureSnapshot(t, client, PRODUCER_A, 'receipt-prior', '2026-09-14T00:00:00.000Z');
  fixture.state.failReceipt = true;
  const warnings = [];

  const current = await publishFixtureSnapshot(t, client, PRODUCER_B, 'receipt-current', '2026-09-14T01:00:00.000Z', {
    emitWarning: (warning) => warnings.push(warning),
  });

  assert.equal(current.publication, 'promoted');
  assert.equal(current.receipt.status, 'unconfirmed');
  assert.equal(current.retention.reason, 'receipt-unconfirmed');
  assert.equal(fixture.tags.get(COMPATIBILITY.fixedRef), current.manifestDigest);
  assert.equal(fixture.manifests.has(current.manifestDigest), true);
  assert.equal(fixture.manifests.has(prior.manifestDigest), true);
  assert.equal(warnings.length, 1);
});

test('corrupt downloaded payload never replaces a destination and leaves a clean miss state', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await kacheFixture(source);
  await mkdir(destination);
  await writeFile(path.join(destination, 'stale'), 'must be removed after failure');
  const published = await publishSnapshotFromDirectory({ client, sourceDir: source, compatibility: COMPATIBILITY, producer: PRODUCER_A, limits: TEST_LIMITS });
  fixture.state.corruptBlob = published.payloadDigest;

  await assert.rejects(
    downloadSnapshotToDirectory({ client, destination, compatibility: COMPATIBILITY, limits: TEST_LIMITS }),
    (error) => error instanceof CacheTransportError && error.code === 'BLOB_DIGEST_MISMATCH',
  );
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('descriptor limits reject an otherwise valid snapshot before payload download', async (t) => {
  const fixture = await registryFixture(t);
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  await kacheFixture(source);
  const publishingClient = registryClient(fixture);
  const published = await publishSnapshotFromDirectory({ client: publishingClient, sourceDir: source, compatibility: COMPATIBILITY, producer: PRODUCER_A, limits: TEST_LIMITS });
  const constrainedClient = registryClient(fixture, { ...TEST_LIMITS, maxTransferBytes: published.transferBytes - 1, maxDiskBytes: TEST_LIMITS.maxDiskBytes });

  await assert.rejects(
    resolveSnapshot(constrainedClient, COMPATIBILITY),
    (error) => error instanceof CacheTransportError && error.code === 'TRANSFER_LIMIT',
  );
});

test('registry waits are cancelled at the explicit timeout', async (t) => {
  const fixture = await registryFixture(t);
  fixture.state.hangManifest = true;
  const client = registryClient(fixture, { ...TEST_LIMITS, timeoutMs: 25 });

  await assert.rejects(
    resolveSnapshot(client, COMPATIBILITY),
    (error) => error instanceof CacheTransportError && error.code === 'REGISTRY_TIMEOUT',
  );
});
test('plain HTTP is confined to loopback fixtures', () => {
  assert.throws(
    () => new RegistryClient({ registry: 'http://registry.example.test', repository: REPOSITORY, limits: TEST_LIMITS }),
    (error) => error instanceof CacheTransportError && error.code === 'INSECURE_REGISTRY',
  );
  assert.throws(
    () => new RegistryClient({ registry: 'https://registry.example.test', repository: REPOSITORY, limits: TEST_LIMITS }),
    (error) => error instanceof CacheTransportError && error.code === 'UNTRUSTED_REGISTRY',
  );
});

test('receipt-backed retention keeps the current snapshot and latest predecessor while deleting an exact completed pair', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const first = await publishFixtureSnapshot(t, client, producer('41000000001'), 'retention-first', '2026-09-14T10:00:00.000Z');
  const second = await publishFixtureSnapshot(t, client, producer('41000000002'), 'retention-second', '2026-09-14T01:00:00.000Z');
  api.state.createdAtOverrides.set(first.manifestDigest, '2026-09-14T00:00:00Z');
  api.state.createdAtOverrides.set(second.manifestDigest, '2026-09-14T01:00:00Z');
  const current = await publishFixtureSnapshot(t, client, producer('41000000003'), 'retention-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });
  const restored = path.join(await temporaryDirectory(t), 'restored');
  const predecessorRoot = await temporaryDirectory(t);
  const predecessorCompressed = path.join(predecessorRoot, 'snapshot.tar.gz');
  const predecessorArchive = path.join(predecessorRoot, 'snapshot.tar');
  const predecessorRestored = path.join(predecessorRoot, 'restored');

  await downloadSnapshotToDirectory({ client, destination: restored, compatibility: COMPATIBILITY, limits: TEST_LIMITS });
  await client.downloadBlob(second.payloadDigest, predecessorCompressed, second.transferBytes);
  await decompressGzipToTar(predecessorCompressed, predecessorArchive, TEST_LIMITS, {
    expectedDigest: second.tarDigest,
    expectedSize: second.tarBytes,
  });
  await extractTarToDirectory(predecessorArchive, predecessorRestored, TEST_LIMITS);

  const receiptManifest = JSON.parse(fixture.manifests.get(current.receipt.digest));
  const receiptConfig = JSON.parse(fixture.blobs.get(receiptManifest.config.digest));

  assert.deepEqual(receiptConfig.rootfs.diff_ids, [current.tarDigest]);
  assert.equal(receiptConfig.receipt.snapshot.tarDigest, current.tarDigest);
  assert.equal(current.receipt.status, 'acknowledged');
  assert.equal(current.retention.status, 'completed');
  assert.deepEqual(current.retention.deleted.map((entry) => entry.snapshotDigest), [first.manifestDigest]);
  assert.equal(fixture.manifests.has(first.manifestDigest), false);
  assert.equal(fixture.manifests.has(first.receipt.digest), false);
  assert.equal(fixture.manifests.has(second.manifestDigest), true);
  assert.equal(fixture.manifests.has(second.receipt.digest), true);
  assert.equal(fixture.manifests.has(current.manifestDigest), true);
  assert.equal(fixture.blobs.has(second.payloadDigest), true);
  assert.equal(fixture.blobs.has(current.payloadDigest), true);
  assert.equal(await readFile(path.join(restored, 'index.db'), 'utf8'), 'sqlite-fixture-retention-current');
  assert.equal(await readFile(path.join(predecessorRestored, 'index.db'), 'utf8'), 'sqlite-fixture-retention-second');
});

test('a candidate paused before promotion survives another producer cleanup and only promotes itself afterward', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const oldest = await publishFixtureSnapshot(t, client, producer('42000000001'), 'race-oldest', '2026-09-14T00:00:00.000Z');
  const predecessor = await publishFixtureSnapshot(t, client, producer('42000000002'), 'race-predecessor', '2026-09-14T01:00:00.000Z');
  let cleaningPublication;
  fixture.state.beforeFixedPromotion = async () => {
    cleaningPublication = await publishFixtureSnapshot(t, client, producer('42000000004'), 'race-cleaner', '2026-09-14T02:00:00.000Z', {
      retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
    });
  };

  const paused = await publishFixtureSnapshot(t, client, producer('42000000003'), 'race-paused', '2026-09-14T03:00:00.000Z');

  assert.equal(cleaningPublication.retention.status, 'completed');
  assert.deepEqual(cleaningPublication.retention.deleted.map((entry) => entry.snapshotDigest), [oldest.manifestDigest]);
  assert.equal(fixture.manifests.has(paused.manifestDigest), true);
  assert.equal(fixture.manifests.has(paused.receipt.digest), true);
  assert.equal(fixture.manifests.has(predecessor.manifestDigest), true);
  assert.equal(fixture.tags.get(COMPATIBILITY.fixedRef), paused.manifestDigest);
});

test('missing receipts and active, cancelled, or unqueryable exact attempts remain protected', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const completed = await publishFixtureSnapshot(t, client, producer('43000000001'), 'status-completed', '2026-09-14T00:00:00.000Z');
  const missingReceipt = await publishFixtureSnapshot(t, client, producer('43000000002'), 'status-missing', '2026-09-14T01:00:00.000Z');
  const activeProducer = producer('43000000003', '1');
  const active = await publishFixtureSnapshot(t, client, activeProducer, 'status-active', '2026-09-14T02:00:00.000Z');
  const cancelledProducer = producer('43000000004');
  const cancelled = await publishFixtureSnapshot(t, client, cancelledProducer, 'status-cancelled', '2026-09-14T03:00:00.000Z');
  const unknownProducer = producer('43000000005');
  const unqueryable = await publishFixtureSnapshot(t, client, unknownProducer, 'status-unqueryable', '2026-09-14T05:30:00.000Z');
  const predecessor = await publishFixtureSnapshot(t, client, producer('43000000006'), 'status-predecessor', '2026-09-14T05:00:00.000Z');
  removeVersion(fixture, missingReceipt.receipt.digest);
  api.state.attempts.set(`${activeProducer.runId}/1`, { status: 'in_progress', conclusion: null });
  api.state.attempts.set(`${activeProducer.runId}/2`, { status: 'completed', conclusion: 'success' });
  api.state.attempts.set(`${cancelledProducer.runId}/1`, { status: 'completed', conclusion: 'cancelled' });
  api.state.attemptFailures.add(`${unknownProducer.runId}/1`);

  const current = await publishFixtureSnapshot(t, client, producer('43000000007'), 'status-current', '2026-09-14T06:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });

  assert.deepEqual(current.retention.deleted.map((entry) => entry.snapshotDigest), [completed.manifestDigest]);
  for (const protectedSnapshot of [missingReceipt, active, cancelled, unqueryable, predecessor, current]) {
    assert.equal(fixture.manifests.has(protectedSnapshot.manifestDigest), true);
  }
  assert.equal(api.state.requestedAttempts.includes(`${activeProducer.runId}/1`), true);
  assert.equal(api.state.requestedAttempts.includes(`${activeProducer.runId}/2`), false);
  assert.ok(current.retention.warnings.some((warning) => warning.message.includes('could not be confirmed')));
});

test('incomplete package pagination skips all cleanup within the configured bound', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  api.state.forceNextPage = true;
  const github = githubClient(client, api, { maxPages: 1 });
  const first = await publishFixtureSnapshot(t, client, producer('44000000001'), 'pages-first', '2026-09-14T00:00:00.000Z');
  await publishFixtureSnapshot(t, client, producer('44000000002'), 'pages-second', '2026-09-14T01:00:00.000Z');

  const current = await publishFixtureSnapshot(t, client, producer('44000000003'), 'pages-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: { ...DEFAULT_RETENTION_TEST_LIMITS, maxPages: 1 } },
  });

  assert.equal(current.retention.status, 'skipped');
  assert.equal(current.retention.reason, 'cleanup-uncertain');
  assert.equal(api.state.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
});

test('package candidate count overflow stops before classification or deletion', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const bounded = { ...DEFAULT_RETENTION_TEST_LIMITS, perPage: 2, maxVersions: 2 };
  const github = githubClient(client, api, bounded);
  const first = await publishFixtureSnapshot(t, client, producer('44100000001'), 'count-first', '2026-09-14T00:00:00.000Z');
  await publishFixtureSnapshot(t, client, producer('44100000002'), 'count-second', '2026-09-14T01:00:00.000Z');

  const current = await publishFixtureSnapshot(t, client, producer('44100000003'), 'count-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: bounded },
  });

  assert.equal(current.retention.status, 'skipped');
  assert.equal(api.state.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
});

test('a re-pointed fixed reference aborts deletion immediately before the exact version request', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const first = await publishFixtureSnapshot(t, client, producer('45000000001'), 'repoint-first', '2026-09-14T00:00:00.000Z');
  await publishFixtureSnapshot(t, client, producer('45000000002'), 'repoint-second', '2026-09-14T01:00:00.000Z');
  api.state.afterAttempt = async () => {
    fixture.tags.set(COMPATIBILITY.fixedRef, first.manifestDigest);
  };

  const current = await publishFixtureSnapshot(t, client, producer('45000000003'), 'repoint-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });

  assert.equal(current.retention.status, 'skipped');
  assert.equal(api.state.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
  assert.equal(fixture.manifests.has(current.manifestDigest), true);
});

test('a paired receipt deletion failure cannot undo publication or break the retained digests', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const first = await publishFixtureSnapshot(t, client, producer('46000000001'), 'delete-first', '2026-09-14T00:00:00.000Z');
  const predecessor = await publishFixtureSnapshot(t, client, producer('46000000002'), 'delete-second', '2026-09-14T01:00:00.000Z');
  api.state.deleteFailures.add(api.versionId(first.receipt.digest));

  const current = await publishFixtureSnapshot(t, client, producer('46000000003'), 'delete-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });
  const restored = path.join(await temporaryDirectory(t), 'restored');
  await downloadSnapshotToDirectory({ client, destination: restored, compatibility: COMPATIBILITY, limits: TEST_LIMITS });

  assert.equal(current.retention.status, 'partial');
  assert.equal(current.retention.deleted[0].receiptDeleted, false);
  assert.equal(fixture.manifests.has(first.manifestDigest), false);
  assert.equal(fixture.manifests.has(first.receipt.digest), true);
  assert.equal(fixture.manifests.has(predecessor.manifestDigest), true);
  assert.equal(fixture.manifests.has(current.manifestDigest), true);
  assert.equal(await readFile(path.join(restored, 'index.db'), 'utf8'), 'sqlite-fixture-delete-current');
});

test('wrong package type and runtime repository scope block publish, restore, and deletion', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  api.state.wrongPackageType = true;
  const github = githubClient(client, api);
  const first = await publishFixtureSnapshot(t, client, producer('47000000001'), 'scope-first', '2026-09-14T00:00:00.000Z');
  await publishFixtureSnapshot(t, client, producer('47000000002'), 'scope-second', '2026-09-14T01:00:00.000Z');
  const current = await publishFixtureSnapshot(t, client, producer('47000000003'), 'scope-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });
  const runtimeClient = new RegistryClient({ registry: fixture.origin, repository: 'nanazt/azuki', limits: TEST_LIMITS });
  const wrongSource = await temporaryDirectory(t);
  await kacheFixture(wrongSource, 'scope-runtime');
  const manifestCount = fixture.manifests.size;

  await assert.rejects(
    publishSnapshotFromDirectory({
      client: runtimeClient,
      sourceDir: wrongSource,
      compatibility: COMPATIBILITY,
      producer: current.producer,
      limits: TEST_LIMITS,
    }),
    (error) => error instanceof CacheTransportError && error.code === 'UNSAFE_CACHE_SCOPE',
  );
  await assert.rejects(
    resolveSnapshot(runtimeClient, COMPATIBILITY),
    (error) => error instanceof CacheTransportError && error.code === 'UNSAFE_CACHE_SCOPE',
  );
  const mismatchedCacheClient = {
    repository: 'nanazt/other-build-cache',
    limits: client.limits,
    getManifest: client.getManifest.bind(client),
    getBlobBytes: client.getBlobBytes.bind(client),
  };
  await assert.rejects(
    resolveSnapshot(mismatchedCacheClient, COMPATIBILITY),
    (error) => error instanceof CacheTransportError && error.code === 'INCOMPATIBLE_SNAPSHOT',
  );

  await assert.rejects(
    runPostPublicationRetention({ client: runtimeClient, github, compatibility: COMPATIBILITY, producer: current.producer, limits: DEFAULT_RETENTION_TEST_LIMITS }),
    (error) => error instanceof CacheTransportError && error.code === 'UNSAFE_RETENTION_SCOPE',
  );
  assert.equal(fixture.manifests.size, manifestCount);
  assert.equal(current.retention.status, 'skipped');
  assert.equal(api.state.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
});

test('other platforms, layer-cache objects, unknown dependencies, and shared payload blobs stay intact', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  const github = githubClient(client, api);
  const first = await publishFixtureSnapshot(t, client, producer('48000000001'), 'mixed-first', '2026-09-14T00:00:00.000Z');
  await publishFixtureSnapshot(t, client, producer('48000000002'), 'mixed-second', '2026-09-14T01:00:00.000Z');
  const armCompatibility = {
    platform: 'linux/arm64',
    schemaVersion: 1,
    kacheVersion: '0.20.0',
    fixedRef: 'kache-linux-arm64-s1-kache-0.20.0',
  };
  const armRoot = await temporaryDirectory(t);
  await kacheFixture(armRoot, 'mixed-arm');
  const arm = await publishSnapshotFromDirectory({
    client,
    sourceDir: armRoot,
    compatibility: armCompatibility,
    producer: producer('48000000003'),
    limits: TEST_LIMITS,
    createdAt: '2026-09-14T01:30:00.000Z',
  });
  const foreignConfig = await client.uploadBytes(Buffer.from('{}\n'));
  const layerCacheBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [],
    annotations: { 'org.opencontainers.image.created': '2026-09-14T00:00:00.000Z' },
  })}\n`);
  const layerCacheDigest = await client.putManifest('buildkit-layer-cache', layerCacheBytes);
  const dependencyBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'example.invalid-but-preserved',
    subject: first.manifestDescriptor,
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...foreignConfig },
    layers: [],
    annotations: { 'org.opencontainers.image.created': '2026-09-14T00:00:00.000Z' },
  })}\n`);
  const dependencyDigest = await client.putManifest('unknown-dependent', dependencyBytes);

  const current = await publishFixtureSnapshot(t, client, producer('48000000004'), 'mixed-current', '2026-09-14T02:00:00.000Z', {
    retention: { github, limits: DEFAULT_RETENTION_TEST_LIMITS },
  });

  assert.equal(current.retention.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
  assert.equal(fixture.manifests.has(arm.manifestDigest), true);
  assert.equal(fixture.manifests.has(layerCacheDigest), true);
  assert.equal(fixture.manifests.has(dependencyDigest), true);
  assert.equal(fixture.blobs.has(first.payloadDigest), true);
});

test('a stalled GitHub package listing stops at the retention deadline without deleting data', async (t) => {
  const fixture = await registryFixture(t);
  const client = registryClient(fixture);
  const api = await githubFixture(t, fixture);
  api.state.hangList = true;
  const github = githubClient(client, api, { timeoutMs: 25 });
  const first = await publishFixtureSnapshot(t, client, producer('49000000001'), 'deadline-first', '2026-09-14T00:00:00.000Z');

  const current = await publishFixtureSnapshot(t, client, producer('49000000002'), 'deadline-current', '2026-09-14T01:00:00.000Z', {
    retention: { github, limits: { ...DEFAULT_RETENTION_TEST_LIMITS, timeoutMs: 25 } },
  });

  assert.equal(current.retention.status, 'skipped');
  assert.equal(api.state.deleted.length, 0);
  assert.equal(fixture.manifests.has(first.manifestDigest), true);
});

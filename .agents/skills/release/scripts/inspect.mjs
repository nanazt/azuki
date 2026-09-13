import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  POLICY,
  assertCandidate,
  assertCheckout,
  captureSnapshot,
  expect,
  parseSemver,
  readSealed,
  seal,
  sha256,
  snapshotContext,
  stableJson,
  verifyIdentity,
  writeJson,
  writePrivate,
} from './core.mjs';

const ARTIFACT_NAMES = Object.freeze({
  commits: 'commits.txt',
  diff: 'diff.patch',
  files: 'files.json',
});

const RELEASE_HEADINGS = new Set([
  'added',
  'fixed',
  'improved',
  'breaking changes',
  'upgrade notes',
]);

function publicationScope(snapshot, details = {}) {
  return {
    repo: POLICY.repo,
    remote: POLICY.remote,
    branch: POLICY.branch,
    pushUrl: POLICY.pushUrl,
    sourceSha: snapshot.sourceSha,
    ...details,
    workflow: {
      name: POLICY.workflow,
      fingerprint: snapshot.workflow.fingerprint,
      event: 'push',
      tagPattern: snapshot.workflow.tagPattern,
      latestUnconditional: snapshot.workflow.latestUnconditional,
      semverTemplates: snapshot.workflow.semverTemplates,
    },
  };
}

function parseFileInventory(output) {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();

  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    expect(/^[ACDMRTUXB][0-9]*$/.test(status), 'INSPECTION_EVIDENCE_INVALID', 'Git returned an invalid file status.', {
      status,
    });

    if (status.startsWith('R') || status.startsWith('C')) {
      expect(index + 1 < fields.length, 'INSPECTION_EVIDENCE_INVALID', 'Git returned an incomplete renamed or copied file record.', {
        status,
      });
      files.push({ status, oldPath: fields[index++], path: fields[index++] });
    } else {
      expect(index < fields.length, 'INSPECTION_EVIDENCE_INVALID', 'Git returned an incomplete file record.', {
        status,
      });
      files.push({ status, path: fields[index++] });
    }
  }

  return files;
}

function isDocumentationPath(path) {
  const normalized = path.toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    normalized.startsWith('docs/') ||
    normalized.includes('/docs/') ||
    /\.(?:md|mdx|rst|adoc|asciidoc)$/.test(normalized) ||
    /^(?:readme|changelog|changes|releases|migration|migrating|upgrade|upgrading|security|contributing|code_of_conduct|license)(?:\.|$)/.test(
      basename,
    )
  );
}

function changedDocumentation(files) {
  const paths = new Set();
  for (const file of files) {
    if (isDocumentationPath(file.path)) paths.add(file.path);
    if (file.oldPath && isDocumentationPath(file.oldPath)) paths.add(file.oldPath);
  }
  return [...paths].sort();
}

function artifactEvidence(content) {
  return {
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
  };
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function assertNotes(notes, version) {
  expect(typeof notes === 'string', 'INVALID_RELEASE_NOTES', 'Release notes must be exact UTF-8 text.');
  expect(Buffer.from(notes, 'utf8').toString('utf8') === notes, 'INVALID_RELEASE_NOTES', 'Release notes must be valid UTF-8 text.');
  expect(!notes.includes('\0'), 'INVALID_RELEASE_NOTES', 'Release notes must not contain NUL bytes.');
  expect(notes.trim().length > 0, 'INVALID_RELEASE_NOTES', 'Release notes must not be empty.');
  expect(notes.includes(version), 'INVALID_RELEASE_NOTES', 'Release notes must include the exact release version.', {
    version,
  });

  const headings = [...notes.matchAll(/^(#{1,6})[ \t]+([^\r\n]+?)[ \t]*\r?$/gm)];
  const meaningful = headings.some((heading, index) => {
    if (!RELEASE_HEADINGS.has(heading[2].trim().toLowerCase())) return false;
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? notes.length;
    return notes.slice(bodyStart, bodyEnd).trim().length > 0;
  });
  expect(
    meaningful,
    'INVALID_RELEASE_NOTES',
    'Release notes must contain content under at least one release heading: Added, Fixed, Improved, Breaking Changes, or Upgrade Notes.',
  );
}

async function verifyArtifact(path, evidence, name) {
  let content;
  try {
    content = await readFile(path);
  } catch (error) {
    expect(false, 'INSPECTION_EVIDENCE_INVALID', `The ${name} review artifact cannot be read.`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  expect(content.length === evidence.bytes, 'INSPECTION_EVIDENCE_INVALID', `The ${name} review artifact size changed.`, {
    path,
  });
  expect(sha256(content) === evidence.sha256, 'INSPECTION_EVIDENCE_INVALID', `The ${name} review artifact digest changed.`, {
    path,
  });
  expect(content.toString('utf8').trim().length > 0, 'INSPECTION_EVIDENCE_INVALID', `The ${name} review artifact is empty.`, {
    path,
  });
  return content;
}

function assertSameSnapshot(inspected, current) {
  expect(inspected.root === current.root, 'INSPECTION_STALE', 'The inspected repository root changed.');
  expect(inspected.sourceSha === current.sourceSha, 'INSPECTION_STALE', 'The inspected source commit changed.');
  expect(inspected.workspaceVersion === current.workspaceVersion, 'INSPECTION_STALE', 'The inspected workspace version changed.');
  expect(inspected.firstRelease === current.firstRelease, 'INSPECTION_STALE', 'The inspected release-history state changed.');
  expect(stableJson(inspected.packages) === stableJson(current.packages), 'INSPECTION_STALE', 'The inspected workspace package inventory changed.');
  expect(
    stableJson(snapshotContext(inspected)) === stableJson(snapshotContext(current)),
    'INSPECTION_STALE',
    'The inspected publication context changed.',
  );
}

async function verifyInspectionEvidence(ctx, inspectionPath, inspection) {
  expect(isWithin(ctx.stateDir, inspectionPath), 'INVALID_INSPECTION', 'The inspection must be stored in this repository release state directory.');
  expect(inspectionPath === join(dirname(inspectionPath), 'inspection.json'), 'INVALID_INSPECTION', 'The inspection artifact must be named inspection.json.');
  expect(inspection.payload.root === ctx.root, 'INVALID_INSPECTION', 'The inspection belongs to a different repository root.');
  expect(inspection.payload.changeCount > 0, 'INSPECTION_EMPTY', 'The inspection contains no release commits.');
  expect(Array.isArray(inspection.payload.fileInventory) && inspection.payload.fileInventory.length > 0, 'INSPECTION_EMPTY', 'The inspection contains no changed files.');

  const directory = dirname(inspectionPath);
  for (const [name, filename] of Object.entries(ARTIFACT_NAMES)) {
    const expectedPath = join(directory, filename);
    expect(inspection.payload.artifacts?.[name] === expectedPath, 'INSPECTION_EVIDENCE_INVALID', `The ${name} review artifact path is not pinned to the inspection.`, {
      expectedPath,
    });
    const evidence = inspection.payload.evidence?.[name];
    expect(
      evidence && Number.isSafeInteger(evidence.bytes) && evidence.bytes > 0 && /^[0-9a-f]{64}$/.test(evidence.sha256),
      'INSPECTION_EVIDENCE_INVALID',
      `The ${name} review artifact evidence is invalid.`,
    );
    const content = await verifyArtifact(expectedPath, evidence, name);
    if (name === 'files') {
      const expected = `${stableJson({
        range: inspection.payload.range,
        files: inspection.payload.fileInventory,
        changedDocs: inspection.payload.changedDocs,
      })}\n`;
      expect(content.toString('utf8') === expected, 'INSPECTION_EVIDENCE_INVALID', 'The file inventory does not match the sealed inspection.');
    }
  }
}

export async function inspect(ctx) {
  ctx.progress('inspect', { phase: 'capture' });
  const checkout = await assertCheckout(ctx, { clean: true });
  await verifyIdentity(ctx);
  const snapshot = await captureSnapshot(ctx, { fetch: true });
  expect(snapshot.sourceSha === checkout.head, 'SOURCE_CHANGED', 'HEAD changed while the release snapshot was being captured.');
  await assertCheckout(ctx, { clean: true, head: snapshot.sourceSha });

  const revision = snapshot.firstRelease ? snapshot.sourceSha : `${snapshot.baseline.sha}..${snapshot.sourceSha}`;
  const diffBase = snapshot.firstRelease
    ? (await ctx.git(['hash-object', '-t', 'tree', '--stdin'], { stdin: '' })).trim()
    : snapshot.baseline.sha;
  expect(/^[0-9a-f]{40,64}$/.test(diffBase), 'INSPECTION_EVIDENCE_INVALID', 'Git did not produce a valid diff base.');

  const [commitCountText, commits, diff, nameStatus] = await Promise.all([
    ctx.git(['rev-list', '--count', revision]),
    ctx.git(['log', '--reverse', '--format=fuller', revision]),
    ctx.git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      '--find-renames',
      diffBase,
      snapshot.sourceSha,
      '--',
    ]),
    ctx.git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--find-renames',
      diffBase,
      snapshot.sourceSha,
      '--',
    ]),
  ]);
  const commitCount = Number(commitCountText.trim());
  const fileInventory = parseFileInventory(nameStatus);
  expect(Number.isSafeInteger(commitCount) && commitCount > 0, 'INSPECTION_EMPTY', 'There are no commits to release after the selected baseline.');
  expect(commits.trim().length > 0, 'INSPECTION_EMPTY', 'The release commit review is empty.');
  expect(diff.trim().length > 0 && fileInventory.length > 0, 'INSPECTION_EMPTY', 'The selected commits contain no net release content.');

  const changedDocs = changedDocumentation(fileInventory);
  const range = {
    firstRelease: snapshot.firstRelease,
    baselineSha: snapshot.baseline?.sha ?? null,
    diffBase,
    sourceSha: snapshot.sourceSha,
    revision,
  };
  const files = `${stableJson({ range, files: fileInventory, changedDocs })}\n`;
  const directory = join(ctx.stateDir, randomUUID());
  const artifacts = Object.fromEntries(Object.entries(ARTIFACT_NAMES).map(([name, filename]) => [name, join(directory, filename)]));
  const evidence = {
    commits: artifactEvidence(commits),
    diff: artifactEvidence(diff),
    files: artifactEvidence(files),
  };

  await assertCheckout(ctx, { clean: true, head: snapshot.sourceSha });
  await writePrivate(artifacts.commits, commits);
  await writePrivate(artifacts.diff, diff);
  await writePrivate(artifacts.files, files);

  const inspection = seal('inspection', {
    ...snapshot,
    range,
    changeCount: commitCount,
    fileInventory,
    changedDocs,
    artifacts,
    evidence,
  });
  const inspectionPath = join(directory, 'inspection.json');
  await writeJson(inspectionPath, inspection);

  return {
    ok: true,
    command: 'inspect',
    inspection: inspectionPath,
    sourceSha: snapshot.sourceSha,
    baseline: snapshot.baseline,
    workspaceVersion: snapshot.workspaceVersion,
    changeCount: commitCount,
    artifacts,
    publication: publicationScope(snapshot),
  };
}

export async function plan(ctx, { inspection: inspectionOption, version, notes }) {
  expect(
    typeof inspectionOption === 'string' && inspectionOption.length > 0,
    'INVALID_INSPECTION',
    'An inspection artifact path is required.',
  );
  const inspectionPath = resolve(ctx.root, inspectionOption);
  const inspection = await readSealed(inspectionPath, 'inspection');
  await verifyInspectionEvidence(ctx, inspectionPath, inspection);
  await assertCheckout(ctx, { clean: true, head: inspection.payload.sourceSha });

  ctx.progress('plan', { phase: 'refresh' });
  const current = await captureSnapshot(ctx, { fetch: true });
  await assertCheckout(ctx, { clean: true, head: inspection.payload.sourceSha });
  assertSameSnapshot(inspection.payload, current);
  assertCandidate(current, version);
  assertNotes(notes, version);

  const parsedVersion = parseSemver(version);
  const tag = `v${version}`;
  const tagRef = `refs/tags/${tag}`;
  const release = {
    tag,
    title: tag,
    prerelease: parsedVersion.pre.length > 0,
  };
  const publication = publicationScope(current, {
    version,
    tag,
    tagRef,
    release,
  });
  const notesSha256 = sha256(notes);
  const payload = {
    root: ctx.root,
    repo: POLICY.repo,
    remote: POLICY.remote,
    branch: POLICY.branch,
    pushUrl: POLICY.pushUrl,
    sourceSha: current.sourceSha,
    baseline: current.baseline,
    firstRelease: current.firstRelease,
    workspaceVersion: current.workspaceVersion,
    packages: current.packages,
    context: snapshotContext(current),
    workflow: current.workflow,
    version,
    tag,
    tagRef,
    release,
    notes,
    notesSha256,
    inspection: inspectionPath,
    inspectionDigest: inspection.digest,
    evidence: inspection.payload.evidence,
    changedDocs: inspection.payload.changedDocs,
    publication,
  };
  const sealedPlan = seal('plan', payload);
  const planDirectory = join(ctx.stateDir, randomUUID());
  const planPath = join(planDirectory, 'plan.json');
  await writeJson(planPath, sealedPlan);

  return {
    ok: true,
    command: 'plan',
    plan: planPath,
    approvalId: sealedPlan.digest,
    sourceSha: current.sourceSha,
    version,
    tag,
    notes,
    notesSha256,
    publication,
  };
}

import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  POLICY,
  ReleaseError,
  assertCheckout,
  captureSnapshot,
  fail,
  parseSemver,
  readJson,
  readSealed,
  readWorkspace,
  sha256,
  snapshotContext,
  stableJson,
  verifyIdentity,
  withReleaseLock,
  writeJson,
  writePrivate,
} from './core.mjs';

const JOURNAL_SCHEMA = 1;
const WORKFLOW_APPEAR_TIMEOUT_MS = 120_000;
const WORKFLOW_POLL_MS = 5_000;
const WORKFLOW_WATCH_TIMEOUT_MS = 1_800_000;
const RELEASE_COMMAND_TIMEOUT_MS = 1_800_000;
const RELEASE_FILES = ['Cargo.lock', 'Cargo.toml'];

function requireRelease(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}


async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function parseLines(text) {
  return text.split(/\r?\n/u).filter(Boolean);
}

function sameStringSet(actual, expected) {
  return stableJson(sortedUnique(actual)) === stableJson(sortedUnique(expected));
}

function replaceWorkspaceVersion(source, oldVersion, newVersion) {
  const headers = [...source.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu)];
  const workspace = headers.find((match) => match[1].trim() === 'workspace.package');
  requireRelease(workspace, 'RELEASE_SOURCE_INVALID', 'The approved source has no [workspace.package] table.');

  const start = workspace.index + workspace[0].length;
  const next = headers.find((match) => match.index > workspace.index);
  const end = next?.index ?? source.length;
  const section = source.slice(start, end);
  const versions = [...section.matchAll(/^(\s*version\s*=\s*")([^"]+)("[^\r\n]*)$/gmu)];
  requireRelease(
    versions.length === 1,
    'RELEASE_SOURCE_INVALID',
    'The approved source must contain exactly one workspace package version.',
    { count: versions.length },
  );
  requireRelease(
    versions[0][2] === oldVersion,
    'RELEASE_SOURCE_INVALID',
    'The approved source workspace version does not match the sealed plan.',
    { expected: oldVersion, actual: versions[0][2] },
  );

  const match = versions[0];
  const offset = start + match.index;
  const replacement = `${match[1]}${newVersion}${match[3]}`;
  return source.slice(0, offset) + replacement + source.slice(offset + match[0].length);
}

function packageField(block, field) {
  const expression = new RegExp(`^\\s*${field}\\s*=\\s*"([^"]+)"\\s*$`, 'mu');
  const matches = [...block.matchAll(new RegExp(expression.source, 'gmu'))];
  return matches.length === 1 ? matches[0][1] : null;
}

function replaceLockVersions(source, packages, newVersion) {
  const starts = [...source.matchAll(/^\[\[package\]\]\s*$/gmu)].map((match) => match.index);
  requireRelease(starts.length > 0, 'RELEASE_SOURCE_INVALID', 'The approved Cargo.lock has no package entries.');

  const intended = new Map();
  for (const entry of packages) {
    requireRelease(
      entry && typeof entry.name === 'string' && typeof entry.version === 'string' && typeof entry.manifestPath === 'string',
      'RELEASE_PLAN_INVALID',
      'The sealed plan contains an invalid workspace package entry.',
    );
    requireRelease(!intended.has(entry.name), 'RELEASE_PLAN_INVALID', 'The sealed plan repeats a workspace package name.', {
      package: entry.name,
    });
    intended.set(entry.name, entry.version);
  }
  requireRelease(intended.size > 0, 'RELEASE_PLAN_INVALID', 'The sealed plan has no intended workspace packages.');

  const found = new Map();
  let cursor = 0;
  let output = '';
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? source.length;
    let block = source.slice(start, end);
    output += source.slice(cursor, start);
    cursor = end;

    const name = packageField(block, 'name');
    const oldVersion = name === null ? undefined : intended.get(name);
    const hasRegistrySource = /^\s*source\s*=/mu.test(block);
    if (oldVersion !== undefined && !hasRegistrySource) {
      requireRelease(!found.has(name), 'RELEASE_SOURCE_INVALID', 'Cargo.lock repeats an intended local package.', {
        package: name,
      });
      const versionMatches = [...block.matchAll(/^(\s*version\s*=\s*")([^"]+)("\s*)$/gmu)];
      requireRelease(
        versionMatches.length === 1,
        'RELEASE_SOURCE_INVALID',
        'An intended local Cargo.lock package does not have exactly one version.',
        { package: name },
      );
      const match = versionMatches[0];
      requireRelease(
        match[2] === oldVersion,
        'RELEASE_SOURCE_INVALID',
        'An intended local Cargo.lock package version differs from the sealed plan.',
        { package: name, expected: oldVersion, actual: match[2] },
      );
      block = block.slice(0, match.index) + `${match[1]}${newVersion}${match[3]}` + block.slice(match.index + match[0].length);
      found.set(name, true);
    }
    output += block;
  }
  output += source.slice(cursor);

  const missing = [...intended.keys()].filter((name) => !found.has(name));
  requireRelease(
    missing.length === 0,
    'RELEASE_SOURCE_INVALID',
    'Cargo.lock is missing intended local workspace packages.',
    { missing },
  );
  return output;
}

async function sourceFiles(ctx, payload) {
  const manifest = await ctx.git(['show', `${payload.sourceSha}:Cargo.toml`]);
  const lock = await ctx.git(['show', `${payload.sourceSha}:Cargo.lock`]);
  requireRelease(
    replaceWorkspaceVersion(manifest, payload.workspaceVersion, payload.workspaceVersion) === manifest,
    'RELEASE_SOURCE_INVALID',
    'The approved source Cargo.toml cannot be reproduced exactly.',
  );
  requireRelease(
    replaceLockVersions(lock, payload.packages, payload.workspaceVersion) === lock,
    'RELEASE_SOURCE_INVALID',
    'The approved source Cargo.lock cannot be reproduced exactly.',
  );
  return {
    sourceManifest: manifest,
    sourceLock: lock,
    expectedManifest: replaceWorkspaceVersion(manifest, payload.workspaceVersion, payload.version),
    expectedLock: replaceLockVersions(lock, payload.packages, payload.version),
  };
}

async function currentFiles(ctx) {
  return {
    manifest: await readFile(resolve(ctx.root, 'Cargo.toml'), 'utf8'),
    lock: await readFile(resolve(ctx.root, 'Cargo.lock'), 'utf8'),
  };
}

async function worktreeFacts(ctx) {
  const [unstaged, staged, untracked] = await Promise.all([
    ctx.git(['diff', '--name-only', '--']),
    ctx.git(['diff', '--cached', '--name-only', '--']),
    ctx.git(['ls-files', '--others', '--exclude-standard']),
  ]);
  return {
    unstaged: parseLines(unstaged),
    staged: parseLines(staged),
    untracked: parseLines(untracked),
  };
}

function requireCleanFacts(facts, journalPath) {
  requireRelease(
    facts.unstaged.length === 0 && facts.staged.length === 0 && facts.untracked.length === 0,
    'RELEASE_DIRTY_CHECKOUT',
    'The release checkout is not clean.',
    { journal: journalPath, ...facts },
  );
}

async function classifySourceWorktree(ctx, files, journalPath) {
  const current = await currentFiles(ctx);
  const facts = await worktreeFacts(ctx);
  const clean = facts.unstaged.length === 0 && facts.staged.length === 0 && facts.untracked.length === 0;
  if (clean && current.manifest === files.sourceManifest && current.lock === files.sourceLock) return 'source-clean';

  requireRelease(
    facts.staged.length === 0 && facts.untracked.length === 0,
    'RELEASE_LOCAL_STATE_CONFLICT',
    'Recovery found staged or untracked state that cannot be attributed to the approved release.',
    { journal: journalPath, ...facts },
  );

  if (
    sameStringSet(facts.unstaged, ['Cargo.toml']) &&
    current.manifest === files.expectedManifest &&
    current.lock === files.sourceLock
  ) {
    return 'manifest-only';
  }
  if (
    sameStringSet(facts.unstaged, RELEASE_FILES) &&
    current.manifest === files.expectedManifest &&
    current.lock === files.expectedLock
  ) {
    return 'version-dirty';
  }

  fail('RELEASE_LOCAL_STATE_CONFLICT', 'Recovery found partial or unrelated local release state.', {
    journal: journalPath,
    unstaged: facts.unstaged,
    staged: facts.staged,
    untracked: facts.untracked,
    manifestMatchesApprovedVersion: current.manifest === files.expectedManifest,
    lockMatchesApprovedVersion: current.lock === files.expectedLock,
  });
}

async function validateFinalCommit(ctx, payload, files, finalSha, journalPath) {
  if (payload.firstRelease && payload.version === payload.workspaceVersion) {
    requireRelease(finalSha === payload.sourceSha, 'RELEASE_FINAL_SHA_MISMATCH', 'The first-release final SHA must equal the approved source SHA.', {
      journal: journalPath,
      expected: payload.sourceSha,
      actual: finalSha,
    });
  } else {
    const parents = (await ctx.git(['rev-list', '--parents', '-n', '1', finalSha])).trim().split(/\s+/u);
    requireRelease(
      parents.length === 2 && parents[0] === finalSha && parents[1] === payload.sourceSha,
      'RELEASE_FINAL_PARENT_MISMATCH',
      'The release commit must be the only commit after the approved source.',
      { journal: journalPath, sourceSha: payload.sourceSha, commitLine: parents.join(' ') },
    );
    const message = (await ctx.git(['log', '-1', '--format=%B', finalSha])).trimEnd();
    requireRelease(
      message === `chore(release): prepare ${payload.tag}`,
      'RELEASE_COMMIT_MISMATCH',
      'The release commit message differs from the approved release commit.',
      { journal: journalPath, actual: message },
    );
    const changed = parseLines(await ctx.git(['diff-tree', '--no-commit-id', '--name-only', '-r', finalSha]));
    requireRelease(
      sameStringSet(changed, RELEASE_FILES),
      'RELEASE_COMMIT_MISMATCH',
      'The release commit changes files outside Cargo.toml and Cargo.lock.',
      { journal: journalPath, changed },
    );
  }

  const [manifest, lock] = await Promise.all([
    ctx.git(['show', `${finalSha}:Cargo.toml`]),
    ctx.git(['show', `${finalSha}:Cargo.lock`]),
  ]);
  requireRelease(
    manifest === files.expectedManifest && lock === files.expectedLock,
    'RELEASE_COMMIT_MISMATCH',
    'The final release commit does not contain the exact approved version-only contents.',
    { journal: journalPath },
  );
  requireCleanFacts(await worktreeFacts(ctx), journalPath);
}

async function updateJournal(path, journal, change = {}) {
  Object.assign(journal, change, { updatedAt: new Date().toISOString() });
  await writeJson(path, journal);
}

async function recordIntent(path, journal, name, details = {}) {
  journal.intents ??= {};
  journal.intents[name] ??= { at: new Date().toISOString(), ...details };
  await updateJournal(path, journal, { stage: `${name}-intended` });
}

async function recordConfirmation(path, journal, name, details = {}) {
  journal.confirmed ??= {};
  journal.confirmed[name] = { at: new Date().toISOString(), ...details };
  await updateJournal(path, journal, { stage: `${name}-confirmed` });
}

async function allocateLog(journalPath, journal, name) {
  journal.logs ??= {};
  const previous = journal.logs[name];
  const attempts = Array.isArray(previous) ? previous : previous ? [previous] : [];
  const log = resolve(dirname(journalPath), `${name}-${attempts.length + 1}.log`);
  attempts.push(log);
  journal.logs[name] = attempts;
  await updateJournal(journalPath, journal);
  await writePrivate(log, '');
  return log;
}

function failStage(error, code, message, details) {
  if (error instanceof ReleaseError && error.code === 'interrupted') {
    throw new ReleaseError('interrupted', error.message, {
      ...details,
      exitCode: error.details?.exitCode,
      signal: error.details?.signal,
    });
  }
  fail(code, message, { ...details, cause: errorMessage(error) });
}

async function runLogged(ctx, journalPath, journal, name, binary, args, options = {}) {
  const log = await allocateLog(journalPath, journal, name);
  ctx.progress(name);
  try {
    await ctx.exec(binary, args, { timeoutMs: RELEASE_COMMAND_TIMEOUT_MS, ...options, logFile: log });
  } catch (error) {
    failStage(error, 'RELEASE_CHECK_FAILED', `Release check ${name} failed.`, {
      journal: journalPath,
      log,
    });
  }
  await recordConfirmation(journalPath, journal, name, { log });
}

async function validatePlan(ctx, planPath, approve) {
  requireRelease(typeof planPath === 'string' && planPath.length > 0, 'RELEASE_PLAN_REQUIRED', 'A sealed release plan is required.');
  requireRelease(typeof approve === 'string' && approve.length > 0, 'RELEASE_APPROVAL_REQUIRED', 'The exact approval digest is required.');

  const absolute = resolve(planPath);
  const canonicalPlan = await realpath(absolute).catch((error) => {
    fail('RELEASE_PLAN_INVALID', 'The sealed release plan cannot be resolved.', { plan: absolute, cause: errorMessage(error) });
  });
  const canonicalState = await realpath(ctx.stateDir).catch((error) => {
    fail('RELEASE_PLAN_INVALID', 'The release state directory cannot be resolved.', {
      stateDir: ctx.stateDir,
      cause: errorMessage(error),
    });
  });
  requireRelease(
    basename(canonicalPlan) === 'plan.json' && isWithin(canonicalState, canonicalPlan),
    'RELEASE_PLAN_INVALID',
    'The sealed plan must be a plan.json artifact under this checkout’s release state directory.',
    { plan: canonicalPlan, stateDir: canonicalState },
  );

  const sealed = await readSealed(canonicalPlan, 'plan');
  requireRelease(sealed.digest === approve, 'RELEASE_APPROVAL_MISMATCH', 'The approval digest does not match the sealed release plan.', {
    plan: canonicalPlan,
    expected: sealed.digest,
  });
  const payload = sealed.payload;
  requireRelease(payload && typeof payload === 'object', 'RELEASE_PLAN_INVALID', 'The sealed plan payload is invalid.');
  requireRelease(
    payload.root === ctx.root &&
      payload.repo === POLICY.repo &&
      payload.remote === POLICY.remote &&
      payload.branch === POLICY.branch &&
      payload.pushUrl === POLICY.pushUrl,
    'RELEASE_PLAN_SCOPE_MISMATCH',
    'The sealed release plan does not match the fixed publication scope.',
    {
      plan: canonicalPlan,
      expected: { root: ctx.root, repo: POLICY.repo, remote: POLICY.remote, branch: POLICY.branch, pushUrl: POLICY.pushUrl },
    },
  );
  requireRelease(/^[0-9a-f]{40}$/u.test(payload.sourceSha), 'RELEASE_PLAN_INVALID', 'The sealed source SHA is invalid.');
  requireRelease(typeof payload.version === 'string' && payload.tag === `v${payload.version}`, 'RELEASE_PLAN_INVALID', 'The sealed version and tag disagree.');
  parseSemver(payload.version);
  parseSemver(payload.workspaceVersion);
  requireRelease(typeof payload.firstRelease === 'boolean', 'RELEASE_PLAN_INVALID', 'The sealed first-release state is invalid.');
  requireRelease(payload.context && typeof payload.context === 'object', 'RELEASE_PLAN_INVALID', 'The sealed release context is invalid.');
  requireRelease(typeof payload.notes === 'string' && payload.notes.length > 0, 'RELEASE_PLAN_INVALID', 'The sealed release notes are empty.');
  requireRelease(sha256(payload.notes) === payload.notesSha256, 'RELEASE_PLAN_INVALID', 'The sealed release notes hash is invalid.');
  requireRelease(payload.workflow?.fingerprint === payload.context?.workflow?.fingerprint, 'RELEASE_PLAN_INVALID', 'The sealed workflow evidence is inconsistent.');
  requireRelease(Array.isArray(payload.packages) && payload.packages.length > 0, 'RELEASE_PLAN_INVALID', 'The sealed plan has no workspace packages.');
  return { sealed, payload, planPath: canonicalPlan };
}

async function loadOrCreateJournal(planPath, sealed, payload, resume) {
  const journalPath = resolve(dirname(planPath), 'journal.json');
  const present = await exists(journalPath);
  if (resume) {
    requireRelease(present, 'RELEASE_RESUME_JOURNAL_REQUIRED', 'Explicit recovery requires the matching release journal.', {
      plan: planPath,
      journal: journalPath,
    });
    const journal = await readJson(journalPath);
    requireRelease(
      journal?.schema === JOURNAL_SCHEMA &&
        journal.kind === 'release-journal' &&
        journal.approvalId === sealed.digest &&
        journal.plan === planPath &&
        journal.sourceSha === payload.sourceSha &&
        journal.version === payload.version &&
        journal.tag === payload.tag &&
        journal.notesSha256 === payload.notesSha256,
      'RELEASE_RESUME_JOURNAL_MISMATCH',
      'The release journal does not match the approved sealed plan.',
      { plan: planPath, journal: journalPath },
    );
    const expectedNotesPath = resolve(dirname(journalPath), 'approved-notes.txt');
    const storedNotesPaths = [journal.notesPath, journal.intents?.release?.notesPath].filter(
      (notesPath) => notesPath !== undefined,
    );
    requireRelease(
      storedNotesPaths.every((notesPath) => notesPath === expectedNotesPath),
      'RELEASE_RESUME_JOURNAL_MISMATCH',
      'The journal contains an unsafe temporary release-notes path.',
      { journal: journalPath, expected: expectedNotesPath, actual: storedNotesPaths },
    );
    return { journal, journalPath };
  }

  requireRelease(!present, 'RELEASE_ALREADY_STARTED', 'This approved release already has a journal; use explicit resume after reviewing its evidence.', {
    plan: planPath,
    journal: journalPath,
  });
  const now = new Date().toISOString();
  const journal = {
    schema: JOURNAL_SCHEMA,
    kind: 'release-journal',
    approvalId: sealed.digest,
    plan: planPath,
    sourceSha: payload.sourceSha,
    version: payload.version,
    tag: payload.tag,
    notesSha256: payload.notesSha256,
    stage: 'approved',
    createdAt: now,
    updatedAt: now,
    intents: {},
    confirmed: {},
    logs: {},
  };
  await writeJson(journalPath, journal);
  return { journal, journalPath };
}

async function validateSourceWorkspace(ctx, payload, journalPath, resume) {
  requireRelease(
    payload.packages.every((entry) => entry.version === payload.workspaceVersion),
    'RELEASE_SOURCE_WORKSPACE_MISMATCH',
    'The sealed workspace packages do not share the approved source version.',
    { journal: journalPath, workspaceVersion: payload.workspaceVersion, packages: payload.packages },
  );
  if (resume) return;

  const source = await readWorkspace(ctx, payload.sourceSha);
  const expected = {
    version: payload.workspaceVersion,
    packages: payload.packages,
  };
  requireRelease(
    stableJson(source) === stableJson(expected),
    'RELEASE_SOURCE_WORKSPACE_MISMATCH',
    'The approved source workspace no longer matches the sealed plan.',
    { journal: journalPath, expected, actual: source },
  );
}

async function runChecks(ctx, journalPath, journal) {
  if (!journal.confirmed?.check) await runLogged(ctx, journalPath, journal, 'check', 'mise', ['run', 'check']);
  if (!journal.confirmed?.test) await runLogged(ctx, journalPath, journal, 'test', 'mise', ['run', 'test']);
  if (!journal.confirmed?.frontendTypecheck) {
    await runLogged(ctx, journalPath, journal, 'frontendTypecheck', 'npx', ['tsc', '--noEmit'], {
      cwd: resolve(ctx.root, 'frontend'),
    });
  }
  if (!journal.confirmed?.frontendBuild) {
    await runLogged(ctx, journalPath, journal, 'frontendBuild', 'npm', ['run', 'build'], {
      cwd: resolve(ctx.root, 'frontend'),
    });
  }
}

async function prepareCommit(ctx, payload, files, journalPath, journal, resume) {
  const noCommit = payload.firstRelease === true && payload.version === payload.workspaceVersion;
  const head = (await ctx.git(['rev-parse', 'HEAD'])).trim();
  requireRelease(
    !(resume && !noCommit && journal.intents?.commit && head === payload.sourceSha),
    'RELEASE_COMMIT_OUTCOME_AMBIGUOUS',
    'The journal records a commit attempt but the release commit is absent; refusing to recreate it without a human decision.',
    { journal: journalPath, intent: journal.intents?.commit, confirmed: journal.confirmed?.commit },
  );
  if (journal.finalSha) {
    requireRelease(
      head === journal.finalSha,
      'RELEASE_LOCAL_STATE_CONFLICT',
      'The checkout no longer contains the previously confirmed final release commit.',
      { journal: journalPath, expected: journal.finalSha, actual: head },
    );
  }

  if (head !== payload.sourceSha) {
    requireRelease(resume && journal.intents?.commit, 'RELEASE_LOCAL_STATE_CONFLICT', 'HEAD moved before the approved release commit was journaled.', {
      journal: journalPath,
      sourceSha: payload.sourceSha,
      head,
    });
    requireRelease(journal.confirmed?.check && journal.confirmed?.test && journal.confirmed?.frontendTypecheck && journal.confirmed?.frontendBuild,
      'RELEASE_LOCAL_STATE_CONFLICT', 'A release commit exists without durable evidence that every approved check passed.', { journal: journalPath });
    await validateFinalCommit(ctx, payload, files, head, journalPath);
    await recordConfirmation(journalPath, journal, 'commit', { finalSha: head, recovered: true });
    journal.finalSha = head;
    await updateJournal(journalPath, journal);
    return head;
  }

  let localState = await classifySourceWorktree(ctx, files, journalPath);
  if (noCommit) {
    requireRelease(localState === 'source-clean', 'RELEASE_LOCAL_STATE_CONFLICT', 'The unchanged first release must remain clean.', {
      journal: journalPath,
      localState,
    });
    await recordIntent(journalPath, journal, 'version', { noChange: true });
    await recordConfirmation(journalPath, journal, 'version', { noChange: true });
    await runChecks(ctx, journalPath, journal);
    await recordIntent(journalPath, journal, 'commit', { noChange: true });
    await validateFinalCommit(ctx, payload, files, payload.sourceSha, journalPath);
    await recordConfirmation(journalPath, journal, 'commit', { finalSha: payload.sourceSha, noChange: true });
    journal.finalSha = payload.sourceSha;
    await updateJournal(journalPath, journal);
    return payload.sourceSha;
  }

  if (!journal.intents?.version) {
    requireRelease(localState === 'source-clean', 'RELEASE_LOCAL_STATE_CONFLICT', 'Version changes exist without a prior journal intention.', {
      journal: journalPath,
      localState,
    });
    await recordIntent(journalPath, journal, 'version');
  } else {
    requireRelease(resume || localState !== 'source-clean', 'RELEASE_LOCAL_STATE_CONFLICT', 'A fresh release encountered a pre-existing version intention.', {
      journal: journalPath,
    });
  }

  if (localState === 'source-clean') {
    ctx.progress('version');
    await writeFile(resolve(ctx.root, 'Cargo.toml'), files.expectedManifest, 'utf8');
    localState = 'manifest-only';
  }
  if (localState === 'manifest-only') {
    const log = await allocateLog(journalPath, journal, 'cargoUpdate');
    ctx.progress('cargo-update');
    try {
      await ctx.exec('cargo', ['update', '--workspace'], {
        timeoutMs: RELEASE_COMMAND_TIMEOUT_MS,
        logFile: log,
      });
    } catch (error) {
      failStage(error, 'RELEASE_CARGO_UPDATE_FAILED', 'cargo update --workspace failed; the approved release remains recoverable.', {
        journal: journalPath,
        log,
      });
    }
    localState = await classifySourceWorktree(ctx, files, journalPath);
  }
  requireRelease(localState === 'version-dirty', 'RELEASE_VERSION_DIFF_INVALID', 'The version update did not produce the exact approved Cargo.toml and Cargo.lock changes.', {
    journal: journalPath,
    localState,
  });
  await recordConfirmation(journalPath, journal, 'version');

  await runChecks(ctx, journalPath, journal);
  requireRelease((await classifySourceWorktree(ctx, files, journalPath)) === 'version-dirty', 'RELEASE_VERSION_DIFF_INVALID', 'A release check changed the approved version-only diff.', {
    journal: journalPath,
  });

  if (!journal.intents?.commit) await recordIntent(journalPath, journal, 'commit');
  const log = await allocateLog(journalPath, journal, 'commit');
  ctx.progress('commit');
  try {
    await ctx.git(['commit', '--only', 'Cargo.toml', 'Cargo.lock', '-m', `chore(release): prepare ${payload.tag}`], { logFile: log });
  } catch (error) {
    failStage(error, 'RELEASE_COMMIT_FAILED', 'The exact version-only release commit failed; use explicit resume after inspecting the journal.', {
      journal: journalPath,
      log,
    });
  }
  const finalSha = (await ctx.git(['rev-parse', 'HEAD'])).trim();
  await validateFinalCommit(ctx, payload, files, finalSha, journalPath);
  await recordConfirmation(journalPath, journal, 'commit', { finalSha });
  journal.finalSha = finalSha;
  await updateJournal(journalPath, journal);
  return finalSha;
}

async function localTag(ctx, tag) {
  const ref = `refs/tags/${tag}`;
  const result = await ctx.exec('git', ['show-ref', '--verify', '--quiet', ref], { okCodes: [0, 1] });
  if (result.code === 1) return null;
  const type = (await ctx.git(['cat-file', '-t', ref])).trim();
  const target = (await ctx.git(['rev-parse', `${ref}^{}`])).trim();
  const object = (await ctx.git(['rev-parse', ref])).trim();
  return { type, target, object };
}

function parseRemoteRefs(text, payload) {
  const refs = new Map();
  for (const line of parseLines(text)) {
    const match = line.match(/^([0-9a-f]{40})\s+(.+)$/u);
    requireRelease(match, 'RELEASE_REMOTE_REFS_INVALID', 'The remote returned an invalid ref record.', { line });
    requireRelease(!refs.has(match[2]), 'RELEASE_REMOTE_REFS_INVALID', 'The remote returned a duplicate exact ref.', { ref: match[2] });
    refs.set(match[2], match[1]);
  }
  return {
    branch: refs.get(`refs/heads/${POLICY.branch}`) ?? null,
    tagObject: refs.get(`refs/tags/${payload.tag}`) ?? null,
    tagCommit: refs.get(`refs/tags/${payload.tag}^{}`) ?? null,
  };
}

async function remoteRefs(ctx, payload) {
  const tagRef = `refs/tags/${payload.tag}`;
  const output = await ctx.git(['ls-remote', POLICY.remote, `refs/heads/${POLICY.branch}`, tagRef, `${tagRef}^{}`]);
  return parseRemoteRefs(output, payload);
}

function exactRelease(snapshot, payload, journalPath) {
  const matches = snapshot.releases.filter((release) => release.tag === payload.tag);
  requireRelease(matches.length <= 1, 'RELEASE_REMOTE_STATE_CONFLICT', 'Multiple GitHub releases use the approved tag.', {
    journal: journalPath,
    tag: payload.tag,
    count: matches.length,
  });
  return matches[0] ?? null;
}

function validateRelease(release, payload, prerelease, journalPath) {
  requireRelease(
    release.tag === payload.tag &&
      release.name === payload.tag &&
      release.draft === false &&
      release.prerelease === prerelease &&
      release.bodySha256 === payload.notesSha256,
    'RELEASE_GITHUB_RELEASE_CONFLICT',
    'The existing GitHub release does not exactly match the approved tag, title, notes, draft, and prerelease state.',
    {
      journal: journalPath,
      expected: {
        tag: payload.tag,
        name: payload.tag,
        draft: false,
        prerelease,
        bodySha256: payload.notesSha256,
      },
      actual: release,
    },
  );
  requireRelease(
    typeof release.url === 'string' && release.url.length > 0,
    'RELEASE_GITHUB_RELEASE_CONFLICT',
    'The GitHub release has no verifiable URL.',
    { journal: journalPath, release },
  );
}

function stripOwnLocalTag(context, tag, expectedBaseline) {
  return {
    ...context,
    localTags: context.localTags.filter((entry) => entry.name !== tag),
    baseline: expectedBaseline,
  };
}

async function requireFreshPublicationContext(ctx, payload, finalSha, journalPath, allowOwnLocalTag) {
  ctx.progress('refresh');
  const snapshot = await captureSnapshot(ctx, { fetch: true });
  const own = snapshot.localTags.filter((entry) => entry.name === payload.tag);
  if (allowOwnLocalTag) {
    requireRelease(
      own.length === 1 && own[0].commit === finalSha,
      'RELEASE_TAG_CONFLICT',
      'The journaled local tag is absent or points to a different commit.',
      { journal: journalPath, expected: finalSha, actual: own },
    );
  } else {
    requireRelease(own.length === 0, 'RELEASE_TAG_CONFLICT', 'The approved tag appeared before its creation was journaled.', {
      journal: journalPath,
      actual: own,
    });
  }
  const context = allowOwnLocalTag
    ? stripOwnLocalTag(snapshotContext(snapshot), payload.tag, payload.context.baseline)
    : snapshotContext(snapshot);
  requireRelease(
    stableJson(context) === stableJson(payload.context),
    'RELEASE_CONTEXT_STALE',
    'The reviewed branch, tags, releases, or Docker workflow changed after approval.',
    { journal: journalPath, expected: payload.context, actual: context },
  );
  return snapshot;
}

function parseWorkflowPages(output, journalPath) {
  let pages;
  try {
    pages = JSON.parse(output);
  } catch (error) {
    fail('RELEASE_WORKFLOW_RESPONSE_INVALID', 'GitHub returned invalid workflow run data.', {
      journal: journalPath,
      cause: errorMessage(error),
    });
  }
  requireRelease(
    Array.isArray(pages) && pages.every((page) => page && Array.isArray(page.workflow_runs)),
    'RELEASE_WORKFLOW_RESPONSE_INVALID',
    'GitHub workflow pagination did not return workflow run pages.',
    { journal: journalPath },
  );
  const byId = new Map();
  for (const run of pages.flatMap((page) => page.workflow_runs)) {
    requireRelease(run && (typeof run.id === 'number' || typeof run.id === 'string'), 'RELEASE_WORKFLOW_RESPONSE_INVALID', 'A workflow run has no ID.', {
      journal: journalPath,
    });
    byId.set(String(run.id), run);
  }
  return [...byId.values()];
}

async function workflowRuns(ctx, journalPath) {
  const output = await ctx.gh([
    'api',
    '--hostname',
    'github.com',
    '--paginate',
    '--slurp',
    `repos/${POLICY.apiRepo}/actions/workflows/${POLICY.workflow}/runs?event=push&per_page=100`,
  ]);
  return parseWorkflowPages(output, journalPath);
}

async function rejectConcurrentWorkflow(ctx, payload, finalSha, journalPath, allowOwn) {
  const runs = await workflowRuns(ctx, journalPath);
  const active = runs.filter((run) => run.status !== 'completed');
  const unrelated = active.filter(
    (run) => !(allowOwn && run.event === 'push' && run.head_branch === payload.tag && run.head_sha === finalSha),
  );
  requireRelease(unrelated.length === 0, 'RELEASE_DOCKER_CONCURRENT', 'Another Docker publication is active; refusing to race its unconditional latest tag.', {
    journal: journalPath,
    active: unrelated.map((run) => ({ id: run.id, url: run.html_url, status: run.status, headBranch: run.head_branch, headSha: run.head_sha })),
  });
}

async function ensureTag(ctx, payload, finalSha, journalPath, journal, resume) {
  let tag = await localTag(ctx, payload.tag);
  if (tag) {
    requireRelease(resume && journal.intents?.tag, 'RELEASE_TAG_CONFLICT', 'The approved tag exists without a matching recovery intention.', {
      journal: journalPath,
      tag,
    });
    requireRelease(tag.type === 'tag' && tag.target === finalSha, 'RELEASE_TAG_CONFLICT', 'The approved local tag is not one annotated tag at the final SHA.', {
      journal: journalPath,
      expected: finalSha,
      actual: tag,
    });
    if (journal.confirmed?.tag?.object) {
      requireRelease(
        journal.confirmed.tag.object === tag.object,
        'RELEASE_TAG_CONFLICT',
        'The annotated tag object differs from the previously confirmed tag object.',
        { journal: journalPath, expected: journal.confirmed.tag.object, actual: tag.object },
      );
    }
    await recordConfirmation(journalPath, journal, 'tag', { object: tag.object, finalSha, recovered: true });
    return tag;
  }

  requireRelease(
    !journal.intents?.tag,
    'RELEASE_TAG_OUTCOME_AMBIGUOUS',
    'The journal records a tag-creation attempt but the tag is absent; refusing to retag without a human decision.',
    { journal: journalPath, intent: journal.intents?.tag, confirmed: journal.confirmed?.tag },
  );

  await requireFreshPublicationContext(ctx, payload, finalSha, journalPath, false);
  await rejectConcurrentWorkflow(ctx, payload, finalSha, journalPath, false);
  await recordIntent(journalPath, journal, 'tag', { finalSha });
  const log = await allocateLog(journalPath, journal, 'tag');
  ctx.progress('tag');
  try {
    await ctx.git(['tag', '--annotate', payload.tag, finalSha, '--message', payload.tag], { logFile: log });
  } catch (error) {
    failStage(error, 'RELEASE_TAG_FAILED', 'Creating the single annotated release tag failed; use explicit resume after inspecting local state.', {
      journal: journalPath,
      log,
    });
  }
  tag = await localTag(ctx, payload.tag);
  requireRelease(tag?.type === 'tag' && tag.target === finalSha, 'RELEASE_TAG_CONFLICT', 'The created release tag is not annotated at the final SHA.', {
    journal: journalPath,
    actual: tag,
  });
  await recordConfirmation(journalPath, journal, 'tag', { object: tag.object, finalSha });
  return tag;
}

function requireRemotePrePush(refs, payload, journalPath) {
  requireRelease(
    refs.branch === payload.context.remoteMaster && refs.tagObject === null && refs.tagCommit === null,
    'RELEASE_REMOTE_STATE_CONFLICT',
    'Remote branch/tag state is partial, advanced, or unrelated; refusing an automatic repair.',
    { journal: journalPath, expectedBranch: payload.context.remoteMaster, actual: refs },
  );
}

function requireRemotePublished(refs, finalSha, tagObject, journalPath) {
  requireRelease(
    refs.branch === finalSha && refs.tagObject === tagObject && refs.tagCommit === finalSha,
    'RELEASE_REMOTE_STATE_CONFLICT',
    'Remote branch and the exact peeled annotated tag do not both resolve to the final release SHA.',
    { journal: journalPath, expected: { finalSha, tagObject }, actual: refs },
  );
}

async function ensurePush(ctx, payload, finalSha, tagObject, journalPath, journal, resume) {
  let refs = await remoteRefs(ctx, payload);
  const published = refs.branch === finalSha && refs.tagObject === tagObject && refs.tagCommit === finalSha;
  if (published) {
    requireRelease(resume && journal.intents?.push, 'RELEASE_REMOTE_STATE_CONFLICT', 'The release refs were published without a matching journal intention.', {
      journal: journalPath,
      refs,
    });
    await rejectConcurrentWorkflow(ctx, payload, finalSha, journalPath, true);
    await recordConfirmation(journalPath, journal, 'push', { finalSha, recovered: true });
    return refs;
  }
  requireRemotePrePush(refs, payload, journalPath);
  requireRelease(
    !journal.intents?.push,
    'RELEASE_PUSH_OUTCOME_AMBIGUOUS',
    'The journal records an atomic push attempt but the approved remote refs are absent; refusing to republish without a human decision.',
    { journal: journalPath, intent: journal.intents?.push, confirmed: journal.confirmed?.push, actual: refs },
  );

  await requireFreshPublicationContext(ctx, payload, finalSha, journalPath, true);
  const currentTag = await localTag(ctx, payload.tag);
  requireRelease(
    currentTag?.type === 'tag' && currentTag.target === finalSha && currentTag.object === tagObject,
    'RELEASE_TAG_CONFLICT',
    'The local annotated tag changed immediately before publication.',
    { journal: journalPath, expected: { finalSha, tagObject }, actual: currentTag },
  );
  await rejectConcurrentWorkflow(ctx, payload, finalSha, journalPath, resume);
  await assertCheckout(ctx, { clean: true, head: finalSha });
  await recordIntent(journalPath, journal, 'push', { finalSha });
  const log = await allocateLog(journalPath, journal, 'push');
  ctx.progress('push');
  try {
    await ctx.git(
      ['push', '--atomic', POLICY.remote, `HEAD:refs/heads/${POLICY.branch}`, `refs/tags/${payload.tag}`],
      { logFile: log },
    );
  } catch (error) {
    failStage(error, 'RELEASE_PUSH_UNCERTAIN', 'The atomic push did not return success; do not retry without explicit resume and remote reconciliation.', {
      journal: journalPath,
      log,
    });
  }
  refs = await remoteRefs(ctx, payload);
  requireRemotePublished(refs, finalSha, tagObject, journalPath);
  await recordConfirmation(journalPath, journal, 'push', { finalSha });
  return refs;
}

function matchingWorkflowRuns(runs, payload, finalSha, journalPath) {
  const wrongSha = runs.filter((run) => run.event === 'push' && run.head_branch === payload.tag && run.head_sha !== finalSha);
  requireRelease(wrongSha.length === 0, 'RELEASE_WORKFLOW_MISMATCH', 'A Docker workflow for the approved tag targets a different SHA.', {
    journal: journalPath,
    expected: finalSha,
    runs: wrongSha.map((run) => ({ id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion, headSha: run.head_sha })),
  });
  return runs.filter((run) => run.event === 'push' && run.head_branch === payload.tag && run.head_sha === finalSha);
}

async function exactWorkflow(ctx, payload, finalSha, journalPath, journal) {
  const deadline = Date.now() + WORKFLOW_APPEAR_TIMEOUT_MS;
  let matches = [];
  ctx.progress('workflow-appearance');
  do {
    const runs = await workflowRuns(ctx, journalPath);
    matches = matchingWorkflowRuns(runs, payload, finalSha, journalPath);
    requireRelease(matches.length <= 1, 'RELEASE_WORKFLOW_AMBIGUOUS', 'Multiple Docker workflows match the exact approved tag and final SHA.', {
      journal: journalPath,
      matches: matches.map((run) => ({ id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion })),
    });
    if (journal.runId && matches.length === 1 && String(matches[0].id) !== String(journal.runId)) {
      fail('RELEASE_WORKFLOW_MISMATCH', 'The journaled Docker workflow was replaced by a different matching run.', {
        journal: journalPath,
        expectedRunId: journal.runId,
        actualRunId: String(matches[0].id),
      });
    }
    if (matches.length > 0) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(WORKFLOW_POLL_MS, deadline - Date.now()));
  } while (true);

  requireRelease(matches.length === 1, matches.length === 0 ? 'RELEASE_WORKFLOW_NOT_FOUND' : 'RELEASE_WORKFLOW_AMBIGUOUS', matches.length === 0
    ? 'The exact Docker workflow did not appear within the bounded wait.'
    : 'Multiple Docker workflows match the exact approved tag and final SHA.', {
    journal: journalPath,
    tag: payload.tag,
    finalSha,
    matches: matches.map((run) => ({ id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion })),
  });
  requireRelease(
    typeof matches[0].html_url === 'string' && matches[0].html_url.length > 0,
    'RELEASE_WORKFLOW_RESPONSE_INVALID',
    'The exact Docker workflow has no verifiable URL.',
    { journal: journalPath, runId: String(matches[0].id) },
  );
  const run = matches[0];
  journal.runId = String(run.id);
  journal.workflowUrl = run.html_url;
  await recordConfirmation(journalPath, journal, 'workflowFound', { runId: journal.runId, url: run.html_url });
  return run;
}

async function ensureWorkflowSuccess(ctx, payload, finalSha, journalPath, journal) {
  let run = await exactWorkflow(ctx, payload, finalSha, journalPath, journal);
  if (run.status !== 'completed') {
    const log = await allocateLog(journalPath, journal, 'workflowWatch');
    ctx.progress('workflow-watch', { runId: String(run.id) });
    try {
      await ctx.gh(
        ['run', 'watch', String(run.id), '--repo', POLICY.repo, '--exit-status', '--interval', '10'],
        {
          timeoutMs: WORKFLOW_WATCH_TIMEOUT_MS,
          logFile: log,
        },
      );
    } catch (error) {
      const observed = matchingWorkflowRuns(await workflowRuns(ctx, journalPath), payload, finalSha, journalPath)
        .find((candidate) => String(candidate.id) === String(run.id));
      failStage(error, 'RELEASE_WORKFLOW_FAILED', 'The exact Docker workflow failed, was cancelled, or exceeded the bounded watch.', {
        journal: journalPath,
        log,
        runId: String(run.id),
        url: observed?.html_url ?? run.html_url,
        status: observed?.status ?? run.status,
        conclusion: observed?.conclusion ?? run.conclusion,
      });
    }
  }

  run = matchingWorkflowRuns(await workflowRuns(ctx, journalPath), payload, finalSha, journalPath)
    .find((candidate) => String(candidate.id) === String(run.id));
  requireRelease(
    run?.status === 'completed' && run?.conclusion === 'success',
    'RELEASE_WORKFLOW_FAILED',
    'The exact Docker workflow is not completed successfully.',
    {
      journal: journalPath,
      runId: journal.runId,
      url: run?.html_url ?? journal.workflowUrl,
      status: run?.status ?? null,
      conclusion: run?.conclusion ?? null,
    },
  );
  journal.workflowUrl = run.html_url;
  await recordConfirmation(journalPath, journal, 'workflow', { runId: String(run.id), url: run.html_url });
  return run;
}

async function requireSuccessfulExactWorkflow(ctx, payload, finalSha, workflow, journalPath) {
  const matches = matchingWorkflowRuns(await workflowRuns(ctx, journalPath), payload, finalSha, journalPath);
  requireRelease(
    matches.length === 1 &&
      String(matches[0].id) === String(workflow.id) &&
      matches[0].status === 'completed' &&
      matches[0].conclusion === 'success',
    'RELEASE_WORKFLOW_FAILED',
    'The exact successful Docker workflow could not be reconfirmed before release publication.',
    {
      journal: journalPath,
      expectedRunId: String(workflow.id),
      matches: matches.map((run) => ({
        id: String(run.id),
        url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
      })),
    },
  );
  return matches[0];
}

async function ensureGitHubRelease(ctx, payload, finalSha, tagObject, prerelease, workflow, journalPath, journal, resume) {
  requireRemotePublished(await remoteRefs(ctx, payload), finalSha, tagObject, journalPath);
  workflow = await requireSuccessfulExactWorkflow(ctx, payload, finalSha, workflow, journalPath);
  let snapshot = await captureSnapshot(ctx, { fetch: true });
  let release = exactRelease(snapshot, payload, journalPath);
  if (release) {
    requireRelease(resume && journal.intents?.release, 'RELEASE_GITHUB_RELEASE_CONFLICT', 'The GitHub release exists without a matching recovery intention.', {
      journal: journalPath,
      release,
    });
    validateRelease(release, payload, prerelease, journalPath);
    if (journal.confirmed?.release?.url) {
      requireRelease(
        journal.confirmed.release.url === release.url,
        'RELEASE_GITHUB_RELEASE_CONFLICT',
        'The GitHub release URL differs from the previously confirmed release.',
        { journal: journalPath, expected: journal.confirmed.release.url, actual: release.url },
      );
    }
    requireRelease(workflow.status === 'completed' && workflow.conclusion === 'success', 'RELEASE_WORKFLOW_FAILED', 'An existing release cannot be adopted without its exact successful workflow.', {
      journal: journalPath,
      runId: workflow.id,
      url: workflow.html_url,
    });
    journal.releaseUrl = release.url;
    await recordConfirmation(journalPath, journal, 'release', { url: release.url, recovered: true });
    return release;
  }

  requireRelease(
    !journal.intents?.release,
    'RELEASE_CREATE_OUTCOME_AMBIGUOUS',
    'The journal records a release-creation attempt but the release is absent; refusing to recreate it without a human decision.',
    { journal: journalPath, intent: journal.intents?.release, confirmed: journal.confirmed?.release },
  );

  const notesPath = resolve(dirname(journalPath), 'approved-notes.txt');
  await writePrivate(notesPath, payload.notes);
  journal.notesPath = notesPath;
  await recordIntent(journalPath, journal, 'release', { notesPath });
  const log = await allocateLog(journalPath, journal, 'releaseCreate');
  const args = [
    'release',
    'create',
    payload.tag,
    '--repo',
    POLICY.repo,
    '--verify-tag',
    '--title',
    payload.tag,
    '--notes-file',
    notesPath,
  ];
  workflow = await requireSuccessfulExactWorkflow(ctx, payload, finalSha, workflow, journalPath);
  requireRemotePublished(await remoteRefs(ctx, payload), finalSha, tagObject, journalPath);
  if (prerelease) args.push('--prerelease');
  ctx.progress('release-create');
  try {
    await ctx.gh(args, { logFile: log });
  } catch (error) {
    failStage(error, 'RELEASE_CREATE_UNCERTAIN', 'GitHub release creation did not return success; do not retry without explicit resume and API reconciliation.', {
      journal: journalPath,
      log,
      notes: notesPath,
    });
  }

  snapshot = await captureSnapshot(ctx, { fetch: true });
  release = exactRelease(snapshot, payload, journalPath);
  requireRelease(release, 'RELEASE_CREATE_UNCERTAIN', 'GitHub release creation returned success but the exact release is not visible.', {
    journal: journalPath,
    log,
    notes: notesPath,
  });
  validateRelease(release, payload, prerelease, journalPath);
  journal.releaseUrl = release.url;
  await recordConfirmation(journalPath, journal, 'release', { url: release.url });
  return release;
}

async function finalVerification(ctx, payload, files, finalSha, prerelease, workflow, release, journalPath, journal) {
  ctx.progress('verify');
  await assertCheckout(ctx, { clean: true, head: finalSha });
  await validateFinalCommit(ctx, payload, files, finalSha, journalPath);
  const tag = await localTag(ctx, payload.tag);
  requireRelease(tag?.type === 'tag' && tag.target === finalSha && tag.object === journal.confirmed?.tag?.object, 'RELEASE_TAG_CONFLICT', 'Final verification found an invalid or replaced local annotated tag.', {
    journal: journalPath,
    tag,
  });
  requireRemotePublished(await remoteRefs(ctx, payload), finalSha, tag.object, journalPath);

  const currentRuns = matchingWorkflowRuns(await workflowRuns(ctx, journalPath), payload, finalSha, journalPath);
  const currentWorkflow = currentRuns.find((run) => String(run.id) === String(workflow.id));
  requireRelease(
    currentWorkflow?.status === 'completed' && currentWorkflow?.conclusion === 'success',
    'RELEASE_WORKFLOW_FAILED',
    'Final verification could not confirm the exact successful Docker workflow.',
    { journal: journalPath, runId: String(workflow.id), run: currentWorkflow ?? null },
  );

  const snapshot = await captureSnapshot(ctx, { fetch: true });
  const currentRelease = exactRelease(snapshot, payload, journalPath);
  requireRelease(currentRelease, 'RELEASE_GITHUB_RELEASE_CONFLICT', 'Final verification could not find the exact GitHub release.', {
    journal: journalPath,
  });
  validateRelease(currentRelease, payload, prerelease, journalPath);
  requireRelease(currentRelease.url === release.url, 'RELEASE_GITHUB_RELEASE_CONFLICT', 'The GitHub release URL changed during final verification.', {
    journal: journalPath,
    expected: release.url,
    actual: currentRelease.url,
  });
  requireRemotePublished(await remoteRefs(ctx, payload), finalSha, journal.confirmed.tag.object, journalPath);

  journal.releaseUrl = currentRelease.url;
  journal.workflowUrl = currentWorkflow.html_url;
  await recordConfirmation(journalPath, journal, 'complete', {
    finalSha,
    releaseUrl: currentRelease.url,
    workflowUrl: currentWorkflow.html_url,
  });
  const notesPath = resolve(dirname(journalPath), 'approved-notes.txt');
  await rm(notesPath, { force: true });
  return { release: currentRelease, workflow: currentWorkflow };
}

async function executePublish(ctx, approved, resume) {
  const { sealed, payload, planPath } = approved;
  const { journal, journalPath } = await loadOrCreateJournal(planPath, sealed, payload, resume);
  const attachJournal = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ReleaseError) {
        throw new ReleaseError(error.code, error.message, { journal: journalPath, ...(error.details ?? {}) });
      }
      throw new ReleaseError('RELEASE_PUBLISH_FAILED', 'Release publication stopped unexpectedly.', {
        journal: journalPath,
        cause: errorMessage(error),
      });
    }
  };

  return attachJournal(async () => {
    ctx.progress(resume ? 'resume' : 'publish', { version: payload.version });
    await assertCheckout(ctx, resume ? { clean: false } : { clean: true, head: payload.sourceSha });
    await verifyIdentity(ctx);
    await validateSourceWorkspace(ctx, payload, journalPath, resume);
    const files = await sourceFiles(ctx, payload);
    const finalSha = await prepareCommit(ctx, payload, files, journalPath, journal, resume);
    requireRelease(journal.finalSha === finalSha, 'RELEASE_FINAL_SHA_MISMATCH', 'The journaled final SHA differs from the verified release SHA.', {
      journal: journalPath,
      expected: finalSha,
      actual: journal.finalSha,
    });

    const tag = await ensureTag(ctx, payload, finalSha, journalPath, journal, resume);
    await ensurePush(ctx, payload, finalSha, tag.object, journalPath, journal, resume);
    const workflow = await ensureWorkflowSuccess(ctx, payload, finalSha, journalPath, journal);
    const prerelease = parseSemver(payload.version).pre.length > 0;
    const release = await ensureGitHubRelease(ctx, payload, finalSha, tag.object, prerelease, workflow, journalPath, journal, resume);
    const verified = await finalVerification(ctx, payload, files, finalSha, prerelease, workflow, release, journalPath, journal);
    return {
      ok: true,
      command: resume ? 'resume' : 'publish',
      version: payload.version,
      finalSha,
      releaseUrl: verified.release.url,
      workflowUrl: verified.workflow.html_url,
    };
  });
}

export async function publish(ctx, { plan, approve, resume = false }) {
  const approved = await validatePlan(ctx, plan, approve);
  return withReleaseLock(ctx, () => executePublish(ctx, approved, resume), { resume });
}

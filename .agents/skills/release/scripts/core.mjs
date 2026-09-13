import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

export const POLICY = Object.freeze({
  repo: 'github.com/nanazt/azuki',
  apiRepo: 'nanazt/azuki',
  remote: 'origin',
  branch: 'master',
  pushUrl: 'github-nanaz:nanazt/azuki.git',
  workflow: 'docker.yml',
});

export class ReleaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new ReleaseError(code, message, details);
}

export function expect(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

export function parseSemver(text) {
  const match = typeof text === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(text);
  expect(match, 'invalid_version', 'Version must be SemVer 2 without a leading v.', { version: text });
  const pre = match[4]?.split('.') ?? [];
  expect(!pre.some((id) => /^0[0-9]+$/.test(id)), 'invalid_version', 'Numeric prerelease identifiers cannot have leading zeroes.', { version: text });
  return { core: match.slice(1, 4).map(BigInt), pre, build: match[5] };
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) return BigInt(p) < BigInt(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function writePrivate(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function writeJson(file, value) {
  await writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail('invalid_artifact', 'Cannot read the release artifact.', { file, reason: error.message });
  }
}

export function seal(kind, payload) {
  const value = { schema: 1, kind, payload };
  return { ...value, digest: sha256(stableJson(value)) };
}

export async function readSealed(file, kind) {
  const value = await readJson(file);
  expect(value?.schema === 1 && value.kind === kind && value.payload && typeof value.payload === 'object', 'invalid_artifact', 'Unexpected release artifact format.', { file });
  expect(value.digest === seal(kind, value.payload).digest, 'artifact_changed', 'The release artifact changed after it was created.', { file });
  return value;
}

async function execute(binary, args, options = {}) {
  const { cwd = process.cwd(), timeoutMs = 60_000, okCodes = [0], logFile, stdin } = options;
  if (logFile) await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = logFile ? createWriteStream(logFile, { flags: 'a', mode: 0o600 }) : null;
  const child = spawn(binary, args, { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let interrupted = false;
  let outputTooLarge = false;
  let logError;
  let killTimer;
  const terminate = (signal = 'SIGTERM') => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    terminate();
    killTimer ??= setTimeout(() => terminate('SIGKILL'), 2_000).unref();
  };
  const onSignal = () => { interrupted = true; stop(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log?.on('error', (error) => { logError = error; stop(); });
  const collect = (current, chunk) => {
    log?.write(chunk);
    if (log) return (current + chunk.toString('utf8')).slice(-8192);
    if (outputTooLarge) return current;
    const next = current + chunk.toString('utf8');
    if (next.length > 32 * 1024 * 1024) { outputTooLarge = true; stop(); }
    return next;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs).unref();
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } catch (error) {
    fail('command_unavailable', 'Could not start a required release command.', { command: binary, reason: error.message, logFile });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (log && !log.destroyed) await new Promise((resolve) => log.end(resolve));
  }
  const details = { command: [binary, ...args], exitCode: result.code, signal: result.signal, logFile, stdout: result.stdout.slice(-8192), stderr: result.stderr.slice(-8192) };
  if (interrupted) fail('interrupted', 'Release command interrupted; inspect the journal before resuming.', details);
  if (timedOut) fail('command_timeout', 'Release command exceeded its bounded wait.', details);
  if (logError) fail('log_failed', 'Could not preserve the command log.', { ...details, reason: logError.message });
  if (outputTooLarge) fail('output_limit', 'Command output exceeded the release inspection limit.', details);
  expect(okCodes.includes(result.code), 'command_failed', 'A required release command failed.', details);
  return result;
}

export async function createContext(cwd = process.cwd()) {
  const root = (await execute('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  const common = (await execute('git', ['rev-parse', '--git-common-dir'], { cwd: root })).stdout.trim();
  const gitDir = path.resolve(root, common);
  const ctx = {
    root,
    gitDir,
    stateDir: path.join(gitDir, 'azuki-release'),
    exec: (binary, args, options = {}) => execute(binary, args, { cwd: root, ...options }),
    progress: (stage, details = {}) => process.stderr.write(`${JSON.stringify({ stage, ...details })}\n`),
  };
  ctx.git = async (args, options) => (await ctx.exec('git', args, options)).stdout;
  ctx.gh = async (args, options) => (await ctx.exec('mise', ['run', 'gh-nanazt', '--', ...args], options)).stdout;
  return ctx;
}

export async function assertCheckout(ctx, { clean = true, head } = {}) {
  expect((await ctx.git(['rev-parse', '--is-shallow-repository'])).trim() === 'false', 'unsupported_history', 'Release review requires complete, non-shallow Git history.');
  expect(!Object.hasOwn(process.env, 'GIT_REPLACE_REF_BASE'), 'unsupported_history', 'Unset custom Git replacement history before releasing.');
  expect((await ctx.git(['for-each-ref', '--format=%(refname)', 'refs/replace/'])).trim() === '', 'unsupported_history', 'Git replacement objects cannot be used as release review evidence.');
  const graftFile = process.env.GIT_GRAFT_FILE ?? (await ctx.git(['rev-parse', '--git-path', 'info/grafts'])).trim();
  try {
    const grafts = await readFile(path.resolve(ctx.root, graftFile), 'utf8');
    expect(!grafts.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith('#')), 'unsupported_history', 'Git grafts cannot be used as release review evidence.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const branch = (await ctx.git(['symbolic-ref', '--short', 'HEAD'])).trim();
  const upstream = (await ctx.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
  expect(branch === POLICY.branch && upstream === 'origin/master', 'wrong_checkout', 'Release requires master tracking origin/master.', { branch, upstream });
  const fetchUrls = (await ctx.git(['remote', 'get-url', '--all', POLICY.remote])).trim().split('\n');
  const pushUrls = (await ctx.git(['remote', 'get-url', '--push', '--all', POLICY.remote])).trim().split('\n');
  expect(fetchUrls.length === 1 && fetchUrls[0] === POLICY.pushUrl && pushUrls.length === 1 && pushUrls[0] === POLICY.pushUrl, 'wrong_remote', 'Effective fetch and push destinations must match the approved repository.', { fetchUrls, pushUrls });
  const actualHead = (await ctx.git(['rev-parse', 'HEAD'])).trim();
  if (head) expect(actualHead === head, 'source_changed', 'HEAD differs from the approved source.', { expected: head, actual: actualHead });
  if (clean) {
    const status = await ctx.git(['status', '--porcelain=v1', '--untracked-files=all']);
    expect(status === '', 'dirty_checkout', 'Fresh release work requires an empty staged, unstaged, and untracked state.', { status });
  }
  return { head: actualHead, branch, upstream };
}

export async function verifyIdentity(ctx) {
  for (const key of ['user.name', 'user.email']) {
    expect((await ctx.git(['config', '--get', key])).trim() !== '', 'missing_git_identity', 'Configure a Git commit identity before releasing.');
  }
  const gitAuthor = (await ctx.git(['var', 'GIT_AUTHOR_IDENT'])).trim();
  const gitCommitter = (await ctx.git(['var', 'GIT_COMMITTER_IDENT'])).trim();
  const config = async (key) => (await ctx.exec('git', ['config', '--get', key], { okCodes: [0, 1] })).stdout.trim();
  const variant = process.env.GIT_SSH_VARIANT || await config('ssh.variant');
  expect(!variant || variant === 'ssh', 'unsupported_ssh', 'The configured Git SSH transport must support an OpenSSH authentication probe.', { variant });
  const shellCommand = process.env.GIT_SSH_COMMAND || await config('core.sshCommand');
  let probe;
  try {
    probe = shellCommand
      ? await ctx.exec('sh', ['-c', `exec ${shellCommand} "$@"`, 'azuki-release-ssh', '-T', 'github-nanaz'], { okCodes: [0, 1] })
      : await ctx.exec(process.env.GIT_SSH || 'ssh', ['-T', 'github-nanaz'], { okCodes: [0, 1] });
  } catch (error) {
    fail('ssh_probe_failed', 'The effective Git SSH authentication probe failed; inspect the transport configuration locally.', { exitCode: error.details?.exitCode ?? null, signal: error.details?.signal ?? null });
  }
  const greeting = `${probe.stdout}\n${probe.stderr}`;
  expect(/^Hi nanazt! You've successfully authenticated, but GitHub does not provide shell access\.$/m.test(greeting), 'wrong_ssh_identity', 'The effective Git SSH transport did not authenticate as nanazt.');
  const api = (await ctx.gh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim();
  expect(api === 'nanazt', 'wrong_api_identity', 'The GitHub API account must be nanazt.', { account: api });
  return { gitAuthor, gitCommitter, ssh: 'nanazt', api };
}

export function workspaceVersion(toml) {
  const section = /^\[workspace\.package\][^\S\r\n]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml);
  expect(section, 'workspace_format', 'Cannot identify [workspace.package].');
  const versions = [...section[1].matchAll(/^\s*version\s*=\s*"([^"]+)"[^\S\r\n]*(?:#[^\r\n]*)?$/gm)];
  expect(versions.length === 1, 'workspace_format', 'Expected exactly one workspace package version.');
  parseSemver(versions[0][1]);
  return versions[0][1];
}

export async function readWorkspace(ctx, ref = null) {
  const source = ref ? await ctx.git(['show', `${ref}:Cargo.toml`]) : await readFile(path.join(ctx.root, 'Cargo.toml'), 'utf8');
  const version = workspaceVersion(source);
  const metadata = JSON.parse(await ctx.exec('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline', '--locked']).then((result) => result.stdout));
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((item) => members.has(item.id)).map((item) => ({ name: item.name, version: item.version, manifestPath: path.relative(ctx.root, item.manifest_path).split(path.sep).join('/') })).sort((a, b) => a.name.localeCompare(b.name));
  expect(packages.some((item) => item.name === 'azuki'), 'wrong_workspace', 'The checkout must contain the azuki workspace package.');
  if (!ref) expect(packages.every((item) => item.version === version), 'workspace_versions', 'All intended workspace packages must share the workspace release version.', { packages });
  return { version, packages };
}

function validTag(name) {
  if (!name.startsWith('v')) return false;
  try { parseSemver(name.slice(1)); return true; } catch { return false; }
}

async function workflowInfo(ctx) {
  const source = await readFile(path.join(ctx.root, 'workflows/docker.ts'), 'utf8');
  const generated = await readFile(path.join(ctx.root, '.github/workflows/docker.yml'), 'utf8');
  const lines = generated.replaceAll('\r\n', '\n').split('\n');
  const start = lines.indexOf('on:');
  let end = start + 1;
  while (end < lines.length && (!lines[end] || /^\s/.test(lines[end]))) end++;
  const trigger = lines.slice(start, end).join('\n').trimEnd();
  expect(start >= 0 && trigger === 'on:\n  push:\n    tags:\n    - v*', 'unsupported_workflow', 'Review the Docker publication trigger before using release automation.');
  const expectedTags = ['type=semver,pattern={{version}}', 'type=semver,pattern={{major}}.{{minor}}', 'type=raw,value=latest'];
  const tagBlock = /^        tags: \|-\r?\n((?:          [^\r\n]+\r?\n)+)/m.exec(generated);
  expect(tagBlock && stableJson(tagBlock[1].trim().split(/\r?\n/).map((line) => line.trim())) === stableJson(expectedTags), 'unsupported_workflow', 'Review the Docker image tag templates before releasing.');
  return { fingerprint: sha256(stableJson({ source, generated })), tagPattern: 'v*', latestUnconditional: true, semverTemplates: ['{{version}}', '{{major}}.{{minor}}'] };
}

export async function captureSnapshot(ctx, { fetch = true } = {}) {
  const checkout = await assertCheckout(ctx, { clean: false });
  if (fetch) await ctx.git(['fetch', POLICY.remote, '--tags'], { timeoutMs: 120_000 });
  const remoteMaster = (await ctx.git(['rev-parse', 'origin/master'])).trim();
  const ancestry = await ctx.exec('git', ['merge-base', '--is-ancestor', remoteMaster, checkout.head], { okCodes: [0, 1] });
  expect(ancestry.code === 0, 'upstream_not_ancestor', 'The checkout is behind or diverged; release automation will not merge or rebase.', { remoteMaster, head: checkout.head });
  const localRefs = await ctx.git(['for-each-ref', '--format=%(refname:strip=2)\t%(objectname)', 'refs/tags']);
  const reachable = new Set((await ctx.git(['for-each-ref', `--merged=${checkout.head}`, '--format=%(refname:strip=2)', 'refs/tags'])).trim().split('\n'));
  const localTags = [];
  for (const line of localRefs.trim().split('\n').filter(Boolean)) {
    const [name, object] = line.split('\t');
    const peeled = validTag(name) ? await ctx.exec('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], { okCodes: [0, 1] }) : null;
    localTags.push({ name, object, commit: peeled?.code === 0 ? peeled.stdout.trim() : null, reachable: reachable.has(name) });
  }
  localTags.sort((a, b) => a.name.localeCompare(b.name));
  const remoteOutput = await ctx.git(['ls-remote', POLICY.remote, 'refs/heads/master', 'refs/tags/*'], { timeoutMs: 120_000 });
  const remoteRefs = Object.fromEntries(remoteOutput.trim().split('\n').filter(Boolean).map((line) => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
  expect(remoteRefs['refs/heads/master'] === remoteMaster, 'remote_changed', 'The remote branch changed during inspection; inspect again.');
  const remoteTags = Object.fromEntries(Object.entries(remoteRefs).filter(([ref]) => ref.startsWith('refs/tags/')).sort(([a], [b]) => a.localeCompare(b)));
  const pages = JSON.parse(await ctx.gh(['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${POLICY.apiRepo}/releases?per_page=100`]));
  expect(Array.isArray(pages) && pages.every(Array.isArray), 'github_response', 'Unexpected GitHub release-list response.');
  const releases = pages.flat().map((item) => ({ id: item.id, tag: item.tag_name, name: item.name, draft: item.draft, prerelease: item.prerelease, url: item.html_url, bodySha256: sha256(item.body ?? '') })).sort((a, b) => a.tag.localeCompare(b.tag));
  const candidates = localTags.filter((item) => validTag(item.name) && item.commit && item.reachable).sort((a, b) => compareSemver(a.name.slice(1), b.name.slice(1)) || a.name.localeCompare(b.name));
  const highest = candidates.at(-1);
  if (highest) {
    expect(!candidates.some((item) => compareSemver(item.name.slice(1), highest.name.slice(1)) === 0 && item.commit !== highest.commit), 'ambiguous_baseline', 'Highest-precedence tags point to different commits; resolve the release baseline explicitly.');
  }
  const historyExists = localTags.some((item) => validTag(item.name)) || Object.keys(remoteTags).some((ref) => validTag(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''))) || releases.length > 0;
  expect(highest || !historyExists, 'unreachable_baseline', 'Release history exists, but no valid release tag is reachable from HEAD.');
  const workspace = await readWorkspace(ctx);
  const workflow = await workflowInfo(ctx);
  return { root: ctx.root, sourceSha: checkout.head, remoteMaster, localTags, remoteTags, releases, baseline: highest ? { tag: highest.name, version: highest.name.slice(1), sha: highest.commit } : null, firstRelease: !historyExists, workspaceVersion: workspace.version, packages: workspace.packages, workflow };
}

export function snapshotContext(snapshot) {
  return { remoteMaster: snapshot.remoteMaster, localTags: snapshot.localTags, remoteTags: snapshot.remoteTags, releases: snapshot.releases, baseline: snapshot.baseline, workflow: snapshot.workflow };
}

export function assertCandidate(snapshot, version) {
  parseSemver(version);
  const comparison = compareSemver(version, snapshot.workspaceVersion);
  expect(comparison > 0 || (snapshot.firstRelease && comparison === 0), 'version_order', 'Version must exceed the workspace version, except an equal true first release.', { version, workspaceVersion: snapshot.workspaceVersion });
  if (snapshot.baseline) expect(compareSemver(version, snapshot.baseline.version) > 0, 'version_order', 'Version must have greater SemVer precedence than the release baseline.', { version, baseline: snapshot.baseline });
  const tag = `v${version}`;
  expect(!snapshot.localTags.some((item) => item.name === tag) && !Object.hasOwn(snapshot.remoteTags, `refs/tags/${tag}`) && !Object.hasOwn(snapshot.remoteTags, `refs/tags/${tag}^{}`) && !snapshot.releases.some((item) => item.tag === tag), 'version_exists', 'The exact candidate tag or GitHub release already exists.', { tag });
}

export async function withReleaseLock(ctx, fn, { resume = false } = {}) {
  await mkdir(ctx.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(ctx.stateDir, 'publish.lock');
  const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  try {
    await writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recoveryLock = path.join(ctx.stateDir, 'lock-recovery');
    try {
      await writeFile(recoveryLock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } catch (claimError) {
      if (claimError.code !== 'EEXIST') throw claimError;
      fail('release_locked', 'Another process owns lock recovery; inspect its owner before proceeding.', { lock: recoveryLock });
    }
    try {
      const previous = await readJson(file);
      let dead = false;
      if (previous.hostname === owner.hostname && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); } catch (probeError) { dead = probeError.code === 'ESRCH'; }
      }
      expect(resume && dead, 'release_locked', 'Another release owns the publication lock; do not race publication.', { lock: file, owner: previous });
      await unlink(file);
      await writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } finally {
      await unlink(recoveryLock);
    }
  }
  try {
    return await fn();
  } finally {
    const current = await readJson(file);
    if (current.token === owner.token) await unlink(file);
  }
}

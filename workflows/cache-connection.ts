import { Workflow, Job } from "../generated/index.js";

const tag = "connection-check-34852202284-1";
const digest = "sha256:15b0616a2b7518fccefa877d329579960a1cfcce52cda3b48b5d976612f377be";

new Workflow({
  name: "Temporary GHCR Connection Check",
  on: { workflow_dispatch: {} },
  permissions: { contents: "read", packages: "write" },
}).jobs(j => j.add("read-cleanup", new Job("ubuntu-latest", {
  "timeout-minutes": 5,
  env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", PROBE_TAG: tag, PROBE_DIGEST: digest },
}).steps(s => s
  .add({
    name: "Delete only the newly created probe package",
    // Gaji strips static import lines even inside generated shell strings.
    run: `node --input-type=module <<'NODE'
const { default: assert } = await import('node:assert/strict');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'nanazt/azuki');
const base = 'https://api.github.com/users/nanazt/packages/container/azuki-build-cache';
const headers = { accept: 'application/vnd.github+json', authorization: 'Bearer ' + process.env.GH_TOKEN, 'x-github-api-version': '2022-11-28' };
const pkgResponse = await fetch(base, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(pkgResponse.status, 200);
const pkg = await pkgResponse.json();
console.log(JSON.stringify({ operation: 'package', visibility: pkg.visibility, repository: pkg.repository?.full_name, createdAt: pkg.created_at, versionCount: pkg.version_count }));
assert.equal(pkg.created_at, '2026-09-14T13:54:57Z', 'Do not delete a different package.');
assert.equal(pkg.repository?.full_name, 'nanazt/azuki');
assert.equal(pkg.version_count, 1, 'Do not delete a package containing other versions.');
const response = await fetch(base + '/versions?per_page=100&state=active&page=1', { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 200);
assert.equal(response.headers.get('link'), null, 'Do not act on incomplete inventory.');
const versions = await response.json();
assert.equal(versions.length, 1, 'Do not delete a package containing other versions.');
const owned = versions.filter(v => v.name === process.env.PROBE_DIGEST && v.metadata?.container?.tags?.includes(process.env.PROBE_TAG));
assert.equal(owned.length, 1);
assert.equal(owned[0].id, 1246865839);
assert.deepEqual(owned[0].metadata.container.tags, [process.env.PROBE_TAG]);
console.log(JSON.stringify({ operation: 'owned-version', id: owned[0].id, digest: owned[0].name, tags: owned[0].metadata.container.tags, activeVersionCount: versions.length }));
const deletion = await fetch(base, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
console.log(JSON.stringify({ operation: 'delete', status: deletion.status, body: await deletion.text() }));
assert.equal(deletion.status, 204);
const confirmation = await fetch(base, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
console.log(JSON.stringify({ operation: 'confirm-package-missing', status: confirmation.status }));
await confirmation.body?.cancel();
assert.equal(confirmation.status, 404);
NODE`,
  }),
))).build("cache-connection");

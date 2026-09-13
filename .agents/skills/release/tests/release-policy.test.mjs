import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  assertCliFailure,
  createReleaseFixture,
  preparePlan,
} from "./helpers.mjs";

function assertPublicationUnchanged(before, after) {
  assert.deepEqual(after, before);
}

function assertNoCandidatePublication(before, after) {
  assert.equal(after.commits, before.commits);
  assert.equal(after.head, before.head);
  assert.equal(after.localTag, null);
  assert.equal(after.remoteTag, null);
  assert.equal(after.remoteHead, before.remoteHead);
  assert.deepEqual(after.releases, before.releases);
}

test("inspect and plan cannot publish, and publish rejects anything but the exact approval", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const before = await fixture.refState("v0.3.0");

  const { plan } = await preparePlan(fixture, "0.3.0");
  assertPublicationUnchanged(before, await fixture.refState("v0.3.0"));

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", "0".repeat(64));
  assertCliFailure(rejected, "RELEASE_APPROVAL_MISMATCH");
  assertPublicationUnchanged(before, await fixture.refState("v0.3.0"));

  const service = await fixture.readState();
  assert.equal(service.releaseCreateCalls, 0);
  assert.equal(service.gitNetworkCalls.some((args) => args.includes("push")), false);
});

test("publish rejects a tampered sealed plan before any local or remote release mutation", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  const before = await fixture.refState("v0.3.0");
  const sealed = JSON.parse(await readFile(plan.plan, "utf8"));
  sealed.payload.notes = sealed.payload.notes.replace("complete", "tampered");
  await writeFile(plan.plan, `${JSON.stringify(sealed)}\n`);

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "artifact_changed");
  assertPublicationUnchanged(before, await fixture.refState("v0.3.0"));
});

test("publish rejects a source commit created after approval", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  await fixture.commitChange();
  const changed = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "source_changed");
  assertPublicationUnchanged(changed, await fixture.refState("v0.3.0"));
});

test("publish rejects a plan whose inspected tag and release context became stale", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  await fixture.git("tag", "-a", "v0.2.5", "-m", "v0.2.5", fixture.sourceSha);
  await fixture.git("push", fixture.remote, "refs/tags/v0.2.5:refs/tags/v0.2.5");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_CONTEXT_STALE");
  const after = await fixture.refState("v0.3.0");
  assert.equal(after.localTag, null);
  assert.equal(after.remoteTag, null);
  assert.deepEqual(after.releases, []);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.2.5^{}"), fixture.sourceSha);
});

test("identity and effective destination checks fail closed", async (t) => {
  await t.test("wrong SSH identity", async (t) => {
    const fixture = await createReleaseFixture({ service: { sshIdentity: "someone-else" } });
    t.after(fixture.cleanup);
    const before = await fixture.refState();
    const rejected = await fixture.runCli("inspect");
    assertCliFailure(rejected, "wrong_ssh_identity");
    assertPublicationUnchanged(before, await fixture.refState());
  });

  await t.test("failed effective SSH command does not expose its configured secret", async (t) => {
    const fixture = await createReleaseFixture();
    t.after(fixture.cleanup);
    const secret = "AZUKI_FIXTURE_SECRET_MUST_NOT_LEAK_4d8f1c";
    await fixture.git("config", "core.sshCommand", `sh -c 'exit 23' ${secret}`);
    const before = await fixture.refState();
    const rejected = await fixture.runCli("inspect");
    assertCliFailure(rejected, "ssh_probe_failed");
    assert.equal(`${rejected.stdout}\n${rejected.stderr}`.includes(secret), false);
    assertPublicationUnchanged(before, await fixture.refState());
  });

  await t.test("wrong API identity", async (t) => {
    const fixture = await createReleaseFixture({ service: { apiIdentity: "someone-else" } });
    t.after(fixture.cleanup);
    const before = await fixture.refState();
    const rejected = await fixture.runCli("inspect");
    assertCliFailure(rejected, "wrong_api_identity");
    assertPublicationUnchanged(before, await fixture.refState());
  });

  await t.test("push destination changed after planning", async (t) => {
    const fixture = await createReleaseFixture();
    t.after(fixture.cleanup);
    const { plan } = await preparePlan(fixture, "0.3.0");
    await fixture.git("config", "remote.origin.pushurl", "ssh://attacker.example/wrong/repository.git");
    const before = await fixture.refState("v0.3.0");
    const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
    assertCliFailure(rejected, "wrong_remote");
    assertPublicationUnchanged(before, await fixture.refState("v0.3.0"));
    const service = await fixture.readState();
    assert.equal(service.gitNetworkCalls.some((args) => args.includes("push")), false);
  });
});

test("inspect refuses alternate Git history views before any publication access", async (t) => {
  async function assertHistoryRejected(fixture) {
    const rejected = await fixture.runCli("inspect");
    assertCliFailure(rejected, "unsupported_history");
    const publication = await fixture.refState("v0.3.0");
    assert.equal(publication.localTag, null);
    assert.equal(publication.remoteTag, null);
    assert.equal(publication.remoteHead, fixture.sourceSha);
    assert.deepEqual(publication.releases, []);
    const services = await fixture.readState();
    assert.equal(services.gitNetworkCalls.length, 0);
    assert.equal(services.releaseCreateCalls, 0);
  }

  await t.test("shallow repository", async (t) => {
    const fixture = await createReleaseFixture({ baselineVersions: [] });
    t.after(fixture.cleanup);
    await writeFile(join(fixture.repo, ".git", "shallow"), `${fixture.sourceSha}\n`);
    await assertHistoryRejected(fixture);
  });

  await t.test("replace ref", async (t) => {
    const fixture = await createReleaseFixture({ baselineVersions: [] });
    t.after(fixture.cleanup);
    const tree = await fixture.git("rev-parse", "HEAD^{tree}");
    const replacement = await fixture.git("commit-tree", tree, "-m", "altered-history");
    await fixture.git("replace", fixture.sourceSha, replacement);
    await assertHistoryRejected(fixture);
  });

  await t.test("grafts file", async (t) => {
    const fixture = await createReleaseFixture({ baselineVersions: [] });
    t.after(fixture.cleanup);
    await writeFile(join(fixture.repo, ".git", "info", "grafts"), `${fixture.sourceSha}\n`);
    await assertHistoryRejected(fixture);
  });
});

test("an unrelated Cargo.lock change is not accepted as a release version diff", async (t) => {
  const fixture = await createReleaseFixture({ service: { lockDrift: "unrelated-version" } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  const before = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_LOCAL_STATE_CONFLICT");
  assertNoCandidatePublication(before, await fixture.refState("v0.3.0"));
  const state = await fixture.readState();
  assert.equal(state.releaseCreateCalls, 0);
});

test("a failing release check stops before commit, tag, push, and API release", async (t) => {
  const fixture = await createReleaseFixture({ service: { failCheck: "check" } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  const before = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_CHECK_FAILED");
  assertNoCandidatePublication(before, await fixture.refState("v0.3.0"));
  const state = await fixture.readState();
  assert.equal(state.gitNetworkCalls.some((args) => args.includes("push")), false);
  assert.equal(state.releaseCreateCalls, 0);
});

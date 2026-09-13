import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertAnnotatedPublication,
  assertCliFailure,
  assertCliSuccess,
  createReleaseFixture,
  preparePlan,
  runSmokeScenario,
} from "./helpers.mjs";

function activeWorkflow() {
  return {
    id: 77,
    html_url: "https://github.test/nanazt/azuki/actions/runs/77",
    status: "in_progress",
    conclusion: null,
    event: "push",
    head_branch: "v9.9.9",
    head_sha: "7777777777777777777777777777777777777777",
    name: "Docker Build & Push",
    path: ".github/workflows/docker.yml",
  };
}

test("publish creates one version-only commit, annotated tag, matching workflow, and exact API release", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const version = "0.3.0-rc.1";
  const tag = `v${version}`;
  const { plan, notes } = await preparePlan(fixture, version);
  const approvedNotes = await readFile(notes, "utf8");
  await writeFile(notes, `# ${tag}\n\n## Added\n\n- Unapproved replacement notes.\n`);
  const before = await fixture.refState(tag);

  const result = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  const published = assertCliSuccess(result, "publish");
  const after = await fixture.refState(tag);
  assert.equal(after.commits, before.commits + 1);
  assert.equal(await fixture.git("rev-parse", `${published.finalSha}^`), fixture.sourceSha);
  assert.equal(await fixture.git("log", "-1", "--format=%B", published.finalSha), `chore(release): prepare ${tag}`);
  assert.deepEqual((await fixture.git("diff-tree", "--no-commit-id", "--name-only", "-r", published.finalSha)).split("\n").sort(), ["Cargo.lock", "Cargo.toml"]);
  assert.match(await fixture.git("show", `${published.finalSha}:Cargo.toml`), new RegExp(`version = "${version.replaceAll(".", "\\.")}"`));
  await assertAnnotatedPublication(fixture, {
    tag,
    finalSha: published.finalSha,
    notes: approvedNotes,
    prerelease: true,
  });
});

test("publish atomically advances branch and tag when the approved source is ahead of upstream", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const remoteBefore = await fixture.remoteGit("rev-parse", "refs/heads/master");
  const aheadSource = await fixture.commitChange("ahead-of-upstream.txt", "reviewed local release content\n");
  assert.notEqual(aheadSource, remoteBefore);
  const { plan, notes } = await preparePlan(fixture, "0.3.0");

  const result = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  const published = assertCliSuccess(result, "publish");
  assert.equal(await fixture.git("rev-parse", `${published.finalSha}^`), aheadSource);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), published.finalSha);
  await assertAnnotatedPublication(fixture, {
    tag: "v0.3.0",
    finalSha: published.finalSha,
    notes: await readFile(notes, "utf8"),
  });
});

test("the directly executable smoke helper exercises the full stable release flow", async () => {
  const smoke = await runSmokeScenario();
  assert.equal(smoke.result.command, "publish");
  assert.equal(smoke.release.tag, "v0.3.0");
  assert.equal(smoke.workflow.head_sha, smoke.result.finalSha);
  assert.notEqual(smoke.before.remoteHead, smoke.after.remoteHead);
  assert.equal(smoke.after.remoteHead, smoke.result.finalSha);
});

test("publish watches a pending exact workflow through completed success before creating the release", async (t) => {
  const fixture = await createReleaseFixture({ service: { workflowMode: "pending" } });
  t.after(fixture.cleanup);
  const { plan, notes } = await preparePlan(fixture, "0.3.0");

  const result = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  const published = assertCliSuccess(result, "publish");
  const evidence = await assertAnnotatedPublication(fixture, {
    tag: "v0.3.0",
    finalSha: published.finalSha,
    notes: await readFile(notes, "utf8"),
  });
  assert.equal(evidence.workflow.status, "completed");
  assert.equal(evidence.workflow.conclusion, "success");
});

test("a successful watch exit cannot override a cancelled final API state", async (t) => {
  const fixture = await createReleaseFixture({ service: { workflowMode: "watch-lies" } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_WORKFLOW_FAILED");
  const finalSha = await fixture.git("rev-parse", "HEAD");
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), finalSha);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.3.0^{}"), finalSha);
  const state = await fixture.readState();
  assert.equal(state.workflowRuns.some((run) => run.head_branch === "v0.3.0" && run.status === "completed" && run.conclusion === "cancelled"), true);
  assert.deepEqual(state.releases, []);
});

test("an unrelated active Docker publication blocks tagging and all remote release effects", async (t) => {
  const fixture = await createReleaseFixture({ service: { workflowRuns: [activeWorkflow()] } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  const before = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_DOCKER_CONCURRENT");
  const after = await fixture.refState("v0.3.0");
  assert.equal(after.localTag, null);
  assert.equal(after.remoteTag, null);
  assert.equal(after.remoteHead, before.remoteHead);
  assert.deepEqual(after.releases, []);
});

test("a failed exact tag-and-SHA workflow leaves real pushed refs but no GitHub release", async (t) => {
  const fixture = await createReleaseFixture({ service: { workflowMode: "failure" } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_WORKFLOW_FAILED");
  const finalSha = await fixture.git("rev-parse", "HEAD");
  assert.equal(await fixture.git("cat-file", "-t", "refs/tags/v0.3.0"), "tag");
  assert.equal(await fixture.remoteGit("cat-file", "-t", "refs/tags/v0.3.0"), "tag");
  assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.3.0^{}"), finalSha);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), finalSha);
  const state = await fixture.readState();
  assert.equal(state.workflowRuns.some((run) => run.head_branch === "v0.3.0" && run.head_sha === finalSha && run.conclusion === "failure"), true);
  assert.deepEqual(state.releases, []);
});

test("final verification rejects a workflow whose identity changes after exact selection", async (t) => {
  const fixture = await createReleaseFixture({ service: { workflowFlipIdentity: true } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_WORKFLOW_MISMATCH");
  const state = await fixture.readState();
  assert.equal(state.workflowIdentityFlipped, true);
  assert.equal(state.workflowRuns.some((run) => run.head_branch === "v0.3.0" && run.head_sha === "0".repeat(40)), true);
  assert.deepEqual(state.releases, []);
});

test("final verification catches a remote branch rollback during the last API snapshot", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  await fixture.updateState({
    rollbackRemoteAfterReleaseList: true,
    rollbackRemoteTo: fixture.sourceSha,
  });

  const rejected = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_REMOTE_STATE_CONFLICT");
  const finalSha = await fixture.git("rev-parse", "HEAD");
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), fixture.sourceSha);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.3.0^{}"), finalSha);
  const state = await fixture.readState();
  assert.equal(state.remoteRollbackApplied, true);
  assert.equal(state.releases.length, 1);
  assert.equal(state.releaseCreateCalls, 1);
});

test("resume recovers a push that succeeded remotely after its acknowledgement was lost", async (t) => {
  const fixture = await createReleaseFixture({ service: { pushMode: "uncertain-after-success" } });
  t.after(fixture.cleanup);
  const { plan, notes } = await preparePlan(fixture, "0.3.0");
  const approvedNotes = await readFile(notes, "utf8");

  const interrupted = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(interrupted, "RELEASE_PUSH_UNCERTAIN");
  const finalSha = await fixture.git("rev-parse", "HEAD");
  assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), finalSha);
  assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.3.0^{}"), finalSha);
  assert.deepEqual((await fixture.readState()).releases, []);

  await fixture.updateState({ pushMode: "normal" });
  const resumedResult = await fixture.runCli("resume", "--plan", plan.plan, "--approve", plan.approvalId);
  const resumed = assertCliSuccess(resumedResult, "resume");
  assert.equal(resumed.finalSha, finalSha);
  const evidence = await assertAnnotatedPublication(fixture, {
    tag: "v0.3.0",
    finalSha,
    notes: approvedNotes,
  });
  assert.equal(evidence.state.releaseCreateCalls, 1);
});

test("resume recognizes a release created before its API acknowledgement was lost", async (t) => {
  const fixture = await createReleaseFixture({ service: { createMode: "uncertain-after-success" } });
  t.after(fixture.cleanup);
  const { plan, notes } = await preparePlan(fixture, "0.3.0");
  const approvedNotes = await readFile(notes, "utf8");

  const interrupted = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(interrupted, "RELEASE_CREATE_UNCERTAIN");
  const afterInterruption = await fixture.readState();
  assert.equal(afterInterruption.releaseCreateCalls, 1);
  assert.equal(afterInterruption.releases.length, 1);

  await fixture.updateState({ createMode: "normal" });
  const resumedResult = await fixture.runCli("resume", "--plan", plan.plan, "--approve", plan.approvalId);
  const resumed = assertCliSuccess(resumedResult, "resume");
  const evidence = await assertAnnotatedPublication(fixture, {
    tag: "v0.3.0",
    finalSha: resumed.finalSha,
    notes: approvedNotes,
  });
  assert.equal(evidence.state.releaseCreateCalls, 1);
});

test("resume refuses a corrupted notes path and preserves the sibling sentinel", async (t) => {
  const fixture = await createReleaseFixture({ service: { createMode: "uncertain-after-success" } });
  t.after(fixture.cleanup);
  const { plan } = await preparePlan(fixture, "0.3.0");
  const interrupted = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(interrupted, "RELEASE_CREATE_UNCERTAIN");

  const journalPath = join(dirname(plan.plan), "journal.json");
  const sentinelPath = join(dirname(plan.plan), "do-not-delete.txt");
  const sentinel = "sentinel content must survive recovery\n";
  await writeFile(sentinelPath, sentinel);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.notesPath = sentinelPath;
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

  await fixture.updateState({ createMode: "normal" });
  const rejected = await fixture.runCli("resume", "--plan", plan.plan, "--approve", plan.approvalId);
  assertCliFailure(rejected, "RELEASE_RESUME_JOURNAL_MISMATCH");
  assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
  const state = await fixture.readState();
  assert.equal(state.releaseCreateCalls, 1);
  assert.equal(state.releases.length, 1);
});

test("resume refuses conflicting and partial remote ref states without repairing them", async (t) => {
  await t.test("conflicting annotated tag", async (t) => {
    const fixture = await createReleaseFixture({ service: { pushMode: "fail-before" } });
    t.after(fixture.cleanup);
    const { plan } = await preparePlan(fixture, "0.3.0");
    const interrupted = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
    assertCliFailure(interrupted, "RELEASE_PUSH_UNCERTAIN");
    const localFinalSha = await fixture.git("rev-parse", "HEAD");
    const conflictingSha = await fixture.setConflictingRemoteTag("v0.3.0", fixture.initialSha);
    assert.notEqual(conflictingSha, localFinalSha);

    await fixture.updateState({ pushMode: "normal" });
    const rejected = await fixture.runCli("resume", "--plan", plan.plan, "--approve", plan.approvalId);
    assertCliFailure(rejected, "RELEASE_REMOTE_STATE_CONFLICT");
    assert.equal(await fixture.remoteGit("rev-parse", "refs/tags/v0.3.0^{}"), conflictingSha);
    assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), fixture.sourceSha);
    assert.deepEqual((await fixture.readState()).releases, []);
  });

  await t.test("branch advanced without the approved tag", async (t) => {
    const fixture = await createReleaseFixture({ service: { pushMode: "fail-before" } });
    t.after(fixture.cleanup);
    const { plan } = await preparePlan(fixture, "0.3.0");
    const interrupted = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
    assertCliFailure(interrupted, "RELEASE_PUSH_UNCERTAIN");
    const localFinalSha = await fixture.git("rev-parse", "HEAD");
    await fixture.git("push", fixture.remote, "HEAD:refs/heads/master");

    await fixture.updateState({ pushMode: "normal" });
    const rejected = await fixture.runCli("resume", "--plan", plan.plan, "--approve", plan.approvalId);
    assertCliFailure(rejected, "RELEASE_REMOTE_STATE_CONFLICT");
    assert.equal(await fixture.remoteGit("rev-parse", "refs/heads/master"), localFinalSha);
    const remoteTag = await fixture.refState("v0.3.0");
    assert.equal(remoteTag.remoteTag, null);
    assert.deepEqual((await fixture.readState()).releases, []);
  });
});

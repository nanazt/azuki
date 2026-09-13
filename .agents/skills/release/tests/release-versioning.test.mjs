import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertAnnotatedPublication,
  assertCliFailure,
  assertCliSuccess,
  createReleaseFixture,
  preparePlan,
} from "./helpers.mjs";

test("inspect selects the highest reachable release by SemVer rather than tag spelling", async (t) => {
  const fixture = await createReleaseFixture({
    workspaceVersion: "0.10.0",
    baselineVersions: ["0.9.0", "0.10.0"],
  });
  t.after(fixture.cleanup);

  const result = await fixture.runCli("inspect");
  const inspection = assertCliSuccess(result, "inspect");
  assert.equal(inspection.baseline?.tag, "v0.10.0");
  assert.equal(inspection.baseline?.version, "0.10.0");
  assert.equal(inspection.sourceSha, fixture.sourceSha);
  assert.ok(inspection.changeCount > 0);
});

test("plan applies strict SemVer syntax, precedence, baseline, and tag uniqueness", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(fixture.cleanup);
  const inspectionResult = await fixture.runCli("inspect");
  const inspection = assertCliSuccess(inspectionResult, "inspect");

  for (const [version, code] of [
    ["v0.3.0", "invalid_version"],
    ["0.2.0", "version_order"],
    ["0.1.0", "version_order"],
  ]) {
    const notes = await fixture.writeNotes(version);
    const result = await fixture.runCli("plan", "--inspection", inspection.inspection, "--version", version, "--notes", notes);
    assertCliFailure(result, code);
  }

  const acceptedVersion = "0.3.0-beta.2+build.7";
  const notes = await fixture.writeNotes(acceptedVersion);
  const acceptedResult = await fixture.runCli("plan", "--inspection", inspection.inspection, "--version", acceptedVersion, "--notes", notes);
  const accepted = assertCliSuccess(acceptedResult, "plan");
  assert.equal(accepted.version, acceptedVersion);
  assert.equal(accepted.tag, `v${acceptedVersion}`);
});

test("an exact candidate already present in the GitHub API cannot be planned", async (t) => {
  const existing = {
    id: 91,
    tag: "v0.3.0",
    name: "v0.3.0",
    prerelease: false,
    url: "https://github.test/nanazt/azuki/releases/tag/v0.3.0",
    body: "# v0.3.0\n\n## Added\n\n- Existing publication.\n",
  };
  const fixture = await createReleaseFixture({ service: { releases: [existing] } });
  t.after(fixture.cleanup);
  const inspectionResult = await fixture.runCli("inspect");
  const inspection = assertCliSuccess(inspectionResult, "inspect");
  const notes = await fixture.writeNotes("0.3.0");

  const rejected = await fixture.runCli("plan", "--inspection", inspection.inspection, "--version", "0.3.0", "--notes", notes);
  assertCliFailure(rejected, "version_exists");
  assert.equal((await fixture.refState("v0.3.0")).releases.some((release) => release.tag === "v0.3.0"), true);
});

test("a true first release can publish the existing workspace version without an empty commit", async (t) => {
  const fixture = await createReleaseFixture({ workspaceVersion: "0.2.0", baselineVersions: [] });
  t.after(fixture.cleanup);
  const before = await fixture.refState("v0.2.0");
  const { inspection, plan, notes } = await preparePlan(fixture, "0.2.0");
  assert.equal(inspection.baseline, null);
  assert.ok(inspection.changeCount >= 1);

  const result = await fixture.runCli("publish", "--plan", plan.plan, "--approve", plan.approvalId);
  const published = assertCliSuccess(result, "publish");
  assert.equal(published.finalSha, fixture.sourceSha);
  const after = await fixture.refState("v0.2.0");
  assert.equal(after.commits, before.commits);
  assert.equal(after.head, fixture.sourceSha);
  await assertAnnotatedPublication(fixture, {
    tag: "v0.2.0",
    finalSha: fixture.sourceSha,
    notes: await readFile(notes, "utf8"),
  });
});

test("release history with no reachable release tag is not treated as a first release", async (t) => {
  const fixture = await createReleaseFixture({ baselineVersions: [], unreachableRelease: true });
  t.after(fixture.cleanup);
  const before = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("inspect");
  assertCliFailure(rejected, "unreachable_baseline");
  assert.deepEqual(await fixture.refState("v0.3.0"), before);
});

test("a baseline with no commits after it is rejected as an empty release", async (t) => {
  const fixture = await createReleaseFixture({ releaseChange: false });
  t.after(fixture.cleanup);
  const before = await fixture.refState("v0.3.0");

  const rejected = await fixture.runCli("inspect");
  assertCliFailure(rejected, "INSPECTION_EMPTY");
  assert.deepEqual(await fixture.refState("v0.3.0"), before);
});

---
name: release
description: Safely orchestrate an explicitly approved azuki GitHub release, including version selection, release notes, tag publication, workflow evidence, and recovery from an interrupted release.
disable-model-invocation: true
---

# azuki release

Use this skill only when the user explicitly requests a release.
Reading, reviewing, or editing this skill is not release authorization.
A user naming a version starts version selection, not publication authorization.

Release target: `github.com/nanazt/azuki`.
The Git SSH remote is `origin` with URL `github-nanaz:nanazt/azuki.git` and branch `master` tracks `origin/master`.
The SSH identity used to push is separate from the GitHub API identity.
Every GitHub CLI command in this procedure MUST use `mise run gh-nanazt -- ...`.
That wrapper obtains the `nanazt` credential for `github.com`, removes inherited GitHub token/debug variables, and supplies its process-local token to `gh`.
Never print or persist the token, expose it to unrelated tasks, or send it to Actions.

## Normal path: inspect → plan → publish

Use three script invocations for the normal path and one explicit approval of the complete publication scope.
Do not expand machine checks into a separate tool call or task for every assertion.
The dependency-free Node CLI owns mechanical validation, version changes, checks, publication, and evidence collection; the agent owns semantic review, the version recommendation, English notes, and human approval.
Run commands from the repository root through `mise run release -- ...`.
`mise run release -- --help` describes the interface without repository or network work.

### 1. Inspect and review

Run `mise run release -- inspect`.
The command requires a clean `master` tracking `origin/master`, checks the effective fetch/push destinations and Git/SSH/API identities, fetches tags, checks upstream ancestry, and pins the source SHA.
It orders valid reachable release tags by SemVer 2 precedence, ignores build metadata for ordering, and rejects missing or ambiguous baselines and empty releases.
A true first release has no valid release tags anywhere and no GitHub releases; its review includes the root commit and entire reachable history.

Read the returned full commit-body artifact, complete diff, file inventory, and changed documentation at the pinned source SHA.
Inspect every `BREAKING CHANGE` footer or body section and the actual user-visible changes; scripts cannot perform this semantic review.
Recommend a SemVer version without a leading `v`, greater than the workspace version and baseline; only a true first release may equal the workspace version.
Do not require a 1.0.0 major bump merely because a `0.x` release is breaking.
There is no separate version approval checkpoint.

Draft English versioned notes with `Added`, `Fixed`, and `Improved` sections when applicable.
Include `Breaking Changes` and actionable `Upgrade Notes` when the inspected changes require them, and link relevant repository documentation.
Write the draft under the private inspection artifact directory returned by the command, outside the working tree.
Do not cache release-specific notes in this skill.

### 2. Plan and obtain one approval

Run `mise run release -- plan --inspection <inspection-path> --version <version> --notes <draft-path>`.
The command rechecks the pinned source, release context, version order, uniqueness, and evidence integrity, then saves an immutable snapshot of the exact notes and publication scope.
Heading validation is structural; it does not establish the accuracy or completeness of the notes.

Show the baseline, reviewed changes, version rationale, inspected source SHA, target repository and branch, proposed version, and the exact notes returned by `plan`.
Explain the existing Docker publication consequences: pushing `vVERSION` matches `v*`, runs `docker.yml`, evaluates the existing SemVer image-tag templates, and updates unconditional `latest` even for prereleases.
Do not promise a separate prerelease channel or deployment.
Ask for one explicit approval of this complete publication scope.
If the user changes the version or notes, create a new plan and obtain approval of its exact returned scope.

An explicit release request or version selection, a plan file, an approval digest, and passing checks are not publication approval.
Do not run `publish`, edit versions, commit, tag, push, or create a release before the user approves the exact plan.
The digest binds the selected plan; it does not prove that a human approved it.

### 3. Publish once and report evidence

After explicit approval, run `mise run release -- publish --plan <plan-path> --approve <approvalId>` as one supervised long-running command.
Wait for that invocation; do not launch another publisher or run competing validation against its changing checkout.
Progress is concise JSON on stderr, the final result is JSON on stdout, and full check/workflow logs remain in the private plan directory.

The publisher rechecks the approved clean source and identities, changes only `[workspace.package].version`, runs `cargo update --workspace`, and rejects dependency or unrelated lockfile changes.
It runs `mise run check`, `mise run test`, then frontend `npx tsc --noEmit` and `npm run build`.
It commits only the exact version changes as `chore(release): prepare vVERSION`; an equal-version true first release makes no empty commit.
It verifies the approved source-parent relationship, refreshes release context, rejects competing Docker publications, creates one annotated tag, and atomically pushes only `master` and that tag.
It waits for the exact `docker.yml` push run matching both tag and final SHA, requires completed success, then creates and verifies the GitHub release with the exact approved notes and correct prerelease flag.
It never forces, resets, deletes refs, retags, reruns workflows, or overwrites releases.

Report success only from a successful final result, including version, final SHA, release URL, and workflow URL.
The publisher removes temporary publication notes only after final verification and retains the sealed plan and journal.
On failure, report the command's error, journal/log paths, and observed publication state; do not fix source code, broaden the release diff, or improvise another publication command.
For an interrupted invocation or explicit resume request, read [RECOVERY.md](RECOVERY.md) before proceeding.

## Maintainer verification

Run `mise run test-release` after changing the automation.
The suite exercises the real CLI with isolated Git repositories and bare remotes, substituting only external transport, GitHub, and build services.
It must never publish to the real repository as a test.
Keep `workflows/docker.ts` and its generated YAML unchanged when optimizing this skill.

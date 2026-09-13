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

## Inspect and select the version

A fresh release starts only from a clean repository: staged, unstaged, and untracked state must all be empty.
Confirm the checkout is this repository, `origin` has the exact SSH URL above, `HEAD` is on `master`, and its configured upstream is `origin/master`.
Inspect the effective fetch and push URLs, including `pushurl` and URL rewrites, with `git remote get-url --all origin` and `git remote get-url --push --all origin`.
Require exactly one effective push destination matching the approved SSH URL; a correct fetch URL does not authorize a different push destination.
Confirm a Git commit identity is configured, and independently verify the effective SSH transport authenticates to GitHub as `nanazt`.
For the configured alias, an SSH authentication probe such as `ssh -T github-nanaz` must name `nanazt`; account for any Git SSH overrides rather than testing a different transport.
GitHub's successful no-shell greeting can exit with status 1, so inspect the greeting rather than treating that status alone as failure.
Confirm the API identity with `mise run gh-nanazt -- api --hostname github.com user --jq .login` and require exactly `nanazt`.
Stop and report any mismatch.

Fetch `origin` with tags and inspect the relevant remote branch and tag refs before choosing a version.
Require the fetched upstream to be an ancestor of local `HEAD`; stop on a behind or diverged checkout rather than merging or rebasing during a release.
Record this inspected `HEAD` as the source SHA before reviewing changes.
Consider only valid `v<SemVer 2>` release tags whose peeled commits are reachable from `HEAD`.
Order versions by SemVer precedence while ignoring build metadata, not lexicographically.
Choose the highest such tag as the release baseline.
A true first release has no valid release tags locally or remotely and no existing GitHub releases.
Its review range is the entire reachable history through `HEAD`, never `root..HEAD`.
If release history exists but no release tag is reachable, stop and resolve the baseline rather than calling it a first release.
For every other release, inspect the commits after the baseline.
Read commit subjects and bodies, the relevant diff, and changed documentation, including every `BREAKING CHANGE` footer or body section.
Reject an empty release or a requested version with no new release content.

Validate the candidate as SemVer 2 without its leading `v`.
Require the candidate to be greater than `[workspace.package].version`, except a true first release may equal that version.
When a baseline exists, also require strictly greater SemVer precedence than that baseline.
Do not require a 1.0.0 major bump merely because a `0.x` release is breaking.
Reject the candidate if its exact `vVERSION` tag exists locally or remotely, or if a GitHub release already exists for it.

Present the baseline, inspected source SHA and changes, proposed version, and the version/order rationale.
Ask for an explicit first checkpoint: confirmation or selection of the version.
Do not edit, commit, tag, push, create a release, or otherwise mutate release state before that confirmation.
If the user chooses a different version, repeat version ordering and tag/release uniqueness checks before drafting final notes.

## Draft notes and obtain publication approval

From the inspected changes, draft English release notes with `Added`, `Fixed`, and `Improved` sections when applicable.
Add `Breaking Changes` and actionable `Upgrade Notes` when the inspection found them.
Link to the relevant repository documentation or changed documents when it helps the reader.
Do not turn this skill into a cache of this release's auth changelog or other release-specific notes.

Show the exact versioned notes and explain the publication consequence of the existing `docker.yml` trigger: pushing `vVERSION` matches `v*` and runs the Docker publication workflow.
Its raw `latest` tag is unconditional, so it will be updated even for a prerelease tag.
The workflow also evaluates its existing SemVer tag templates; do not promise or invent a distinct prerelease channel.
Show the inspected source SHA, target repository, branch, version, and exact notes together, and ask for a separate, explicit final approval of that publication scope.

## Publish the approved release

After final approval, require `HEAD` to still equal the inspected source SHA and the checkout to still be clean.
If either changed, stop and refresh the affected review and approvals instead of silently releasing different content.
Edit only `[workspace.package].version` in the workspace `Cargo.toml` to the approved version, then run `cargo update --workspace`.
Inspect the lockfile diff and allow only version changes for intended local workspace packages.
If the lockfile changes dependencies or unrelated packages, stop and report rather than broadening the release diff.

Run the current repository checks after the version edit: `mise run check`, `mise run test`, then `cd frontend && npx tsc --noEmit && npm run build`.
On any failure, stop and report it; do not make unapproved source fixes.
Confirm the release diff contains only the intended `Cargo.toml` and `Cargo.lock` version changes.
Commit only those files with the Conventional Commit message `chore(release): prepare vVERSION`.
For a true first release whose workspace version already equals the approved version, make no empty version commit and tag the approved source commit.
Before tagging, verify the release commit is exactly the approved source commit plus the reviewed version-only commit, or the unchanged source commit for the first-release exception.
Record that expected final release SHA for publication checks and any interrupted-release recovery.
Require a clean checkout and preserve the approved repository, branch, and notes throughout publication.

Immediately before tagging, refresh the remote branch, release tags, and GitHub release state.
Require the candidate to remain above the refreshed baseline and its exact tag/release to remain absent; if the reviewed release context changed, stop and refresh the affected approval rather than publishing stale notes.
Stop if another tag-triggered Docker publication is in progress rather than racing its `latest` update.
Then create exactly one annotated `vVERSION` tag at the verified final release commit.
Recheck the effective push destination against the approved URL immediately before pushing.
Push only the approved branch and that tag atomically: `git push --atomic origin HEAD:refs/heads/master refs/tags/vVERSION`.
Never use `git push --tags`, force push, delete a ref, reset, retag, or publish another branch.
Confirm from `origin` that both `master` and the peeled `vVERSION` tag resolve to the final release SHA.

Wait for the exact `docker.yml` `push` workflow run created for that tag and final SHA.
Select no run merely because it is recent: verify both the tag and commit SHA, wait only a bounded period for it to appear, then watch that exact run with a failure exit status.
Require a completed `success` conclusion.
If it does not appear, is cancelled, fails, or remains unresolved after the bounded wait, stop and report its URL and state.

Write the approved notes to a temporary file outside the repository.
Create the release only after the successful workflow with `mise run gh-nanazt -- release create vVERSION --repo github.com/nanazt/azuki --verify-tag --title vVERSION --notes-file <temporary-file>`.
Add `--prerelease` exactly when the approved SemVer version has a prerelease identifier.
Verify the created GitHub release, its exact tag, the remote peeled tag and branch SHAs, and the successful matching workflow run.
Report the version, final SHA, release URL, and workflow URL as completion evidence.
Remove the temporary notes file after successful verification.
If publication is interrupted, preserve the approved notes securely until recovery is complete.

## Interrupted-release recovery

Treat a dirty checkout as a hard stop for a fresh release.
Use recovery only for the same authorized in-progress release, either during its current invocation or when the user explicitly asks to resume it.
Do not discard its local artifacts or assume whether a push or API call succeeded.
First inspect the remote branch, exact tag, exact GitHub release, and matching workflow state through the wrapper.
Compare published refs and the matching workflow to the recorded final release SHA, not to the pre-version-bump source SHA.
Verify the version-only release commit's parent is the approved source SHA, or that final and source SHAs are equal for the unchanged first-release exception.
Compare the version and release notes with the previously approved content before resuming.
Resume only the failed stage after those facts match the approved release scope.
If the outcome is uncertain or differs, preserve the artifacts, stop, and report the evidence and the required human decision.
Never automatically reset, delete, force-push, retag, or recreate a release.

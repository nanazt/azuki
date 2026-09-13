# Interrupted-release recovery

Read this reference only after a failed or interrupted `publish`, or when the user explicitly asks to resume the same authorized release.
A fresh dirty checkout is still a hard stop; recovery is not permission to release unrelated edits.

## Establish the same approved release

Use the original sealed `plan.json`, its approval ID, and sibling `journal.json` under the Git common directory's `azuki-release/` state directory.
Preserve the approved notes, journal, local artifacts, and detailed logs until publication is resolved.
Do not reconstruct an approval from a filename, tag, digest, successful check, or journal stage.
The original explicit approval must cover this exact source SHA, version, notes, repository, branch, and publication consequences.
If that approval is unavailable, ask for the missing approval rather than assuming it.

Read the failed command's structured error and relevant log before resuming.
Do not assume that a failed transport response means a commit, tag, push, or GitHub API write did not succeed.
Compare publication evidence with the recorded final release SHA, not the pre-version source SHA.
The final SHA must be the source plus its exact version-only child commit, or the source itself for the equal-version true first release.

## Resume once

When recovery remains within the same authorized invocation, or the user explicitly requests that recovery, run:

```sh
mise run release -- resume --plan <original-plan-path> --approve <original-approvalId>
```

Run it as one supervised invocation and wait for that process.
The publisher reconciles the journal with actual local commits, working-tree contents, annotated tag, remote branch and peeled tag, exact GitHub release, and matching workflow before continuing a failed stage.
Only the expected version-only dirty state belonging to this plan is eligible for automatic recovery.
If a commit, tag, push, or release intention was recorded but its outcome cannot be verified, resume stops as ambiguous even when the expected ref or release is absent.
Absence does not prove that the operation never succeeded or authorize recreating something another actor removed.
A lock owned by a live process, another host, or an unverifiable owner is a stop, not a reason to launch another publisher.
Explicit resume can reclaim a verified dead same-host publication lock; an interrupted lock-recovery claim requires manual investigation rather than speculative deletion.

| Observed state | Permitted automatic continuation |
| --- | --- |
| Expected version edit or version-only commit exists | Verify it against the approved source and journal, then continue required validation or publication. |
| Intended annotated tag exists locally; remote refs remain at the approved pre-push state; no push intention was recorded | Verify the tag and current publication context, then attempt the exact atomic push. |
| Atomic push succeeded but its response was lost | Verify both remote refs at the recorded final SHA, then locate the exact workflow without pushing again. |
| Exact workflow is pending | Continue the bounded wait for that run only. |
| Release creation succeeded but its response was lost | Verify exact tag, title, notes, prerelease state, refs, and successful workflow; do not create or overwrite it again. |
| Publication was fully verified | Reverify the published evidence and report completion without creating anything again. |

Workflow appearance is bounded to 120 seconds, polled every 5 seconds.
An exact run is watched for at most 1,800 seconds and must finish with `success`; being recent, having the same branch, or a successful watch exit alone is insufficient evidence.
GitHub CLI operations still use only `mise run gh-nanazt -- ...`.

## Stop instead of repairing scope

Stop on changed source or notes, unexpected working-tree content, dependency drift, failed checks, changed release context, partial/conflicting refs, an unapproved existing release, or missing/corrupt plan or journal evidence.
A failed, cancelled, missing, or unresolved workflow does not authorize a GitHub release or an automatic workflow rerun.
Report the observed state, affected source/final SHAs, error code, artifact/log paths, and any known release or workflow URL.
Name the required human decision without prescribing a destructive repair.

Never automatically reset, discard edits, delete a ref, force-push, retag, rerun a workflow, broaden the release diff, change the notes, or recreate/overwrite a release.
Do not silently replace the approved plan with a newly inspected one to bypass a stale-context guard.
If new release content, notes, or publication scope is required, stop this recovery and return to review and explicit approval of that changed scope.

After successful final verification, report the version, final SHA, release URL, and workflow URL.
The temporary publication notes are removed on success; the sealed plan and journal remain as recovery evidence.

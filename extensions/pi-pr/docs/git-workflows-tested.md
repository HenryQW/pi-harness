# Git workflow consolidation checks

## Candidate and scope

The candidate includes checkpoints `36008cb0c6fabf94e7d8ddee3c2b302c8fffd121` and `8506d67ce276138b213ab42637cb6afae9eb2322`, applied in that order, then the completion changes. This report covers checks run in `/Users/henry/Git/pi-harness/.worktrees/subagent-46a5a4b61cc1fd6e8b66ea3a`.

- `pi_git_commit` is the standalone local entry. Creation, local publication, and feedback commits share literal-path staging and parent/tree checks. CI guidance uses the standalone commit entry with the captured PR head as its target.
- `git-pr` now calls `pi_git_pr`, not a second shell workflow or a request to run `/pr`. Its authorization permits creation, local publication, and sync onto the PR head. It excludes feedback, CI repair, base rebase, CI waiting, and merge. `/pr` retains its full lifecycle.
- `update-from-main` remains a standalone merge of the exact fetched OID. Recovery keeps backups. The original `/Users/henry/Git/skills` sources stayed read-only during isolated validation. Source retirement is a separate step after Main acceptance.
- The package manifest publishes all eight skills and their helpers. The root local manifest also declares the same skill directory. `@henryqw/pi-pr` moves from `9.0.3` to `9.1.0` for the new callable workflows and skills. No other package needs a release.

## Executed cases

| Check | Actual coverage |
| --- | --- |
| `git-commit.test.ts` | Real temporary Git repositories: local-only commits, coherent groups, literal filenames, message bodies, remaining unrelated work, coherent staged renames/deletions, unrelated staging, partial staging, same-status byte drift, branch movement, active Git operations, context/secret paths, cancellation, failed hooks, lost successful responses, and hooks that change the committed tree. Uncertain attempts cannot replay. |
| Creation and local-publication tests | Shared byte/index inspection and staging, rename scope, clean verification, exact captured OID and lease, frozen checks, failed checks, divergent local commits, and consumed uncertain commits/pushes. Creation tests also cover explicit base match/mismatch, PR reuse, upstream recovery, and title/body races. Git mutation cases use temporary repositories or strict command mocks; GitHub responses are controlled. |
| Feedback sweep tests | Real temporary Git repositories with controlled GitHub responses: scope and authority checks, preserved partial staging, literal add/delete paths, exact parent/tree recovery, and lost-response reconciliation. Existing recovery, feedback, validation, and resolution tests remain active. |
| `pr-native.test.ts` | Native `AgentSession`, `ExtensionRunner`, and settlement methods: hidden skill dispatch, no editable queue guidance, full-lifecycle continuation, bounded create/publication handoff without UI, and no unauthorized feedback continuation. Workflow bodies and GitHub discovery are controlled in these tests. |
| `native source Git tools` in `pr.test.ts` | Registered source tools with real commit/publication helpers in a temporary repository. Standalone commit does not push; explicit base mismatch stops; active PR authority blocks a second commit entry; native settlement supplies the package skill; validation and exact-lease/OID publication write only a local bare repository; a merge-ready PR is not merged. GitHub discovery and repository identity are controlled responses, not live API reads. |
| Merge helper self-test | Real temporary repositories: a merge with staged/untracked restoration, tracked stash conflict, untracked and ignored upstream-path collisions, ignored newline filenames, merge-conflict recovery using the captured OID after upstream advances, retained-backup rerun rejection, fetch failure before local mutation, tracking-ref movement after fetch, up-to-date/main/detached refusal, dirty submodule restoration, required submodule update recovery, and failed merge-hook recovery. Only fetch lock-race responses and tracking-ref movement are injected. |
| Installed Pi resource probe | Pi `1.0.2` `DefaultPackageManager.resolveExtensionSources` and `loadSkills` resolve the package and root local manifests. Both return the extension entry and all eight skills, with no skill diagnostics. The probe uses in-memory settings and a temporary agent directory; it does not load models or write user configuration. |

## Fixes and check history

The checkpoint baseline passed 426 package tests, the feedback self-test, and the copied Python validator. This worker did not rely on the prior worker's reported 129 focused tests.

The source commit tool did not trigger the documented presentation refresh: the event handler recognized only shell commits. It now refreshes after a successful `pi_git_commit` commit, but not inspection or failure. The existing projection test covers this boundary.

A real Git probe also found that `git add -A -- old.txt new.txt` fails with exit 128 after a staged rename: the old path is already absent from the index. The shared staging helper now leaves fully staged paths unchanged and adds only unstaged/untracked selected paths. It still rejects unrelated and partially staged work first. Real cases cover complete staged renames in standalone, creation, and publication commits, plus staged deletion in standalone and sweep commits.

Added cases also establish same-status byte-drift rejection in both PR inspection callers, partial-stage preservation in the sweep, untracked collision backup preservation in the merge helper, and a registered-tool commit/publication exercise. No merge algorithm or PR lease/recovery path was replaced.

During development, typecheck rejected an unsafe test-only boundary-entry access. The test now checks the entry before reading its content. The first source-tool probe expected the wrong no-action notification text; that redundant assertion was removed. These were test defects, not successful workflow claims. The four focused Git cases then passed.

Checks on the previous candidate `6a4d39d`, before the independent review corrections (these are not revision rerun results):

| Command | Result |
| --- | --- |
| `pnpm --filter @henryqw/pi-pr test` | Exit 0: 428 Node tests, feedback self-test, and merge helper self-test passed. |
| `pnpm --filter @henryqw/pi-pr typecheck` | Exit 0. |
| `python3 extensions/pi-pr/skills/update-from-main/scripts/validate.py` | Exit 0 on the checkpoint baseline; the final expanded helper also passed through the package test command. |
| `pnpm run docs:validate` | Exit 0: README structure, 49 docs-related tests, and link checks passed. |
| `pnpm run check:package-versions` | Exit 0. |
| `pnpm install --lockfile-only --offline --ignore-scripts` | Exit 0; version/resource edits need no dependency resolution change, so `pnpm-lock.yaml` is unchanged. |
| `cd extensions/pi-pr && npm pack --dry-run --ignore-scripts --json` | Exit 0: 35 published files at `9.1.0`; an assertion probe confirmed all eight skills, source entry, shared commit helper, both Python scripts, report, and README SVG. No tarball was created. |
| `git diff --check` | Exit 0. |

Output was captured in temporary logs. Success summaries were limited to 20 lines; failure output was limited to 80 lines or 8 KiB. The installed-authority resource probe ran with `node --input-type=module` and imported `DefaultPackageManager`, `SettingsManager`, and `loadSkills` directly from the Pi `1.0.2` path given below.

## Independent evidence on the previous candidate

The parent supplied the following exact-source acceptance results for the previous tree. This worker has not rerun these independent probes on the revision or inspected raw worker sessions.

- First agent: 22 passing tests, including five registered-source guidance probes. These used real local commits, native handoff, checks, and local exact-OID/lease pushes. Commands and saved logs are under `/tmp/pi-git-acceptance-c2e9d284.Y5SPGS`. Its collector rejected valid final ancestry across a custom record; the cases and unchanged identity were recovered from saved evidence. The collector failure is not proof that the native workflow failed.
- Second agent: four successful subprocess fixtures. Safe evidence is `/tmp/pi-update-main-acceptance.ZXSHb1/report.txt` and `probe-results.json`: partial-index/untracked byte restoration; ignored upstream collision backup; conflict recovery using the original OID after main advanced, with retained-backup rerun refusal; and fetch failure preserving all state. `acceptance.py` exited 1 after the first two cases because macOS `sed` rejected `--`. `resume.py` inspected and continued the same fixture and returned 0; it did not restart or rerun an uncertain merge.
- The old success result that popped the backup is invalid under the corrected retention policy. These prior fixtures do not prove the new concurrent-stash behavior.
- The second task overall FAILED because its environment probe disclosed a credential, despite its passing Git fixtures. The parent notified the user. No token value is in the safe reports or fixtures. This revision does not inspect or reproduce credential output and does not change pi-subagent.

## Review corrections and revision evidence

1. The merge helper no longer captures `refs/stash` after push or checks it before `pop stash@{0}`. Native stash pushes use a unique run message; the helper finds its OID in the native stash reflog. Restoration always uses `git stash apply --index <captured-OID>`. Every backup stays retained after success or failure until verified explicit user removal. Legacy named backups still block another run. Exact fetched-main OID and merge/conflict/hook/submodule recovery are unchanged.
2. The registered bounded entry passes `preserveExistingMetadata` into the shared creator. An exact-head PR that appears after push is validated for open lifecycle, repository/ref/OID, and base, then reused without edit/create. Full `/pr` keeps its metadata-update behavior. Controlled regressions exercise bounded reuse, full metadata update, and rejection of a different base or head. The entry-boundary test checks that bounded authority reaches the creator.
3. The package now declares `(MIT AND Apache-2.0)`. `LICENSE` still applies to existing MIT code. `LICENSE-APACHE-2.0` is byte-for-byte equal to the read-only original `/Users/henry/Git/skills/LICENSE`. `NOTICE.md` identifies source commit `6857c81611ab8e7aaacf4233452a0841d7df79a9`, lists the imported paths and modifications, and scopes Apache versus MIT. Each imported skill/helper/validator has a source and modification notice. The source has no separate NOTICE file for these paths. Both licences and the notice are published.

The smallest real-Git race regressions use another linked worktree. One inserts its stash push after this helper's push but before backup capture. The other inserts its push immediately before restoration. Both verify partial-index and binary untracked bytes, the original backup OID, the peer backup's OID/content, and two retained stack entries. Legacy-backup refusal and successful-restoration rerun refusal are also checked. No automatic stack deletion is used.

Focused commands run on this revision:

- `python3 extensions/pi-pr/skills/update-from-main/scripts/validate.py`: exit 0, including both real-Git races and recovery checks.
- `pnpm --filter @henryqw/pi-pr exec node --test --test-name-pattern='metadata when an exact PR appears|agent PR entry carries base' test/pr-create.test.ts test/pr.test.ts`: initially three cases passed before adding the two mismatched-authority cases; the complete final package run below covers those added cases.

Final checks run on this revision:

| Command | Result and local log |
| --- | --- |
| `pnpm --filter @henryqw/pi-pr test` | Exit 0: 432 Node tests plus feedback and expanded merge self-tests. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.jXV17CCNcZ`. |
| `pnpm --filter @henryqw/pi-pr typecheck` | Exit 0. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.vtgSindNDY`. |
| `pnpm run docs:validate` | Exit 0: structure, 49 docs tests, and link checks. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.JW98lXOnhR`. |
| `pnpm install --lockfile-only --offline --ignore-scripts` | Exit 0; lockfile remains unchanged. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.BcSv0ViqC9`. |
| `pnpm run check:package-versions` | Exit 0. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.lTNTARDRvY`. |
| `cd extensions/pi-pr && npm pack --dry-run --ignore-scripts --json` | Exit 0; 37 files. Assertions verified both licences, NOTICE.md, all eight skills, Python helper/validator, source entries, report and SVG. The Apache licence equals the original bytes. No tarball was created. Log: `/var/folders/6y/58h3_t417xdb67x996096jjr0000gn/T/tmp.jYi8Xk2CQl`. |
| `git diff --check` | Exit 0. |

The release stays `@henryqw/pi-pr@9.1.0`; no other package releases. Main owns root-wide combined validation and final independent acceptance. These revision checks do not rerun the prior independent collectors or fixture scripts. Live GitHub, live models, TUI behavior, and manual backup removal remain untested.

## Main acceptance

Main accepted and promoted runtime candidate `62711f2643bd73c26d2fe29925e00c758c21df65`, with the same source tree as revision `274695fe84b7da903d998edc3b21d85c2b509651`.

- `pnpm --filter @henryqw/pi-pr test:git-workflows`: exit 0 on that exact integration candidate. Log: `/tmp/pi-pr-main-acceptance.zKbmC8`.
- Guarded final checks: `pnpm test`, `pnpm run docs:validate`, `pnpm run check:package-versions`, `git diff --check`, and `npm pack --dry-run --json` from `extensions/pi-pr` all returned exit 0. The runtime candidate stayed unchanged.
- The guarded exact-candidate review and the separate final reviewer both returned `PASS`.
- This section is a report-only update after promotion. It does not claim another model-driven package run, live GitHub write, or replay of the previous independent fixture scripts. Credential replacement and removal of installed standalone skill copies remain user actions.

## Independent acceptance entry

From the exact candidate checkout, with existing workspace dependencies and Python 3.9+ installed, run:

```bash
log=$(mktemp)
pnpm --filter @henryqw/pi-pr test:git-workflows >"$log" 2>&1
rc=$?
echo "git-workflows exit=$rc log=$log"
if [ "$rc" -eq 0 ]; then tail -20 "$log"; else tail -80 "$log" | tail -c 8192; fi
exit "$rc"
```

This entry uses the existing Node test runner and Python validator, not a new framework. It runs the standalone commit, native dispatch, real local publication, registered source-tool, and merge recovery exercises. Temporary repositories and agent directories are removed. Any unknown GitHub mutation in the source-tool exercise fails the test; the only push destination is its temporary bare repository. No credentials, external repository, model request, or persistent Pi setting is needed.

Main can give separate acceptance workers the source `extensions/pi-pr/extensions/pr.ts` and the packaged `skills/git-commit`, `skills/git-pr`, or `skills/update-from-main` guidance. Use only controlled temporary Git/GitHub contexts. Compare the resulting commits, index, backup OIDs, and native handoff with the cases above. Use returned inspection/run IDs, never fabricated authority. Run the helper once per fixture; inspect and restore retained backups rather than rerun. Main owns the independent agent-guidance exercise and source retirement after acceptance.

## Limits

- Automated native tests use the workspace-pinned Pi `1.0.0` dependency. The installed `1.0.2` authority is `/Users/henry/.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent`; its documentation and declarations were inspected, and its resource APIs were probed. Live model-driven use of the packaged tools and TUI behavior were not tested.
- Controlled GitHub responses test authorization and command boundaries. They do not prove live GitHub authentication, repository policy, network transport, or GitHub Enterprise behavior.
- A user request and upstream consent are agent guidance requirements; a Boolean tool field cannot prove that a person gave consent. Ownership, secret-content detection, check adequacy, and semantic conflict resolution still need agent/user judgment.
- The acceptance entry is available for later local runs. Main's exact-candidate acceptance and root-wide checks are recorded above. Package typecheck passed on the revision; no new claim is made for unchanged packages' typechecks.
- No live GitHub change, external push, npm publication, or persistent user configuration edit was made. Source retirement is permitted only after acceptance; installed standalone copies are not removed automatically.

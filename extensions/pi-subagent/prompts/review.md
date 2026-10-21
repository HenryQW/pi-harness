---
description: Review a change with parallel reviewer Subagents and give one ship verdict.
argument-hint: "[A..B | branch | commit | #PR] [focus]"
---

Review this target with parallel `reviewer` Subagents: $@

Do not edit files, fix findings, commit, or push.

1. Resolve the first argument to exact local commit IDs with Git. Treat the remaining text as extra review focus.
   - Empty: uncommitted staged, unstaged, and untracked changes against `HEAD`.
   - `A..B`: base `A`, tip `B`.
   - Branch: base is `git merge-base main <branch>`, tip is the branch.
   - Commit: base is its first parent, tip is the commit.
   - `#N`: run `gh pr view N --json baseRefName`, then `git fetch origin +refs/heads/<baseRefName>:refs/remotes/origin/<baseRefName> +pull/N/head:refs/review/pr-N`. Base is the merge-base of `origin/<baseRefName>` and `refs/review/pr-N`; tip is `refs/review/pr-N`. Reviewers read only local Git, so fetch before delegation.
   If the target is ambiguous or has no changes, stop and report.
2. List the changed files, and mark untracked files. Group them by locality: same directory or module, related behavior, and tests with their implementation. Use one group for a small change and at most 5 groups.
3. Start one `delegate_task` call with `mode: "direct"` and one `tasks` entry per group: `role: "reviewer"`, a short unique `name` (at most 29 characters), `access: "read"`, and a `task` that gives the base and tip commit IDs, its exact file list, and the criteria. For uncommitted changes, give `HEAD` <ID> instead, and tell the reviewer to combine `git_read` diff in `staged` and `working` modes and to read each marked untracked file whole with `read`. Criteria: report actionable correctness risks that the change introduces in these files, with the reviewer finding format; read other files only as context; output exactly `PASS` when there are no findings. Add the extra focus, if any.
4. When the result arrives, merge the findings: remove duplicates that share a root cause and keep the highest priority, then sort by priority (`P0`, `P1`, `P2`) and confidence. Keep file:line evidence and fixes.
5. Give one verdict. **Ship** only if every reviewer task succeeded and answered exactly `PASS`. Otherwise **Do not ship**, with the merged findings and any failed or incomplete reviewer task.

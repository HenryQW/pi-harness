# Pi PR

## Language

**Current-branch pull request**:
The GitHub pull request associated with the Pi session's current branch, if one exists.
_Avoid_: Repository PR list, PR dashboard

**PR footer status**:
One linked pull request number and one plain-language, priority-ordered state shown through Pi's extension status line. Priority favors action over passive lifecycle detail.
_Avoid_: PR summary, review dashboard, glyph stack

**PR state**:
`draft`, `open`, `approved`, `CI running`, `CI failed`, `changes requested`, `merge conflict`, `merged`, or `closed`.
_Avoid_: PR state badge

**PR creation fallback**:
`/pr` creates only when current branch has no open PR, worktree is clean, and `HEAD` pushes to `origin`. Creation uses `gh pr create --fill` with GitHub CLI default base; it never commits work.
_Avoid_: Automatic commit, hidden PR workflow

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

**PR creation workflow**:
When current branch has no open PR, `/pr` dispatches bundled `pi-pr-create` skill. Skill follows Git PR workflow: resolve base, scope and commit pending changes, validate, push, then create or update PR with derived title/body.
_Avoid_: Duplicated shell workflow, unscoped automatic commit

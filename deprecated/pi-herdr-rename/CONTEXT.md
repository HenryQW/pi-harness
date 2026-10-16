# Pi Herdr Rename (retired)

This archive records the former conversation-title context, now part of [Pi Herdr Tools](../../extensions/pi-herdr-tools/CONTEXT.md). These definitions describe its archived title and branch policy.

## Language

**Display title**:
A model-generated task phrase in sentence case, limited to four words and 20 characters. It labeled the Pi conversation and its Herdr pane and workspace, and the tab when the pane had no siblings.
_Avoid_: semantic title, session rename, terminal name

**Semantic branch**:
A Git-safe branch combining a task kind with display-title words. It replaced a detached or Herdr-generated branch, not an existing user-named branch.
_Avoid_: display title, raw generated branch, arbitrary Git mutation

**Generated worktree label**:
Herdr's default linked-worktree label, eligible for automatic replacement by the Display title. Replacement of a custom workspace label required an explicit rename.
_Avoid_: semantic branch, custom workspace name

**Sole-pane tab**:
A Herdr tab containing the current pane and no sibling panes, so its title could represent that conversation alone.
_Avoid_: single-pane session, empty tab

**Rename task profile**:
The shared Task Profile for the archived title Model Task `pi-herdr-rename/rename`, with `fast` as its default. No viable route left titles unchanged rather than substituting the current session model.
_Avoid_: package-owned rename model, active model

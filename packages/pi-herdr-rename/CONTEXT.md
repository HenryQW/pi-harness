# Pi Herdr Rename

Pi extension that gives each conversation one short task label across Pi and its Herdr terminal location.

## Language

**Chat title**:
Semantic model-generated task label in `type: subject` form, stored as Pi session display name and applied to current Herdr pane. It also labels enclosing tab when current pane has no siblings.
_Avoid_: session rename, terminal name

**Semantic branch**:
Git-safe branch derived from semantic chat title: `fix: extension name` becomes `fix/extension-name`. It replaces a detached checkout or Herdr-generated `worktree/...` branch; an existing non-generated branch wins.
_Avoid_: raw generated branch, arbitrary Git mutation

**Generated worktree label**:
Herdr linked-worktree label matching its `worktree-<adjective>-<noun>-<hex>` default. It is replaced with current semantic Git branch; custom workspace labels remain unchanged.
_Avoid_: chat title, custom workspace name

**Sole-pane tab**:
Herdr tab containing current pane and no sibling panes. Only this tab receives chat title because title cannot misrepresent another pane.
_Avoid_: single-pane session, empty tab

**Rename task profile**:
Shared task-model profile assigned to `pi-herdr-rename/rename` (default `fast`) with primary and optional fallback Pi registry routes. Rename never substitutes the current session model; no viable route leaves titles unchanged.
_Avoid_: package-owned rename model, active model

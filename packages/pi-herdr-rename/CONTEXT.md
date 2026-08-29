# Pi Herdr Rename

Pi extension that gives each conversation one short task label across Pi and its Herdr terminal location.

## Language

**Display title**:
Model-generated natural task phrase, sentence-cased and limited to four words and 20 characters. One display title labels Pi conversation and current Herdr pane and workspace. It also labels enclosing tab when current pane has no siblings.
_Avoid_: semantic title, session rename, terminal name

**Semantic branch**:
Git-safe branch combining task type with display-title words: `Update task logic` classified as `refactor` becomes `refactor/update-task-logic`. It replaces a detached checkout or Herdr-generated `worktree/...` branch; an existing non-generated branch wins.
_Avoid_: display title, raw generated branch, arbitrary Git mutation

**Generated worktree label**:
Herdr linked-worktree label matching its `worktree-<adjective>-<noun>-<hex>` default. It is replaced automatically with current display title; an explicit rename may also replace a custom workspace label.
_Avoid_: semantic branch, custom workspace name

**Sole-pane tab**:
Herdr tab containing current pane and no sibling panes. Only this tab receives display title because title cannot misrepresent another pane.
_Avoid_: single-pane session, empty tab

**Rename task profile**:
Consumer-owned Model Task `pi-herdr-rename/rename` defaults to `fast`; shared task-model config can explicitly override it and supplies primary and optional fallback Pi registry routes. Rename never substitutes the current session model; no viable route leaves titles unchanged.
_Avoid_: package-owned rename model, active model

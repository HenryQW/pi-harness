# Pi Herdr Rename

Pi extension that gives each conversation one short task label across Pi and its Herdr terminal location.

## Language

**Chat title**:
Short model-generated task label stored as Pi session display name and applied to current Herdr pane. It also labels enclosing tab when current pane has no siblings.
_Avoid_: session rename, terminal name

**Generated worktree label**:
Herdr linked-worktree label matching its `worktree-<adjective>-<noun>-<hex>` default. It is replaced with current non-generated Git branch; generated `worktree/...` and custom workspace labels remain unchanged.
_Avoid_: chat title, custom workspace name

**Sole-pane tab**:
Herdr tab containing current pane and no sibling panes. Only this tab receives chat title because title cannot misrepresent another pane.
_Avoid_: single-pane session, empty tab

**Rename model**:
User-selected Pi text model used only to generate chat titles, with built-in default until user selects another.
_Avoid_: title model, active model

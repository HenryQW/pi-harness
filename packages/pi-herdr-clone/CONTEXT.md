# Pi Herdr Clone

Pi extension that clones the current Pi conversation path into another Pi process in a new tab of the same live Herdr workspace.

## Language

**Active-path clone**:
Persisted Pi session containing exactly the root-to-current-leaf path from the original session. Sibling branches are excluded and the original session remains active.
_Avoid_: session fork, full session copy

**Clone tab**:
New Herdr tab whose root pane starts Pi with the active-path clone, then receives focus after successful agent start.
_Avoid_: worker tab, worktree tab

**Ambiguous launch**:
Failed Herdr agent-start attempt whose timeout may hide a successful process start. Clone tab and session are retained and identified for recovery.
_Avoid_: failed clone, cleanup failure

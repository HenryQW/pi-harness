# Pi Herdr Clone

Pi extension that clones the current Pi conversation path into another Pi process in a new tab or worktree workspace, and ends completed linked-worktree work through Herdr. Separate explicit extension entry points own cloning and `/done`; both use the shared `@henryqw/pi-herdr` worktree locks.

Version 2.1.0 absorbs the retired `@henryqw/pi-herdr-done` package without a compatibility wrapper. Remove old package installs and manual entry-point paths before upgrading to avoid duplicate `/done` registration; see the README migration steps.

## Language

**Active-path clone**:
Persisted Pi session containing exactly the root-to-current-leaf path from the original session. Sibling branches are excluded and the original session remains active.
_Avoid_: session fork, full session copy

**Clone tab**:
New Herdr tab whose root pane starts Pi with the active-path clone, then receives focus after successful agent start.
_Avoid_: worker tab, worktree tab

**Worktree clone**:
New Herdr Git worktree workspace (`herdr worktree create`) whose root pane starts Pi with the active-path clone inside the fresh checkout, then receives focus after successful agent start. If a worktree-layout plugin already started its own agent in the root pane, the clone starts in an additional tab of that workspace instead so both agents coexist. Branch and checkout path are chosen by Herdr.
_Avoid_: branch clone, repo copy

**Ambiguous launch**:
Tab-create response missing identity, or failed Herdr agent-start attempt whose timeout may hide a successful process start. Clone tab and session are retained and identified for recovery.
_Avoid_: failed clone, cleanup failure

**Worktree completion**:
Explicit end of a Pi task that removes its linked Git worktree checkout and closes every tab in its Herdr workspace. Dirty checkout removal or removal while another workspace uses the checkout requires explicit force. `/done` confirms before waiting for idle; `/done --force` skips confirmation and the cross-workspace usage check. Cleanup removes the checkout before closing sibling tabs, conditionally fast-forwards the non-bare primary checkout under its lock, and closes the current tab last even if sibling cleanup or the pull fails.
_Avoid_: workspace removal, Pi exit, implicit forced cleanup

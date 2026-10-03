# Pi Herdr Tools

Human-directed conversation workflows in Herdr: active-path clones, side questions, shared conversation titles, and explicit worktree completion.

## Language

**Active-path clone**:
Separate Pi session containing the original session's root-to-current-leaf conversation path, excluding sibling branches. The original session remains active.
_Avoid_: full session copy, session fork

**Clone tab**:
New tab in the current Herdr workspace containing an active-path clone with the same working directory.
_Avoid_: worker tab, worktree tab

**Worktree clone**:
Active-path clone in a fresh Herdr Git worktree workspace, using the new checkout as its working directory. It coexists with any agent already started by a worktree-layout plugin.
_Avoid_: branch clone, repo copy

**Ambiguous launch**:
Launch whose response cannot establish whether Herdr created or started the target. Its known resources are retained for inspection rather than treated as safe to delete.
_Avoid_: failed clone, cleanup failure

**Worktree completion**:
Explicit end of a task that removes its linked worktree checkout and closes its Herdr workspace tabs. Forced completion permits loss of uncommitted work and removal while other workspaces still use the checkout.
_Avoid_: Pi exit, implicit forced cleanup

**Main**:
Parent Pi session that owns side-thread launch and merge delivery.
_Avoid_: parent agent

**Side thread**:
Separate Pi process and Herdr pane opened for a bounded question, sharing Main's working directory.
_Avoid_: child agent

**Side-thread transcript**:
User/assistant text turns returned to Main, excluding tool payloads.
_Avoid_: full child context

**Merge request**:
One-way handoff of a side-thread transcript and follow-up prompt to Main. Main owns consumption; the side thread does not wait for acknowledgement.
_Avoid_: merge acknowledgement

**Display title**:
Model-generated English task phrase, sentence-cased and limited to four words and 20 characters, shared by the Pi conversation and its Herdr location.
_Avoid_: semantic title, raw generated branch

**Semantic branch**:
Git-safe branch combining task kind and display-title words. It replaces detached or Herdr-generated worktree branches, not existing non-generated branches.
_Avoid_: display title, arbitrary Git mutation

**Generated worktree label**:
Herdr's default linked-worktree name, eligible for automatic replacement by the display title. A custom workspace name changes only on explicit rename.
_Avoid_: semantic branch, custom workspace name

**Sole-pane tab**:
Tab containing the current pane and no siblings, whose label can represent the current conversation without misrepresenting another pane.
_Avoid_: single-pane session, empty tab

# Pi Herdr Tools

Pi Herdr Tools connects human-directed Pi conversations to Herdr tabs, panes, and worktrees. Conversation clones, side questions, and worktree handoffs are distinct from checked subagent delegation.

## Language

### Clones and handoffs

**Active-path clone**:
A separate Pi session containing the original conversation's root-to-current-leaf path, without sibling branches. The original session remains active.
_Avoid_: full session copy, session fork

**Clone tab**:
A new tab in the current Herdr workspace containing an active-path clone with the same working directory.
_Avoid_: worker tab, worktree tab

**Worktree clone**:
An active-path clone in a fresh Herdr Git worktree workspace, with the new checkout as its working directory.
_Avoid_: branch clone, repo copy

**Worktree handoff**:
A new task sent as one self-contained prompt to a new Pi agent in a fresh Herdr worktree based on local `main`. It does not copy the current conversation or provide checked integration.
_Avoid_: worktree clone, delegation

**Ambiguous launch**:
A launch whose response cannot prove whether Herdr created or started the target. Known resources remain for inspection.
_Avoid_: failed clone, cleanup failure

**Worktree completion**:
The explicit end of a task that removes its linked checkout and closes its Herdr workspace tabs. Forced completion permits loss of uncommitted work and removal while other workspaces still use the checkout.
_Avoid_: Pi exit, implicit forced cleanup

### Side questions

**Main**:
The parent Pi session that owns side-thread launch and merge delivery.
_Avoid_: parent agent

**Side thread**:
A separate Pi conversation for a bounded question, with a fixed snapshot of Main's context and the same working directory. Conversation separation is not file isolation.
_Avoid_: child agent

**Side pane**:
The Herdr pane that hosts a side thread.
_Avoid_: child pane, BTW tab

**Side-thread transcript**:
The user and assistant text returned to Main from a side thread, without tool payloads.
_Avoid_: full child context

**Merge request**:
A one-way handoff of a side-thread transcript and follow-up prompt to Main. It is not a Git merge or an acknowledgement from Main.
_Avoid_: merge acknowledgement

**Pending delivery**:
A merge request saved for its original Main session but not yet consumed there.

### Titles and attention

**Display title**:
A model-generated English task phrase, in sentence case, shared by the Pi conversation and its Herdr location. It has at most four words and 20 characters.
_Avoid_: semantic title, raw generated branch

**Semantic branch**:
A Git-safe branch name made from a task kind and display-title words, for a detached or Herdr-generated worktree branch.
_Avoid_: display title, arbitrary Git mutation

**Generated worktree label**:
Herdr's default linked-worktree name, eligible for automatic replacement by the display title.
_Avoid_: semantic branch, custom workspace name

**Custom workspace name**:
A workspace name chosen by the user, replaced only by an explicit rename.
_Avoid_: generated worktree label

**Sole-pane tab**:
A tab containing only the current pane, so its label can represent the current conversation without misrepresenting another pane.
_Avoid_: single-pane session, empty tab

**Dialog blocked status**:
The Herdr indication that Pi waits for a user answer in an interactive dialog. It carries no dialog title or content.

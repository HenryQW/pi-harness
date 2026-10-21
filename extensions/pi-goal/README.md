# `@henryqw/pi-goal`

Give the agent one goal, and Pi continues the work after each stop. The loop ends when the agent gives evidence for each deliverable, or when a stop limit applies.

Inspired by the goal mode in [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Install

```bash
pi install npm:@henryqw/pi-goal
```

## Use

Ask the agent to work toward a goal, for example: "Make this a goal: all tests pass and the README documents `/export`." The agent calls `goal` with action `create`. When the agent stops before completion, Pi sends a hidden continuation, and the agent continues.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/goal` | command | For users: show the goal, its status, and tokens used. |
| `/goal drop` | command | For users: drop the active goal and stop continuation. |
| `goal` | tool | For agents: create, get, complete, or drop the goal. |
| Footer status | ui | Shows the active goal objective and tokens used. |

### Tool actions

| Action | Parameters | Result |
| --- | --- | --- |
| `create` | `objective`, optional `deliverables` and `token_budget` | Starts a goal. Fails when a goal is already active. |
| `get` | — | Shows the goal, tokens used, and remaining budget. |
| `complete` | `evidence`: one `{ deliverable, evidence }` item for each deliverable | Completes the goal. |
| `drop` | — | Drops the active goal. |

When the goal has no deliverables, `complete` needs one evidence item with deliverable `objective`. The tool rejects missing, blank, duplicate, or unknown evidence items. The agent must get evidence from current state, such as files, command output, or tests. Memory of earlier turns is not evidence.

## Flow

1. Before each user prompt, Pi Goal adds the goal, the budget numbers, and the completion rules as hidden context.
2. When the agent stops, Pi Goal checks the stop limits. If no limit applies, it adds a hidden continuation with the same goal context.
3. The agent continues in the same run. A successful `complete` or `drop` ends the loop.

Pi Goal does not add a continuation when another extension already continues the same stop. One continuation request then serves both extensions.

## State and storage

Pi Goal keeps no goal state in memory or in files. It reads the latest goal record from the current conversation branch each time:

- `goal` tool results store the full goal in their `details`.
- `/goal drop` appends a `pi-goal` custom entry.
- Each continuation is a hidden `pi-goal-continuation` message.

Branch navigation, `/tree`, forks, resume, and `/undo` rewinds show the goal of the selected branch. A rewind to a point before `create` removes the goal from that branch.

## Limits and recovery

| Limit | Behavior | Recovery |
| --- | --- | --- |
| Interactive only | Continuation needs a UI. Print mode and other modes without UI do not continue. | Send each next prompt manually. |
| Maximum continuations | Continuation stops after 20 automatic turns since the latest user prompt. | Send a prompt to continue. |
| No progress | Continuation stops when two automatic turns in sequence show identical tool activity. | Send a prompt with new direction, or run `/goal drop`. |
| Budget | Continuation stops when tokens used reach `token_budget`. The goal stays active; it is not complete. | Send a prompt to continue, or run `/goal drop`. |
| Abort, error, compaction | Continuation stops after an abort or error, and while compaction runs. | Send a prompt to continue. |
| Evidence | Evidence is model-reported text. Pi Goal checks that it is present, not that it is true. | Examine the evidence in the `complete` result before you accept the work. |

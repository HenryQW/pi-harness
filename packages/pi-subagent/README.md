# `@henryqw/pi-subagent`

Delegate one bounded task to one isolated Pi process, or reuse validated Role launch and managed Herdr hosting for durable workers. Main chooses Role and may override shared task-model effort per call.

## Why

- **Created for**: Delegating bounded tasks to isolated child Pi processes while Main retains integration decisions.
- **Advantage**: Validated Roles, capped concurrency, timeouts, and managed Herdr hosting make delegation predictable.
- **Inspired by**: Pi's example Role conventions and the need to isolate child work from Main.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-multi-codex
pi install npm:@henryqw/pi-subagent
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required. Shared `fast` / `balanced` / `frontier` / `fav` routes. |
| `@henryqw/pi-multi-codex` | Required. Child uses Main's active Codex slot. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `delegate_task` | tool | Start one isolated child for `role`, `task`, and optional `model`, `modelClass`, or `thinking`. |

An explicit `model` (`provider/modelId`) overrides `modelClass` and resolves against the currently available text models; an unknown reference rejects with the list of available models. Thinking level defaults to `medium` when supported, otherwise the highest supported level; a designated model with no usable level rejects before launch. An explicit `thinking` level participates in route resolution itself: routes that cannot honor it are skipped so fallback routes get considered, and delegation rejects when no route supports the level.

`modelClass` is `fast`, `balanced`, `frontier`, or `fav`. Omitted class uses the shared `pi-subagent/delegateTask` assignment, which defaults to `balanced`. Primary route is resolved against current scoped text models; fallback is tried only before launch. If no route is usable, delegation rejects with `Run /task-models`. A started child is never retried.

Main splits broad work into independent bounded tasks and keeps integration and cross-cutting decisions. Each `task` states its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and validation. Each call uses the least capable `modelClass` that can reliably complete its task. Independent sibling calls can run concurrently; concurrent edit tasks must own non-overlapping files. Up to five active ephemeral `delegate_task` subagents run per Main; excess calls wait FIFO. Configure the cap with `"maxSubagents"` (positive integer) in `~/.pi/agent/config/pi-subagent/pi-subagent.json`, or override per session with the `PI_SUBAGENT_MAX_SUBAGENTS` environment variable. Child timeouts are configurable with a `"timeout"` object: `{ "idleMinutes": 10, "maxMinutes": 30 }` (all keys optional; defaults 10/30; the effective maximum must exceed the idle timeout). Invalid config values fall back to the default with a warning; an invalid environment variable fails fast. Queued calls do not start a child or consume child timeout. Managed Herdr workers are unaffected.

Each call starts one isolated child (`pi --mode json -p --no-session`). Ambient extensions and Skills are off. Role/caller extensions load; those packages' tools and Skills auto-load, plus any extra `skills` names. Child uses the delegated working directory and Main's project approval. Abort kills the child process group. Child timeout behavior uses `deadline = min(last recognized Pi JSON event + idle timeout, child start + maximum runtime)`: recognized Pi events renew; raw bytes do not; max always terminates. Streaming output is capped at 50 KiB. Unused JSON event types are discarded before payload buffering; consumed or unclassifiable events above 1 MiB fail delegation.

TUI shows one row per Subagent with role, route, task, tokens, and elapsed time. Terminal rows drop after one second.

## Config

Role files and `pi-subagent.json` live in `~/.pi/agent/config/pi-subagent/`. Model routes live in `~/.pi/agent/config/pi-task-models.json`.

```markdown
---
name: reviewer
description: Reviews changes for correctness and security
tools: [read, grep, find, ls, bash]
extensions:
  - ~/.pi/agent/extensions/review-tools.ts
skills:
  - code-review
  - security
---

Review only requested change. Return ranked findings with file and line evidence.
Do not edit files.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Role selected by Main |
| `description` | yes | Tells Main when to use the role |
| `tools` | no | Omit for Pi defaults; when present, base tools are listed and every loaded Role/caller extension tool is added automatically. `[]` leaves extension tools only. |
| `extensions` | no | Absolute/`~/` paths or package sources. Package-declared Skills and Pi `resources_discover` Skill paths load automatically. Repository-relative paths are rejected. |
| `skills` | no | Additional effective Pi Skill names, resolved from Main's registry |
| `isolation` | no | Set to `worktree` to give each delegated child its own git worktree branched from Main's current `HEAD` |
| Markdown body | yes | Role system instructions |

Missing skills warn and skip; they do not block delegation. No repo-controlled `.pi/agents` roles. No package-local model picker.

With `isolation: worktree`, each child runs in `<primary-workspace>/.worktrees/subagent-<hash>` on branch `pi-subagent/subagent-<hash>`, using a fixed hash of the child ID so parallel children never clobber each other's files. This stable root keeps children outside removable linked checkouts. Git submodules reject worktree isolation because parent cleanup can remove their Git metadata. Non-git directories and repositories with no commits silently share Main's working directory; worktree setup failures in a real git repository reject the delegation instead of silently losing isolation. The directory is excluded from git status through the repository-local exclude file. The child is told to work only inside its worktree and commit to its branch; after each run the parent sees a worktree report (path, branch, commits, dirty, pruned) appended to the result — including failures and preserved background work during session shutdown, so kept work is always locatable. Worktrees are discarded only when the dedicated branch has no commits, `HEAD` still names that branch, and the full tree including ignored files and submodules is clean; anything holding work stays for the parent to review and merge — children never merge.

## Library API

Package root exports shared `Role` loading, Skill resolution, task-routed Pi launch, and generic managed Herdr lifecycle:

```ts
import {
  loadRoles,
  resolveRoleLaunch,
  managedSubagentWorkspaceId,
  reconcileManagedSubagentTab,
  startManagedSubagent,
} from "@henryqw/pi-subagent";

const role = loadRoles().find(({ name }) => name === "reviewer")!;
const launch = resolveRoleLaunch(pi, ctx, {
  role,
  taskId: "your-package/review",
  extensions: [adapterExtensionPath],
  tools: ["submit_review"],
});
const workspaceId = await managedSubagentWorkspaceId(ctx.cwd, mainPane, { execute });
const host = { cwd: ctx.cwd, workspaceId };
const tab = await reconcileManagedSubagentTab(host, { cwd: worktree, launch, label }, { execute });
await startManagedSubagent(host, agentName, tab.paneId, launch, { execute });
```

`resolveRoleLaunch` uses shared task assignment and effective Pi registries. Caller tools extend Role base tools; Role and caller extension tools activate automatically. Omitted Role `tools` preserves Pi defaults. Generic host APIs contain no workflow prompts or durable state.

## Remove

```bash
pi remove npm:@henryqw/pi-subagent
```

## Development

```bash
npm test --workspace @henryqw/pi-subagent
npm run typecheck --workspace @henryqw/pi-subagent
npm run pack:check --workspace @henryqw/pi-subagent
```

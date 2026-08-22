# `@henryqw/pi-subagent`

Delegate one bounded task to one isolated Pi process, or reuse validated Role launch and managed Herdr hosting for durable workers. Main chooses Role and may override shared task-model effort per call.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-multi-codex
pi install npm:@henryqw/pi-subagent
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required. Shared `fast` / `balanced` / `frontier` routes. |
| `@henryqw/pi-multi-codex` | Required. Child uses Main's active Codex slot. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `delegate_task` | tool | Start one isolated child for `role`, `task`, and optional `modelClass`. |

`modelClass` is `fast`, `balanced`, or `frontier`. Omitted class uses the shared `pi-subagent/delegateTask` assignment, which defaults to `balanced`. Primary route is resolved against current scoped text models; fallback is tried only before launch. If no route is usable, delegation rejects with `Run /task-models`. A started child is never retried.

Main splits broad work into independent bounded tasks and keeps integration and cross-cutting decisions. Each `task` states its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and validation. Each call uses the least capable `modelClass` that can reliably complete its task. Independent sibling calls can run concurrently; concurrent edit tasks must own non-overlapping files.

Each call starts one isolated child (`pi --mode json -p --no-session`). Ambient extensions and Skills are off. Role/caller extensions load; those packages' tools and Skills auto-load, plus any extra `skills` names. Child uses the delegated working directory and Main's project approval. Abort kills the child process group. An inactive child times out after 10 minutes; current model/tool execution or activity in the last minute grants one 5-minute grace period, then the child stops. Streaming output is capped at 50 KiB. Unused JSON event types are discarded before payload buffering; consumed or unclassifiable events above 1 MiB fail delegation.

TUI shows one row per Subagent with role, route, task, tokens, and elapsed time. Terminal rows drop after one second.

## Config

Role files live in `~/.pi/agent/config/pi-subagent/*.md`. Model routes live in `~/.pi/agent/config/pi-task-models.json`.

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
| Markdown body | yes | Role system instructions |

Missing skills warn and skip; they do not block delegation. No repo-controlled `.pi/agents` roles. No package-local model picker.

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

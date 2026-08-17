# `@henryqw/pi-subagent`

Delegate one bounded task to one isolated Pi process, or reuse validated Role launch and managed Herdr hosting for durable workers.

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

`modelClass` is `fast`, `balanced`, or `frontier`. Omitted class uses `balanced`. Primary route is resolved against current scoped text models; fallback is tried only before launch. If no route is usable, delegation rejects with `Run /task-models`. A started child is never retried.

Each call starts one isolated child (`pi --mode json -p --no-session`). Ambient extensions and skills are off; only role resources load. Child uses the delegated working directory and Main's project approval. Abort kills the child process group. Streaming output is capped at 50 KiB.

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
| `tools` | no | Omit for Pi `defaultTools`; a non-empty list is an exact allowlist; `[]` means none |
| `extensions` | no | Absolute/`~/` paths or package sources. Repository-relative paths are rejected. |
| `skills` | no | Effective Pi skill names, resolved from Main's registry |
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

`resolveRoleLaunch` uses shared task assignment and effective Pi registries. Caller tools extend explicit Role allowlists; omitted Role `tools` preserves Pi defaults. Generic host APIs contain no workflow prompts or durable state.

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

# Pi Orchestrator Context

## Purpose

Act as the sole owner of durable checked local implementation graphs for Pi Main. The package composes pi-subagent Role and evidence APIs, checked Git operations, and Herdr-hosted workers.

## Domain glossary

- **Request**: one immutable goal, task graph, productive deadline, final checks, and optional final judgment.
- **Text Task**: one bounded textual result that later tasks may consume through `contextFrom`.
- **Changeset Task**: one bounded repository change with requirements, deliverable, dependencies, direct checks, and optional judgment.
- **Wave**: ready tasks whose `dependsOn` and `contextFrom` predecessors completed. Tasks run concurrently; only changesets integrate, in declared request order.
- **Main Identity**: exact attached branch, `HEAD`, index, and tree expected before a state-changing Git boundary.
- **Attempt**: one task's bounded durable execution record, including only the evidence for its channel.
- **Transient Launch**: one freshly resolved Role prompt in a private temporary file used only while Pi starts.
- **Assignment**: request goal and task requirements, deliverable, checks, or correction sent as a task message rather than Role instructions.
- **Judgment**: an explicit criterion checked by its selected Role against exact private patch evidence.
- **Attention**: durable state that requires one deliberate retry, verify, finalize, or abort decision.

## Invariants

- `orchestrate_execute` accepts one strict request with one to eight text or changeset tasks. Every task has an explicit Role and model class; changeset tasks also have checks.
- Preflight requires one canonical clean Git Main with a committed `HEAD`. It resolves every explicit task and judgment Role before durable work starts.
- Task Roles resolve through Pi Subagent to exact model, argument, environment, tool, extension, Skill, and MCP policy.
- Herdr changeset agents require the acquired launch to match the task's exact Role and to contain no caller Role environment.
- Judgment launches use the declared Role without adding arguments, environment, or resources. Judgment Roles must expose read-only tools.
- Durable state contains no raw Role prompts or prompt paths. Preflight and each launch resolve the effective Role.
- Each final launch boundary creates a unique mode `0600` Role prompt in a mode `0700` temporary directory. Agent startup and judgment execution own its cleanup.
- Assignments, upstream text context, and exact judgment packets remain task messages. They never become Role definitions or Role prompt material.
- A text attempt stores only bounded output or bounded failure and never owns host resources. An interrupted running attempt requires deliberate retry.
- Each changeset attempt owns one worktree, one Herdr workspace, one worker tab, and one agent. The worker tab is created after the workspace pane list is stable, and it is never the worktree root pane. Each allocation stores kind-specific plan and result fields before non-idempotent creation.
- Task identity ignores Git-ignored dependency, build, and index artifacts created by Role tooling. It still rejects tracked changes, non-ignored untracked files, hidden index entries, gitlinks, and branch or commit drift.
- A task worker receives one initial assignment. One correction is allowed only after a settled prompt or an unchanged failed check candidate.
- Ready tasks run in parallel. Text tasks complete in place. Changeset preliminary validation uses direct checks only. Explicit acceptance records the exact checked candidate while its Herdr worker remains live.
- Each accepted changeset records an exact rebase chain, then runs task checks and any declared ephemeral judgment again. The worker remains live through guarded Main integration. Only durable exact integration permits termination, and only exact termination permits cleanup.
- Task and final checks are authoritative. Checks run directly from exact command and argument arrays without a shell.
- Durable check evidence keeps every exact command, argument array, exit status, killed status, and before/after identity. Only one failed-batch diagnostic result may retain bounded output.
- Judgment uses pi-subagent's exact `{base, tip, patchPath}` evidence and accepts only exact `PASS`.
- Main identity is checked at each rebase, integration, and final boundary. Movement during accepted work records another exact rebase; unproved drift fails closed and preserves recovery evidence.
- Request state lives in `config/pi-orchestrator/state/`, outside the repository. Runtime evidence is bounded before persistence. Reads validate strict state schema v3, reject v2 and older versions, and never migrate another format.
- `orchestrate_status` is non-destructive. It reports saved state, Main identity, and only continuations proven safe; it does not reconcile, replay, terminate, or clean up.
- `orchestrate_resume` permits only `retry`, `verify`, or `finalize` under a fresh bounded recovery deadline. Uncertain recovery retains the worker and resources. `orchestrate_abort` is the only pre-integration path that terminates owned workers.
- Cleanup records uncertainty. The runtime never reports unknown resources as absent or force-deletes recoverable work.
- Role child launches register no `orchestrate_*` tools. Main registers exactly execute, status, resume, and abort.
- The package stops at checked local integration. It does not push, manage pull requests, run swarms, migrate old state, or support old protocols.
- Old Auto DAG state is inert and must be settled before upgrade. The repository installer removes only the exact old npm source after every selected package installs successfully.
- Do not add outboxes, delivery hosts, receipts, or broad transport machinery.

## Package boundaries

- pi-orchestrator alone owns request schemas, durable checked graphs, dependency waves, checks, review policy, Git integration, Herdr lifecycle, recovery, and final acceptance.
- pi-subagent owns effective Roles, lightweight generic `delegate_task`, Pi launch policy, the ephemeral executor, low-level worktree APIs, and exact review evidence.
- pi-herdr owns typed Herdr CLI execution and Pi agent startup. pi-orchestrator requires Herdr 0.9.0 and protocol 22 at runtime.
- Main chooses `delegate_task` for lightweight generic delegation and `orchestrate_*` for this checked protocol. The package Skill documents that choice.

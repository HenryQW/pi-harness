---
name: pi-orchestrator
description: Choose lightweight generic delegation or durable checked implementation orchestration.
---

# Choose the delegation path

Use this Skill only from Main.

- Work directly when delegation overhead exceeds the task.
- Use `delegate_task` for bounded research, review, or other lightweight work. It supports one task, independent parallel tasks, and simple chains. It does not own durable state, authoritative checks, integration, or recovery.
- Use `orchestrate_execute` for non-trivial implementation that needs isolated worktrees, explicit dependencies, authoritative task and final checks, declared-order integration, or durable recovery.

Pi Orchestrator stops at checked integration in the local repository. It never pushes, opens or manages pull requests, runs swarms, or reads old Auto DAG state. Settle unfinished old runs before upgrading.

For `orchestrate_execute`, give every task one unique ID, kind, Role, model class, bounded requirements, deliverable, `dependsOn`, and `contextFrom`. Use `kind: "text"` for bounded output that later tasks consume. Use `kind: "changeset"` for repository work and provide at least one direct check. `contextFrom` may name only text tasks and preserves the declared order. Add task or final judgment, with its own Role and model class, only when checks cannot establish the criterion. Keep overlapping changes in one task or order them with `dependsOn`.

Every changeset pauses after preliminary checks with its Herdr worker still live. The user can queue same-agent revisions with `/orchestrate-followup <request-id> <task-id> <message>` and must finish with `/orchestrate-accept <request-id> <task-id>`. After acceptance, the worker remains live through exact rebases, authoritative checks and judgment, and guarded Main integration. The orchestrator terminates it only after exact integration is durably recorded, then cleans up.

Use `orchestrate_status` to inspect durable state without mutating workers or resources. When a request needs attention, use only the reported `orchestrate_resume` action—`retry`, `verify`, or `finalize`—when its saved evidence proves that action safe. Failures, ambiguity, interruption, deadline expiry, and Main drift retain resources. Use `orchestrate_abort` for explicit pre-integration termination.

Never use `delegate_task` as a substitute for checked implementation orchestration. Do not add a second orchestration layer around `orchestrate_*`.

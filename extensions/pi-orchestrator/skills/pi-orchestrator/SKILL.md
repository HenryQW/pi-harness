---
name: pi-orchestrator
description: Choose lightweight generic delegation or durable checked implementation orchestration.
---

# Choose the delegation path

Use this Skill only from Main.

- Work directly when delegation overhead exceeds the task.
- Use `delegate_task` for bounded research, review, or other lightweight work. It supports one task, independent parallel tasks, and simple chains. It does not own durable state, authoritative checks, integration, or recovery.
- Use `orchestrate_execute` for non-trivial implementation that needs isolated worktrees, explicit dependencies, authoritative task and final checks, declared-order integration, or durable recovery.

Version 1 stops at checked integration in the local repository. It never pushes, opens or manages pull requests, runs swarms, or reads old Auto DAG state. Settle unfinished old runs before upgrading.

For `orchestrate_execute`, give every task one unique ID, model class, bounded requirements, deliverable, dependency list, and direct checks. Add task or final judgment only when checks cannot establish the criterion. Keep overlapping changes in one task or order them with `dependsOn`.

Use `orchestrate_status` to inspect durable state. When a request needs attention, follow its evidence and use one deliberate `orchestrate_resume` action: `retry`, `verify`, or `finalize`. Use `orchestrate_abort` to stop an unfinished request. Integration starts only after the task's Herdr worker stops.

Never use `delegate_task` as a substitute for checked implementation orchestration. Do not add a second orchestration layer around `orchestrate_*`.

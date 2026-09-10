# 019. pi-orchestrator

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Some implementation requests need dependencies, isolated worktrees, direct checks, ordered integration, and recovery after interruption. Generic delegation does not own those guarantees.

ADR 007 records the retired Auto DAG architecture. It remains historical evidence, not a design for the current system.

## Decision

`@henryqw/pi-orchestrator` is the sole owner of durable, checked local implementation graphs. Version 1 owns:

- strict request, task, dependency, budget, and state records;
- dependency waves and bounded parallel work;
- isolated Herdr workers for Implementers;
- direct task and final checks;
- optional ephemeral Reviewers that receive exact private patch evidence;
- declared-order integration only after each worker stops and its candidate settles;
- guarded local fast-forward integration and final acceptance; and
- durable status, retry, verification, finalization, abort, and cleanup evidence.

`@henryqw/pi-subagent` owns Roles, generic `delegate_task` delegation, child launch policy, the ephemeral executor, low-level worktree helpers, and exact review-evidence APIs. Orchestrator uses those public support APIs. It does not move checked orchestration back into pi-subagent.

Herdr owns the isolated worker processes. A Reviewer is created only when a task declares a judgment criterion. Direct checks remain authoritative for objective criteria.

Version 1 stops at checked integration in the local repository. It does not push, open or manage pull requests, run swarms, or support old Auto DAG state or protocols. Old Auto DAG state is inert and must be settled before upgrade. The installer removes only the exact `npm:@henryqw/pi-auto-dag` source, and only after all selected packages install successfully.

Do not regrow the retired architecture's outboxes, delivery hosts, receipts, or broad transport machinery. Add a smaller local mechanism only when a current invariant requires it.

## Consequences

Implementation graphs can resume from validated durable state. Worker prose alone never proves completion. Workers stop before integration, direct checks establish objective results, and exact Reviewers handle only declared judgment.

Use `delegate_task` for lightweight generic delegation. Use `orchestrate_*` only when work needs this durable checked local protocol.

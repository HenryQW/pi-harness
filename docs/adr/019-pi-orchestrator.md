# 019. pi-orchestrator

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Some implementation requests need dependencies, isolated worktrees, direct checks, ordered integration, and recovery after interruption. Generic delegation does not own those guarantees.

ADR 007 records the retired Auto DAG architecture. It remains historical evidence, not a design for the current system.

## Decision

`@henryqw/pi-orchestrator` is the sole owner of durable, checked local implementation graphs. It owns:

- strict request, task, dependency, context, budget, and state records;
- dependency waves and bounded parallel work;
- bounded text tasks whose ordered outputs flow through `contextFrom`;
- isolated Herdr workers for changeset tasks;
- direct task and final checks;
- optional ephemeral judgments that use an explicit Role and receive exact private patch evidence;
- declared-order integration only after each worker stops and its candidate settles;
- guarded local fast-forward integration and final acceptance; and
- durable status, retry, verification, finalization, abort, and cleanup evidence.

`@henryqw/pi-subagent` is the sole owner of effective Role parsing, resource resolution, child launch policy, generic `delegate_task` delegation, the ephemeral executor, low-level worktree helpers, and exact review-evidence APIs. Orchestrator resolves each explicit task and judgment Role during preflight and again just before launch. It stores no launch records or Role fingerprints.

Herdr owns isolated changeset worker processes. Preliminary validation uses direct checks only. After worker termination and rebase, one selected judgment Role runs only when a task declares judgment. Direct checks remain authoritative for objective criteria.

Pi Orchestrator stops at checked integration in the local repository. It does not push, open or manage pull requests, run swarms, or support old Auto DAG state or protocols. Old Auto DAG state is inert and must be settled before upgrade. The installer removes only the exact `npm:@henryqw/pi-auto-dag` source, and only after all selected packages install successfully.

Do not regrow the retired architecture's outboxes, delivery hosts, receipts, or broad transport machinery. Add a smaller local mechanism only when a current invariant requires it.

## Consequences

Implementation graphs can resume from validated durable state. Text output is accepted only after successful bounded execution and an unchanged Main identity. Worker prose alone never proves changeset completion. Workers stop before integration, direct checks establish objective results, and exact judgment Roles handle only declared criteria.

Use `delegate_task` for lightweight generic delegation. Use `orchestrate_*` only when work needs this durable checked local protocol.

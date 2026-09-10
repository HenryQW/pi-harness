# Pi Orchestrator Context

## Purpose

Own durable checked implementation orchestration for Pi Main. The package composes pi-subagent Role and evidence APIs, checked Git operations, and Herdr-hosted workers.

## Domain glossary

- **Request**: one immutable goal, task graph, productive deadline, final checks, and optional final judgment.
- **Task**: one bounded implementation outcome with requirements, deliverable, model class, dependencies, checks, and optional judgment.
- **Wave**: ready tasks whose dependencies completed. Tasks run concurrently, then integrate in declared request order.
- **Main Identity**: exact attached branch, `HEAD`, index, and tree expected before a state-changing Git boundary.
- **Attempt**: one task's durable allocation, prompt, candidate, checks, review, integration, and cleanup evidence.
- **Launch Record**: effective Role, route, tools, extensions, Skills, environment, prompt metadata, and integrity fingerprint frozen before workers start.
- **Judgment**: an explicit criterion checked by a read-only Reviewer against exact private patch evidence.
- **Attention**: durable state that requires one deliberate retry, verify, finalize, or abort decision.

## Invariants

- `orchestrate_execute` accepts one strict version-1 request with one to eight tasks. Every task has checks and an explicit model class.
- Preflight requires one canonical clean Git Main with a committed `HEAD`. It freezes every required effective Implementer and Reviewer launch before durable work starts.
- Private Implementer prompts are mode `0600`. Launch records bind the effective model route and resources. Productive resume fails on drift.
- Each task attempt owns one worktree, one Herdr workspace, one worker tab, and one agent. Allocation intent is durable before non-idempotent creation.
- A task worker receives one initial assignment. One correction is allowed only after a settled prompt or an unchanged failed check candidate.
- Ready tasks run in parallel. Their exact committed candidates are checked and optionally reviewed before declared-order guarded fast-forward integration.
- Task and final checks are authoritative. Checks run directly from exact command and argument arrays without a shell.
- Judgment runs only when declared. It uses pi-subagent's exact `{base, tip, patchPath}` evidence and accepts only exact `PASS`.
- Main identity is checked at each integration and final boundary. Drift fails closed and preserves recovery evidence.
- Request state lives in `config/pi-orchestrator/state/`, outside the repository. Reads validate the strict schema and never migrate another format.
- `orchestrate_status` may reconcile interrupted state and terminate ambiguous owned workers. It starts no productive replacement attempt.
- `orchestrate_resume` permits only `retry`, `verify`, or `finalize`. `orchestrate_abort` terminates owned workers before recording abort.
- Cleanup records uncertainty. The runtime never reports unknown resources as absent or force-deletes recoverable work.
- Role child launches register no `orchestrate_*` tools. Main registers exactly execute, status, resume, and abort.

## Package boundaries

- pi-orchestrator owns request schemas, durable state, dependency waves, checks, review policy, Git integration, Herdr lifecycle, recovery, and final acceptance.
- pi-subagent owns effective Roles, Pi launch policy, the ephemeral Reviewer executor, low-level worktree APIs, and exact review evidence.
- pi-herdr owns typed Herdr CLI execution and Pi agent startup. pi-orchestrator requires Herdr 0.9.0 and protocol 22 at runtime.
- Main chooses `delegate_task` for lightweight generic delegation and `orchestrate_*` for this checked protocol. The package Skill documents that choice.

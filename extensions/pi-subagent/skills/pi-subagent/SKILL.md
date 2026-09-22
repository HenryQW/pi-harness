---
name: pi-subagent
description: Delegate bounded direct work or run durable checked isolated task graphs.
---

# Choose and authorize delegation

Use this Skill only from Main.

Record the requested outcome, allowed scope and exclusions, local delegation/check/review/integration permission, and any external-action permission before substantial work. A clear small request can supply this authorization directly. Ask again only for a material scope or contract change, a missing decision or authorization, a user-owned conflict, or a consequential action outside that scope.

Keep trivial, mechanically verifiable work in Main. Choose the user-requested mode when one is explicit. Otherwise:

- Use `mode: direct` for bounded research, analysis, review, and tightly coupled implementation. Direct implementation is serial in Main's checkout, leaves changes uncommitted, and starts only from a clean attached Git checkout when checks or judgment are requested.
- Use `mode: isolated` for independently implementable checked changes with useful parallelism, an exploratory or discardable candidate, or work that must leave Main undisturbed. A single isolated task is valid.
- Keep one implementation owner for tightly coupled work. Size alone does not justify splitting it.
- Never silently fall back from isolated to direct. Scope growth requires a checkpoint and replan, not migration of dirty work.

Roles describe responsibility and capabilities; they do not select isolation. Bash, MCP tools, unknown tools, and arbitrary extensions are potentially writing. The checkout coordinator reduces races among Pi-owned calls but is not an OS sandbox and cannot control external processes.

# Direct requests

Use one compact `role`/`name`/`task` packet, `tasks` for independent packets, or `chain` for dependent packets. Text is the default kind. Declare `kind: changeset` for mutation and provide direct command/argv checks. Add judgment only when checks cannot establish a criterion. Background execution is only for provably read-only direct work.

Checked direct work binds checks and judgment to exact working-change evidence without changing the real index, committing, or creating a worktree. Existing dirty work, external Git content filters, unsupported Git layouts, oversized evidence, hidden index state, or candidate drift block validation and preserve user files. A failed request retains its changes.

# Isolated requests

Give the request a unique ID and goal. Give each task a unique ID, kind, Role, model class, bounded requirements, deliverable, `dependsOn`, and `contextFrom`. Changesets require direct task checks, and a graph containing changesets requires final checks. Authoritative task checks run against the exact candidate before integration. Authoritative final checks run against the resulting Main identity before completion. Text context may name only completed text tasks and preserves declared order.

Use scoped approval by default. Scoped approval records acceptance of the exact preliminary checked candidate automatically. Use supervised approval only when the user requested an explicit integration checkpoint; `/subagent-accept <request-id> <task-id>` then accepts that exact candidate, while `/subagent-followup <request-id> <task-id> <message>` requests a same-agent correction and invalidates prior acceptance.

The same isolated worker stays live through same-worktree rebase, authoritative task checks and judgment, guarded integration, durable integration recording, exact termination, and cleanup. Failures, ambiguity, conflicts, interruption, child-limit exhaustion, or Main drift retain work and never waive checks or identity guards. The extension never pushes, opens a pull request, publishes, or deploys.

Use `subagent_status` to inspect durable state without mutation. Use only the continuation reported by `subagent_resume`; a resume does not reset the request's recorded policy or correction count. Use `subagent_abort` for explicit teardown. Status, abort, process I/O, termination, and verified post-integration cleanup keep finite safety budgets.

All direct and isolated launches share the global policy in `config/pi-subagent/config.json`: productive concurrency, per-child turns/tokens, child idle/hard timeout, and the request-wide correction cap. Productive requests have no whole-run wall-clock deadline. Request fields cannot replenish or override limits.

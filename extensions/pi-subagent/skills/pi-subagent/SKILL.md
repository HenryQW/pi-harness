---
name: pi-subagent
description: Delegate bounded direct work or run durable checked isolated task graphs.
---

# Choose and authorize delegation

Use this Skill only from Main.

Record the requested outcome, allowed scope and exclusions, local delegation/check/review/integration permission, and any external-action permission before substantial work. A clear small request can supply this authorization directly. Ask again only for a material scope or contract change, a missing decision or authorization, a user-owned conflict, or a consequential action outside that scope.

Keep trivial, mechanically verifiable work in Main. Choose the user-requested mode when one is explicit. Otherwise:

- Use `mode: direct` for bounded read-only research, analysis, and review with known read-only Roles.
- Use `mode: isolated` for implementation and other writing tasks, independently checked changes, or an exploratory or discardable candidate. A single isolated task is valid.
- Keep one implementation owner for tightly coupled work. Size alone does not justify splitting it.
- Never silently fall back from isolated to direct. Scope growth requires a checkpoint and replan, not migration of dirty work.

Roles describe responsibility and capabilities; they do not select isolation. Bash, MCP tools, unknown tools, and arbitrary extensions are potentially writing. The checkout coordinator reduces races among Pi-owned calls but is not an OS sandbox and cannot control external processes.

# Direct requests

Use one compact `role`/`name`/`task` packet, `tasks` for independent packets, or `chain` for dependent packets. Only text tasks are accepted; a write-capable Role, `kind: changeset`, checks, and judgment require isolated mode. The tool returns a handle after launching Herdr tabs in the current workspace. Main receives the verified result as a follow-up after the workflow finishes, without interrupting an active turn. If observation stops, run `/subagent-direct-recovery` to inspect the exact tabs and session files.

# Isolated requests

Give the request a unique ID and goal. Give each task a unique ID, kind, Role, model class, bounded requirements, deliverable, `dependsOn`, and `contextFrom`. Changesets require direct task checks, and a graph containing changesets requires final checks. Authoritative task checks run against the exact candidate before integration. Authoritative final checks run against the resulting Main identity before completion. Text context may name only completed text tasks and preserves declared order.

Every changeset advances automatically after preliminary checks pass. While a task is actively working, the user may queue bounded same-worker revisions with `/subagent-followup <request-id> <task-id> <message>`; each revision must produce a new clean commit and rerun preliminary checks. When no queued revision remains, the runner seals and durably records the exact ready candidate without waiting for input. There is no guaranteed post-completion editing window, and late follow-ups fail visibly.

The same isolated worker stays live through same-worktree rebase, authoritative task checks and judgment, guarded integration, durable integration recording, exact termination, and cleanup. Failures, ambiguity, conflicts, interruption, child-limit exhaustion, or Main drift retain work and never waive checks or identity guards. The extension never pushes, opens a pull request, publishes, or deploys.

Use `subagent_status` to inspect durable state without mutation. Use only the continuation reported by `subagent_resume`; a resume does not reset the request's recorded policy or correction count. Use `subagent_abort` for explicit teardown. Status, abort, process I/O, termination, and verified post-integration cleanup keep finite safety budgets.

All launches use the global policy in `config/pi-subagent/config.json`: productive concurrency, per-child turns/tokens, and idle timeout. Ephemeral children also have a hard runtime limit; isolated requests have a correction cap. Productive requests have no whole-run wall-clock deadline. Request fields cannot replenish or override limits.

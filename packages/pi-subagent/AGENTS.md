# Pi Subagent maintenance rules

These rules apply to `packages/pi-subagent` in addition to the repository-level instructions.

## Sources of truth

- Define related names, limits, and statuses once as typed readonly values. Derive CLI strings, sets, schemas, and display forms from that source instead of maintaining parallel literals.
- Continue using Pi's effective registries as the authority for Skills, models, and tools; do not add package-owned discovery catalogs.

## Architecture boundaries

- Keep `createRoleLaunch` as the launch-policy boundary: it resolves Role resources, route, project trust, environment, and Pi arguments. The Ephemeral Executor receives a prepared launch and must not discover Roles, resources, worktrees, or workflow policy.
- Keep `delegate_task` generic and caller-composable. Keep `delegate_flow` a separate package-owned Git protocol using the effective `implementer` Role and, only for units with `review`, the effective `reviewer` Role; do not make ordinary delegation inherit Flow's commit, validation, review, integration, or cleanup requirements.
- Resolve and freeze the effective Flow Implementer when a Flow starts. Resolve and freeze its Reviewer only when a requested unit declares `review`; same-named user Roles override package defaults without changing Flow's Git, validation, conditional review-packet, approval, integration, or cleanup protocol.

## Launches and prompts

- Keep stable child identity and Role instructions separate from per-run task text, cwd/worktree paths, review packets, and recovery guidance. Stable prompt material must precede variable material to preserve clear ownership and provider cache reuse.
- Main populates direct `model` and `thinking` only for explicit user-requested overrides; otherwise it selects only `modelClass`. Prioritize `fast` for straightforward work and `balanced` for complex work. Reserve `frontier` for exceptionally complex or tricky work. This is policy only: add no provenance tracking or runtime enforcement.
- Fail fast on malformed configuration and unavailable explicitly requested resources. Name the invalid or unavailable values and their provider requirement; do not silently launch an under-capable child. Documented optional resources, such as unavailable optional Skills, may retain their explicit warning behavior.
- Launch only through the active Pi process invocation. Do not add standalone Pi discovery, install probing, shell execution, or a fallback child runtime.
- Ambient child extensions and Skills stay disabled. An explicitly selected Role/caller extension is a trusted atomic capability bundle: activate every tool it registers and every Skill supplied through its Pi package metadata or dynamic `resources_discover`, alongside separately named Role Skills. Do not infer or externally narrow undocumented extension dependencies; an extension may rely on its tools, Skills, lifecycle, and prompt behavior, and loading it is not sandboxing. Scope children by selecting fewer trusted extensions; finer granularity requires separate extension entry points/configuration or an upstream split. Keep recursive delegation tools excluded from every child, and retain final-registry verification for explicit Role/caller tool names.

## Executor protocol

- Acquire an executor permit before preparing launch-specific state. FIFO queue time must not create worktrees, resolve queued resources, start child timeouts, or consume an active slot.
- Start idle and maximum deadlines only when the child starts. Only recognized Pi JSON events renew the idle deadline; raw stdout/stderr bytes do not, and maximum runtime always wins.
- Keep assistant output and stderr bounded on valid UTF-8 boundaries and keep consumed JSON events bounded. Do not replace streaming bounds with unbounded accumulation; irrelevant known oversized events may be discarded without parsing their payload.
- Preserve aggregate child `Usage` on success, launched failures, aborts, timeouts, protocol failures, and callback failures without double counting turns.
- Treat observer callback failure as a typed executor failure, terminate the child, and release the permit. Never let an unsettled callback or inherited stdio retain a permit indefinitely.

## Flow and Git

- One Flow unit owns one retained Unit Worktree reused for implementation, rebase, validation, optional exact review, one repair, and cleanup. Never create nested or reviewer-only candidate worktrees.
- Declared validation is authoritative for objective verification. Only a unit's explicit `review` criterion may trigger judgment review: derive its identity from Git, review the private exact base-to-tip patch, accept only exact `PASS`, and integrate only the full approved tip OID with `git merge --ff-only`. Units without `review` integrate their exact validated tip through the same guarded fast-forward path.
- Preserve the existing no-op rule: only a post-rebase `base === tip` skips Reviewer and merge, after validation. An initial zero-commit implementation remains a block.
- Cleanup is non-forced. On failed rebase, validation/review failure, uncertain integration, dirty state, or cleanup refusal, preserve actionable recovery evidence and never delete work that cannot be proven integrated.
- Do not add automatic retries, post-merge validation, saved Flow state, aggregate review, dependency graphs, or compatibility paths without an explicit architecture decision.

## Lifecycle and state

- Give each child process, stream, timer, listener, worktree, and UI resource one lifecycle owner. Use one idempotent cleanup path from every terminal outcome rather than duplicating teardown across success, failure, abort, and timeout branches.
- Preserve discriminated outcome and status unions. Extend existing variants and handle them exhaustively instead of introducing combinations of booleans, nullable fields, or fallback chains.
- Tie background delivery to the launching session generation. After session replacement or shutdown, suppress stale ordinary results but still report retained isolated work needed for recovery.

## UI and performance

- Update compact derived UI state when events arrive. Render functions must read in-memory state only: no filesystem access, Git, registry scans, process calls, or full-history reductions.
- Test performance-sensitive invariants with operation counts or forbidden-operation assertions, not elapsed-time thresholds. Use elapsed time only when timeout behavior itself is the contract.
- Keep foreground and background result text bounded while preserving structured identity, status, usage, and recovery details outside lossy excerpts. Truncated Reviewer output is never approval.

## Validation

- Test policy at its owning layer: pure parsing/planning directly, executor protocol in `ephemeral.test.ts`, ordinary orchestration in `subagent.test.ts`, Flow Git behavior in `delegate-flow.test.ts`, and worktree/evidence mechanics in their focused suites.
- Prefer one regression that exercises the real failure boundary. Do not duplicate a successful Flow validation in Main or add broad timing assertions when a deterministic state or operation-count assertion proves the contract.

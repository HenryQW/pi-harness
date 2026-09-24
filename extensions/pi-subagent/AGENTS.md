# Pi Subagent maintenance rules

Follow [ADR 016](../../docs/adr/016-pi-subagent-architecture.md) and the [orchestration/API contract](docs/orchestration.md). These implementation boundaries supplement the repository rules.

## Sources and boundaries

- Define related names, limits, and statuses once as typed readonly values; derive schemas and display forms rather than duplicating literals. Use Pi's effective registries for Skills, models, and tools, not package catalogs.
- `createRoleLaunch` owns launch policy: Role resources, route, trust, environment, and Pi arguments. The Ephemeral Executor receives a prepared launch and owns only execution mechanics.
- `delegate_task` owns flat single, parallel, and chain delegation. Library callers own durable state, checks, review, integration, retry, and cleanup policy.

## Launches

- Put stable child identity and Role instructions before per-run task, paths, and recovery guidance in prompts.
- Route precedence is call `modelClass` > Role `modelClass` > configured Model Task assignment/default. Main uses `extensions/model-class-policy.ts` for explicit classes; direct `model` replaces only the route model, not its thinking level. Apply the same policy in every delegation tool.
- Fail before launch on malformed config or unavailable explicitly requested resources, naming the missing value and provider. Launch only through active Pi; no standalone discovery or fallback runtime.
- Disable ambient child extensions and Skills. An explicitly selected Role or caller extension activates all its registered tools and Pi-discovered Skills, alongside named Role Skills. Exclude Main-only delegation/orchestration tools, and verify explicit tool names against the final registry.
- Keep `delegate_task` mode explicit. Direct mode runs read-only single, parallel, and chain tasks in current-workspace Herdr tabs. Write-capable work requires isolated checked task graphs; neither mode may silently fall back to the other.
- Keep Roles capability-focused; requests own isolation. pi-subagent owns checked validation, judgment, integration, recovery, and cleanup while library exports remain reusable mechanisms.

## Executor and evidence

- Acquire a FIFO permit before preparing launch state. Queue time must not create worktrees, resolve queued resources, start timeouts, or occupy an active slot.
- Start idle and maximum deadlines when the child starts; only recognized Pi JSON events renew idle. Maximum runtime wins. Bound output and JSON events, preserving valid UTF-8 and aggregate Usage on every terminal outcome without double counting.
- Observer callback failure is a typed executor failure: terminate the child and release the permit. Give each process, stream, timer, listener, worktree, and UI resource one owner and one idempotent cleanup path.
- Worktree helpers are policy-neutral; cleanup is non-forced and reports retained or uncertain work. `prepareExactReviewEvidence` derives Git identity and a private exact base-to-tip patch; callers own review decisions. Never weaken OID, patch bounds, private-file, or clean-state checks.

## Results and validation

- Keep discriminated outcome/status unions exhaustive. Tie asynchronous follow-up delivery to the launching session generation: suppress stale results after replacement or shutdown, retaining exact direct tab identities and isolated work for recovery.
- Do not introduce a whole-request productive deadline; child, I/O, status, termination, and cleanup safety bounds remain local.
- Update compact UI state on events; rendering reads memory only. Bound visible text while preserving structured identity, status, usage, and recovery details.
- Test policy at its owning layer: parsing/planning directly, executor protocol in `ephemeral.test.ts`, direct delegation in `subagent.test.ts`, checked orchestration in isolated runner/runtime suites, and worktree/evidence mechanics in their focused suites. Prove performance invariants with operation counts or forbidden-operation assertions, not timing thresholds.

# Pi Subagent maintenance rules

These rules apply to `extensions/pi-subagent` in addition to the repository-level instructions.

## Sources of truth

- Define related names, limits, and statuses once as typed readonly values. Derive CLI strings, sets, schemas, and display forms from that source instead of maintaining parallel literals.
- Continue using Pi's effective registries as the authority for Skills, models, and tools. Do not add package-owned discovery catalogs.

## Architecture boundaries

- Keep `createRoleLaunch` as the launch-policy boundary. It resolves Role resources, route, project trust, environment, and Pi arguments.
- Keep the Ephemeral Executor mechanism-only. It receives a prepared launch and must not discover Roles, resources, worktrees, or workflow policy.
- Keep `delegate_task` generic and caller-composable. It owns only flat single, parallel, and chain delegation.
- Library callers own implementation protocols, durable state, checks, review decisions, integration, retry, and cleanup policy. pi-subagent supplies Role, executor, worktree, and exact-evidence APIs without claiming that orchestration.

## Launches and prompts

- Keep stable child identity and Role instructions separate from per-run task text, cwd/worktree paths, review packets, and recovery guidance. Stable prompt material must precede variable material to preserve clear ownership and provider cache reuse.
- Route precedence is explicit call-level `modelClass` > Role `modelClass` > configured Model Task assignment or declared default. Main follows `extensions/model-class-policy.ts` when selecting an explicit class. A direct `model` replaces only the selected route model. The route owns its exact thinking level. Reuse this policy in every delegation tool.
- Fail fast on malformed configuration and unavailable explicitly requested resources. Name the invalid or unavailable values and their provider requirement. Do not silently launch an under-capable child.
- Launch only through the active Pi process invocation. Do not add standalone Pi discovery, install probing, shell execution, or a fallback child runtime.
- Ambient child extensions and Skills stay disabled. An explicitly selected Role or caller extension is a trusted atomic capability bundle. Activate every tool it registers and every Skill supplied through its Pi package metadata or dynamic `resources_discover`, alongside separately named Role Skills.
- Keep Main-only delegation and orchestration tools excluded from every child. Retain final-registry verification for explicit Role and caller tool names.

## Executor protocol

- Acquire an executor permit before preparing launch-specific state. FIFO queue time must not create worktrees, resolve queued resources, start child timeouts, or consume an active slot.
- Start idle and maximum deadlines only when the child starts. Only recognized Pi JSON events renew the idle deadline. Maximum runtime always wins.
- Keep assistant output and stderr bounded on valid UTF-8 boundaries. Keep consumed JSON events bounded.
- Preserve aggregate child `Usage` on success, launched failures, aborts, timeouts, protocol failures, and callback failures without double counting turns.
- Treat observer callback failure as a typed executor failure, terminate the child, and release the permit.

## Worktrees and exact evidence

- Keep low-level worktree helpers policy-neutral. Callers own when to allocate, retain, integrate, or clean worktrees.
- Cleanup is non-forced. Preserve actionable recovery evidence when committed, dirty, switched, or unmeasurable work cannot be safely removed.
- `prepareExactReviewEvidence` derives candidate identity from Git and creates a private exact base-to-tip patch. Callers own the review criterion, verdict parser, approval rule, and integration decision.
- Never weaken exact OID, bounded patch, private-file, or clean-state checks for caller convenience.

## Lifecycle and state

- Give each child process, stream, timer, listener, worktree, and UI resource one lifecycle owner. Use one idempotent cleanup path from every terminal outcome.
- Preserve discriminated outcome and status unions. Extend variants and handle them exhaustively instead of adding boolean or nullable fallback chains.
- Tie background delivery to the launching session generation. After session replacement or shutdown, suppress stale ordinary results but still report retained isolated work needed for recovery.

## UI and performance

- Update compact derived UI state when events arrive. Render functions must read in-memory state only.
- Test performance-sensitive invariants with operation counts or forbidden-operation assertions, not elapsed-time thresholds.
- Keep foreground and background result text bounded while preserving structured identity, status, usage, and recovery details outside lossy excerpts.

## Validation

- Test policy at its owning layer: pure parsing and planning directly, executor protocol in `ephemeral.test.ts`, generic orchestration in `subagent.test.ts`, and worktree or evidence mechanics in their focused suites.
- Prefer one regression that exercises the real failure boundary. Do not add broad timing assertions when deterministic state or operation counts prove the contract.

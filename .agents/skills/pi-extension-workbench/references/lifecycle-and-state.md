# Lifecycle and State

Read matching installed `docs/extensions.md` sections: `Long-lived resources
and shutdown`, `Lifecycle Overview`, `Handler Composition`, `State Management`,
or `Error Handling`.
Verify payloads and result contracts in installed event declarations.
Example paths below are relative to `examples/extensions/`.

| Need | Event/API | Example |
|---|---|---|
| Start cwd/session-bound resources | `session_start` | `file-trigger.ts`, `ssh.ts` |
| Release timers, watchers, processes, sockets | `session_shutdown` | `mac-system-theme.ts` |
| Guard session transitions/compaction | Matching `session_before_*` | `confirm-destructive.ts`, `dirty-repo-guard.ts` |
| Restore branch-dependent state | `session_start`, `session_tree`, `getBranch()` | `todo.ts`, `tools.ts` |
| Modify structured prompt/conversation | `before_agent_start`, `context` | `pirate.ts`, `plan-mode/index.ts` |
| Request final continuation / observe settlement | `agent_before_settle` / `agent_settled` | `git-checkpoint.ts`, `notify.ts` |
| Intercept tools or shell | `tool_call`, `tool_result`, `user_bash` | `permission-gate.ts`, `interactive-shell.ts` |
| Transform input | `input` | `input-transform-streaming.ts` |
| Customize or trigger compaction | `session_before_compact`, `ctx.compact()` | `custom-compaction.ts`, `trigger-compact.ts` |
| Compute runtime resource paths / gate project startup | `resources_discover`, `project_trust` | `dynamic-resources/index.ts`, `project-trust.ts` |
| Observe raw provider streams | `provider_stream_event` | `debug-provider.ts` |

## Pitfalls

- Factories may be async and may run without a session. Register there, but start
  long-lived resources at `session_start` or on demand. Cleanup must be
  idempotent across cancellation, reload, replacement, and exit.
- Module variables are caches. Persist branch-aware tool state in result
  `details`, non-model data with `appendEntry`, and model content with
  `sendMessage`. Rebuild from `getBranch()`, not all file entries; abandoned
  branches are alternative histories. Verify affected fork/tree/switch paths.
  In Pi 1.5.2, a missing-directory session can switch to a full-history fork
  with a new session identity; this emits switch, not fork, events.
- Pi 1.5.1 and later reject reload during a response or compaction. Command
  handlers can await `ctx.waitForIdle()` before reload; do not wait from a tool
  that must finish before the agent can become idle.
- Event return contracts differ: explicit cancellation, blocking, transformation,
  and notification are not interchangeable. Input transformation must account
  for steering (`streamingBehavior`) without slow preprocessing.
- Prefer structured `systemPromptOptions` changes. Full prompt replacement can
  change cache behavior. `context` excludes system/tool messages;
  `context_with_system` owns the full request transcript and must preserve a
  leading system message. Do not accidentally mutate stored history.
- `before_agent_start` also fires for `sendMessage(..., { triggerTurn: true })`
  runs. Check `event.messageType === "user"` before reading `prompt` or
  `images`; `"custom"` runs carry `message` instead.
- `agent_end` is not necessarily final. Actionable boundary continuations need
  a terminating condition; `agent_settled` is final and notification-only.
  In Pi 1.1.0, use `event.aborted` to identify cancelled runs at settlement;
  `ctx.signal` is not available there. A false `aborted` value does not prove
  provider success.
- Honor compaction cancellation and expose failures through its error callback
  or `session_compact_failed`. Avoid duplicate compaction requests.
  Since Pi 1.4, `compaction.reserveTokens` controls when compaction starts, not
  summary output length. Summaries use the model's output limit, reduced when
  needed to fit input and output in the context window; `generateSummary()` and
  `generateSummaryWithUsage()` ignore their `reserveTokens` argument.
  See installed `docs/compaction.md`.
- When the model registry owns streaming, let it resolve authentication and
  provider overrides for summaries and other model calls. Do not extract a
  stored authorization token and pass it back as an explicit key: Pi 1.5 fixes
  this distinction in native summaries. Raw streaming outside the registry can
  still need explicit authentication; do not remove it without tracing the call.
- Sibling tool calls can run concurrently; do not assume another result exists.
  `ctx.signal` may be absent outside a turn. Slow provider-stream handlers delay
  consumption; treat raw event data as read-only and never log credentials.

# Tools and Commands

Navigation for installed `docs/extensions.md`: read `Tools`, `Tool exposure`,
`Activate tools dynamically`, or `Context and session changes` as needed.
Verify signatures in installed declarations, not this navigation aid.
Example paths below are relative to `examples/extensions/`.

## Select the tool boundary

| Need | Native choice | Reference |
|---|---|---|
| Small model-callable operation | `registerTool`, narrow TypeBox schema | `hello.ts` |
| Data consumed by scripts | `outputSchema` + `structuredContent` | Installed `Tools` section |
| Orchestrate existing tools | `ctx.executeTool()`; list with `ctx.tools` | Installed `Tools` section |
| Reduce declarations or discover tools | `exposure`, `namespace` | Installed `Tool exposure` section |
| Deliberate active-set changes | `getActiveTools` / `setActiveTools` | `dynamic-tools.ts`, `tools.ts` |
| Bound large results | Pi truncation helpers | `truncated-tool.ts` |
| Override built-in behavior/rendering | Preserve original contract | `tool-override.ts`, `built-in-tool-renderer.ts` |

- `content` reaches the model; `details` supports rendering/state (use
  `undefined` when absent). For data tools, `structuredContent` must match
  `outputSchema`; scripts receive it rather than text. Redact both channels;
  replacing only `content` in a `tool_result` handler drops structured data.
- Throw for ordinary execution failures. Return `isError: true` when a failure
  must retain structured data. Error-looking text alone is still success.
- Nested calls use normal validation/interception but do not add transcript
  entries. Surface needed results in the parent result. Pi aggregates nested
  tool usage; do not count it twice. Report usage for the tool's own model calls.
- Honor cancellation. Use `pi.exec(command, args, { signal })` rather than shell
  assembly. Shared in-memory mutation may need sequential execution; file
  read-modify-write needs `withFileMutationQueue()` around the entire operation.
- Use `StringEnum` from `@earendil-works/pi-ai`, not literal unions for Google
  compatibility. Name the tool in each `promptGuidelines` bullet.
- Custom renderers must handle partial, absent, error, collapsed, and expanded
  results. `terminate: true` skips follow-up only when the whole batch agrees.

## Exposure before loaders

- `direct`: active tools are declared and callable.
- `model-only`: active tools are declared but cannot be called by other tools;
  use for orchestration or user interaction when appropriate.
- `codemode`: registered tools are callable and listed by codemode, without
  direct declarations unless explicitly activated.
- `deferred`: callable but not listed by codemode; tool search can activate it.
- `hidden`: unreachable; re-register with this exposure to withdraw a tool.

Direct/model-only registration activates the tool; other exposures do not.
Prefer these native policies over a custom discovery loader. When a loader is
required, register candidates first and merge selected names into the current
active set; unknown names are ignored. Changes reach the next model request.
Use `getAllTools()` metadata and `sourceInfo`, not name/path guesses. Tool
annotations are unverified hints, not authorization.

## Commands and messages

| Need | API | Example |
|---|---|---|
| User-only action; session replacement/reload | `registerCommand` | `reload-runtime.ts` |
| CLI configuration or shortcut | `registerFlag` / `getFlag`, `registerShortcut` | `preset.ts`, `plan-mode/index.ts` |
| Actual user turn | `sendUserMessage` | `send-user-message.ts` |
| Stored model-context message | `sendMessage` | `message-renderer.ts` |
| Durable non-model data | `appendEntry` | `entry-renderer.ts` |
| In-process signal, without persistence/replay | Namespaced `pi.events` | `event-bus.ts` |

Validate command arguments; choose message delivery and `triggerTurn`
deliberately. Session-changing operations are command-context-only: lifecycle
handlers can deadlock. After replacement, use the fresh `withSession` context;
after `await ctx.reload()`, do not reuse the old extension runtime.

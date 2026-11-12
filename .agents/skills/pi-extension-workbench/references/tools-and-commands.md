# Tools and Commands

Navigation for installed `docs/extensions.md`: read `Custom Tools`, `Tool Exposure`,
`Dynamic Tool Loading`, or `Session replacement lifecycle and footguns` as needed.
Verify signatures in installed declarations, not this navigation aid.
Example paths below are relative to `examples/extensions/`.

## Select the tool boundary

Use JSON Schema, the schema form for JavaScript Object Notation. TypeBox, the
schema builder, remains supported within that contract.

| Need | Native choice | Reference |
|---|---|---|
| Small model-callable operation | `registerTool`, narrow JSON Schema | `hello.ts` |
| Data consumed by scripts | `outputSchema` + `structuredContent` | Installed `Custom Tools` section |
| Orchestrate existing tools | `ctx.executeTool()`; list with `ctx.tools`; declare `reachesTools` | Installed `Calling Other Tools` and `Tool Exposure` sections |
| Reduce declarations or discover tools | `exposure`, `namespace` | Installed `Tool Exposure` section |
| Deliberate active-set changes | `getActiveTools` / `setActiveTools` | `dynamic-tools.ts`, `tools.ts` |
| Bound large results | Pi truncation helpers | `truncated-tool.ts` |
| Override built-in behavior/rendering | Preserve original contract | `tool-override.ts`, `built-in-tool-renderer.ts` |

- `content` reaches the model; `details` supports rendering/state (use
  `undefined` when absent). For data tools, `structuredContent` must match
  `outputSchema`; scripts receive it rather than text. Redact both channels;
  replacing only `content` in a `tool_result` handler drops structured data.
- Throw for ordinary execution failures. Return `isError: true` when a failure
  must retain structured data. Error-looking text alone is still success.
- Pi 1.3 rejects malformed completed tool-call arguments before execution.
  Use native argument validation; do not execute partially parsed arguments.
  Custom providers and message transforms must preserve `ToolCall.argumentsError`.
- Pi 1.5 validates all tool arguments with `@earendil-works/pi-schema`, including
  plain JSON Schema. Native coercion converts numeric strings and booleans,
  wraps single values as arrays, and drops optional nulls when null is not allowed.
  Errors use messages such as `- path: missing`. TypeBox schemas still work,
  but `Type.Refine()` and `Format.Set()` checks do not run; codecs do not decode.
  Pi 1.5.1 and later convert `Type.BigInt()` and `Type.Undefined()` arguments;
  `Type.Void()` rejects every argument. Earlier Pi 1.5 releases reject all three.
  Put required semantic checks in `execute()`; keep domain and authorization
  validation. See installed `Tool parameter schemas and TypeBox`.
- In Pi 1.5.1 and later, `GrepOperations.readFile` is ignored; remote grep
  requires an `execute()` override. Custom `ReadOperations.createReadStream`
  enables bounded-memory text reads; without it, `readFile` loads the file.
- Nested calls use normal validation/interception but do not add transcript
  entries. Surface needed results in the parent result. Pi aggregates nested
  tool usage; do not count it twice. Report usage for the tool's own model calls.
  Preserve optional `Usage.cost.totalFromProvider`; a combined total is
  provider-reported only when every part is provider-reported.
- Honor cancellation. Use `pi.exec(command, args, { signal })` rather than shell
  assembly. Shared in-memory mutation may need sequential execution; file
  read-modify-write needs `withFileMutationQueue()` around the entire operation.
- For bounded command capture, use native `pi.exec()` with `maxBuffer`, the
  combined stdout/stderr byte limit. It must be a nonnegative integer within
  the runtime string limit; the default is 256 mebibytes, capped by that limit.
  Overflow returns incomplete output, `truncated: true`, `killed: true`, and a
  nonzero `code`. Reject incomplete output; `killed` alone can also mean timeout
  or cancellation. Test doubles of `ExecResult` must include `truncated`.
  Pi preserves characters split across output chunks and reports spawn errors
  in stderr. After timeout or abort, it forces termination after five seconds
  if the initial termination signal did not stop the child.
  Native execution has no standard-input option, separate stream limits, tail
  capture, or process-group cancellation; keep such distinct process contracts.
- Use a plain string `enum` schema, not literal unions, for Google compatibility.
  In host-loaded extensions, `StringEnum` from `@earendil-works/pi-ai` supplies
  this schema. For shared code that also uses TypeBox outside Pi, verify the
  standalone types or use `Type.Enum(values, { type: "string" })`.
  Name the tool in each `promptGuidelines` bullet.
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

Direct/model-only registration activates the tool unless `defaultActive: false`;
other exposures do not. `prepareLoadout` can hide declarations without changing
the active set or tool exposure; it is not an authorization boundary.
Prefer these native policies over a custom discovery loader. When a loader is
required, register candidates first and merge selected names into the current
active set; unknown names are ignored. Changes reach the next model request.
Use `getAllTools()` metadata and `sourceInfo`, not name/path guesses. Tool
annotations are unverified hints, not authorization.

Pi 1.3 restores active tools from the session transcript on resume. A `--tools`
list with only `+name`/`-name` entries modifies that restored selection. Plain
names in `--tools`, `--no-tools`, or `--no-builtin-tools` select tools explicitly
instead. Use native restoration, not a custom resume hook; keep separate
Role or authorization restrictions. Pi 1.4 also activates newly registered
tools that the branch never added or removed, unless `defaultActive: false`.
Pi 1.5 keeps the order of tools that stay active and appends newly active tools;
reordering the same set does not cause a prompt update.

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
deliberately. A starting run counts as busy, also during
`before_agent_start`: `ctx.isIdle()` is false, `sendMessage` queues into that
run, and `sendUserMessage` needs `deliverAs`. Session-changing operations are
command-context-only: lifecycle handlers can deadlock. After replacement, use the fresh `withSession` context;
after `await ctx.reload()`, do not reuse the old extension runtime.

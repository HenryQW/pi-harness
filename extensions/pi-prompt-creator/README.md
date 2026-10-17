# `@henryqw/pi-prompt-creator`

Turn repeated requests or corrections in the Current Conversation into a reviewed global Pi prompt. A child with no tools drafts one Prompt Candidate. Main and the user control Prompt Review and the save.

Automatic analysis only prepares a Prompt Candidate. The extension never saves it without your approval.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-prompt-creator
```

Run `/task-models` before analysis. Assign a model to `fast`, or override `pi-prompt-creator/draft`. Open `/task-models` again. Verify the saved route or task assignment.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides the isolated draft model route. |

## Use

Run `/promptor` in the interactive TUI after a repeated request or correction appears:

1. Run `/promptor`. The completed Prompt Candidate appears automatically.
2. Ask Main to refine it. Ask Main to return only the complete Final Prompt Draft.
3. Run `/promptor save` to save under the suggested name. Alternatively, run `/promptor save <name>` to rename it.

The extension creates the prompt at `~/.pi/agent/prompts/<name>.md`. Then Pi reloads its resources. You do not need a selection menu or name prompt.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/promptor [analyze|dismiss|save [name]|automatic <on\|off>]` | command | For users in the interactive TUI: start or show analysis, dismiss a pending candidate, save a reviewed prompt, or control automatic analysis. |
| `pi-prompt-creator/draft` | task | For users who configure `/task-models`: choose the child model and thinking level for the draft. |
| Analysis status widget and candidate message | ui | Show analysis progress, readiness, or failure. A displayed candidate is marked as untrusted. |

## Flow

![Automatic prompt analysis waits for user display before Main review and approved saving; manual candidates display immediately](./docs/prompt-lifecycle.svg)

The diagram shows the automatic path. Manual analysis displays its candidate immediately, without the WAIT stage. Both paths require Main review and your approval before the save.

### Automatic analysis

Automatic mode waits for the configured number of non-empty user inputs. The default is three.

It starts at the next idle `agent_settled` event that is not aborted. It starts at most one time per extension runtime.

An aborted run does not start automatic analysis. It keeps the input count and permits later automatic analysis. A later normal settlement can start analysis if it meets the conditions. `aborted: false` does not prove that the provider completed successfully.

Explicit `/promptor analyze` remains available after cancellation. A manual analysis prevents later automatic analysis in that extension runtime.

Branch changes reset the input counter. Automatic analysis and Prompt Candidate widgets require the interactive TUI.

Only one analysis can run at a time. A pending Prompt Candidate blocks another analysis.

Manual and automatic analysis send Pi's current model-visible session context to the child model that you configure through `/task-models`. Analysis applies session context edits that omit or replace messages. It does not send original text that these edits removed from model context to the child. It does not include request-local `context` and `context_with_system` transformations.

The payload includes the active compaction or branch summary, user text, successfully completed assistant text, and effective prompt names and descriptions.

The extension disables project context files and prompt templates for the child. It excludes tool traffic, thinking, images, custom messages, and inactive branches.

Analysis asks a child with no tools for one JSON response. The child has no user extensions, Skills, or saved session. The extension does not try failed analysis again.

New user input does not stop a running child. Branch navigation discards its old result without stopping the child.

### Review and save

A manually requested analysis displays its completed Prompt Candidate immediately. Automatic analysis shows a running widget. It then keeps a completed Prompt Candidate behind the `Prompt ready — /promptor` widget until you run `/promptor` or `/promptor dismiss`. Background work never interrupts the conversation.

The extension displays Prompt Candidates as visible messages that it marks as untrusted.

Refine the Prompt Candidate with Main. Ask Main to return only the complete Final Prompt Draft. Then save it with `/promptor save [name]`.

You can save only after you show a Prompt Candidate and Main then completes a valid Markdown review reply. The save uses that latest retained Main reply as the entire file. You cannot save replies before the active compaction or branch summary.

You cannot save an interrupted, failed, empty, or tool-use reply. The extension never uses an older reply instead.

A successful save ends that Prompt Review. Show another Prompt Candidate. Complete another Main review reply before you save again.

`/promptor save` uses the suggested Prompt Candidate name. Pass `/promptor save <name>` to choose another. Names must be lowercase kebab-case, start with a letter, and contain at most 64 ASCII characters. The extension rejects existing command names and prompt files.

A successful save reloads Pi resources. If reload fails, the prompt remains saved and `/reload` can load it.

### Model routing

The extension registers `pi-prompt-creator/draft`. Its default task profile is `fast`.

Use `/task-models` to select the model and thinking level. The extension owns no model configuration. At session start and before each analysis, it shows each problem in the shared task-model config one time in each session.

## Config

Package-owned: `~/.pi/agent/config/pi-prompt-creator/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `automatic` | Runs automatic analysis after enough user inputs. | Boolean. | `true` |
| `inputThreshold` | Sets the number of non-empty user inputs before automatic analysis. | Positive safe integer (`1`–`9007199254740991`). | `3` |

Edit either field. Then run `/reload` to apply the change. Omitted fields use their defaults.

A missing file quietly uses both defaults. Startup never creates or rewrites the file.

At session start, Pi shows a warning for an unknown key or an invalid value. The warning includes the file path and each problem. Pi ignores the unknown key. A misspelled key near a missing field, such as `automatc`, counts as an invalid value of that field. An invalid `inputThreshold` uses the default `3`.

Automatic analysis stays off for the session when `automatic` is invalid or misspelled. It also stays off when the file has malformed JSON, invalid UTF-8, more than 64 KiB, a read error, or a non-object root. Startup leaves the file unchanged.

Only `/promptor automatic on` or `/promptor automatic off` writes the config. A toggle reads the file again and keeps its current `inputThreshold`, also when another session changed it. A toggle also replaces a file with problems. It first shows the problems, then keeps the usable values and removes unknown keys. If another session changes that file before the write, the toggle stops and writes nothing.

## State and storage

A pending Prompt Candidate stays in memory only. The extension saves automatic mode, but not counters or Prompt Candidates.

Saved prompts are at `~/.pi/agent/prompts/<name>.md`. A save never replaces an existing file.

## Limits and recovery

The child payload stays within 30,000 characters, including its JSON envelope and prompt metadata.

It gives priority to the active summary, then to the newest complete messages. It omits excess prompt metadata before conversation context.

Analysis can omit old messages. It never cuts individual messages.

Generated Prompt Candidate names use lowercase kebab-case and stay within 64 ASCII characters.

Prompt Candidate and Final Prompt Draft Markdown must be non-empty and at most 16 KiB.

The extension rejects NUL and other terminal controls in Prompt Candidate and saved Markdown. It permits ordinary tabs and line feeds.

If analysis finds no Prompt Candidate, the running widget clears without a notice. Invalid output or child failure shows `Prompt analysis failed — /promptor`. The extension does not automatically try failed analysis again. Run `/promptor` or `/promptor analyze` to start again.

The failure widget clears after the next non-empty user input. Analysis has a two-minute idle timeout and five-minute hard timeout.

This package does not search past sessions. It does not create Skills or project-local runtime state.

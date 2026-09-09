# `@henryqw/pi-prompt-creator`

Turn repeated requests or corrections in the current conversation into a reviewed global Pi prompt. A tool-free child drafts one candidate, while Main and the user control review and saving.

Nothing is shown or saved until you choose it.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-prompt-creator
```

Run `/task-models` before analysis. Assign a model to `fast`, or override `pi-prompt-creator/draft`. Open `/task-models` again and verify the saved route or task assignment.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides the isolated draft model route. |

## Use

Run `/promptor` in the interactive TUI after a repeated request or correction appears:

1. Run `/promptor`. The completed candidate appears automatically.
2. Ask Main to refine it and return only the complete Final Prompt Draft.
3. Run `/promptor save` to save under the suggested name, or `/promptor save <name>` to rename it.

The prompt is created at `~/.pi/agent/prompts/<name>.md`, then Pi reloads its resources. No selection menu or name prompt is required.

| Command | Action |
| --- | --- |
| `/promptor` | Start analysis, or show a candidate prepared by automatic analysis. |
| `/promptor analyze` | Analyze again after a candidate has been reviewed or dismissed. |
| `/promptor save [name]` | Save Main's newest completed review reply, using the suggested name by default. |
| `/promptor dismiss` | Forget a candidate prepared by automatic analysis. |
| `/promptor automatic <on\|off>` | Enable or disable automatic analysis. |

## Flow

![Prompt creator lifecycle from conversation to saved prompt](./docs/prompt-lifecycle.svg)

### Automatic analysis

Automatic mode waits for the configured number of non-empty user inputs. The default is three.

It starts at the next idle `agent_settled` event. It starts at most once per extension runtime.

A manual analysis consumes that opportunity.

Branch changes reset the input counter. Automatic analysis and candidate widgets require the interactive TUI.

Only one analysis can run at a time. A pending candidate blocks another analysis.

Automatic analysis sends the current conversation to the child model configured through `/task-models`.

Its payload includes the active compaction or branch summary, user text, successfully completed assistant text, and effective prompt names and descriptions.

Project context files and prompt templates are disabled for the child. Tool traffic, thinking, images, custom messages, and inactive branches are excluded.

Analysis asks a tool-free child for one JSON response. It has no user extensions, Skills, or saved session. The extension does not retry failed analysis.

New user input does not stop a running child. Branch navigation discards its old result without stopping the child.

### Review and save

A manually requested analysis displays its completed candidate immediately. Automatic background analysis keeps its candidate behind the `Prompt ready — /promptor` widget until you run `/promptor` or `/promptor dismiss`, so background work never interrupts the conversation.

Displayed candidates are visible messages marked as untrusted.

Refine the candidate with Main. Ask Main to return only the complete Final Prompt Draft before saving it with `/promptor save [name]`.

The save item appears only after you show a candidate and Main then completes a valid Markdown review reply.

Saving uses that latest retained Main reply as the entire file. Replies before the active compaction or branch summary cannot be saved.

An interrupted, failed, empty, or tool-use reply cannot be saved. The extension never falls back to an older reply.

A successful save ends that review. Show another candidate and complete another Main review reply before saving again.

The menu asks for a lowercase kebab-case name. A candidate name appears only as a hint.

Names start with a letter and contain at most 64 ASCII characters. Existing command names and prompt files are rejected.

A successful save reloads Pi resources. If reload fails, the prompt remains saved and `/reload` can load it.

### Model routing

The extension registers `pi-prompt-creator/draft`. Its default task profile is `fast`.

Use `/task-models` to select the model and thinking level. The extension owns no model configuration.

## Config

Package-owned: `~/.pi/agent/config/pi-prompt-creator/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `automatic` | Runs automatic analysis after enough user inputs. | Boolean. | `true` |
| `inputThreshold` | Sets the number of non-empty user inputs before automatic analysis. | Positive integer. | `3` |

Edit either field, then run `/reload` to apply the change. Omitted fields use their defaults.

A missing file quietly uses both defaults. Startup never creates or rewrites the file.

Malformed config or unknown keys disable automatic analysis. Pi warns once and leaves the file unchanged.

Only `Automatic On` or `Automatic Off` writes the config. Toggling preserves the configured threshold.

## State and storage

A pending candidate stays in memory only. Automatic mode persists, but counters and candidates do not.

Saved prompts live at `~/.pi/agent/prompts/<name>.md`. Saving never replaces an existing file.

## Limits and recovery

The child payload stays within 30,000 characters, including its JSON envelope and prompt metadata.

It prioritizes the active summary, then the newest complete messages. It omits excess prompt metadata before conversation context.

Old messages may be omitted. Individual messages are never cut.

Generated candidate names use lowercase kebab-case and stay within 64 ASCII characters.

Candidate and Final Prompt Draft Markdown must be non-empty and at most 16 KiB.

Candidate and saved Markdown reject NUL and other terminal controls. Ordinary tabs and line feeds are allowed.

No candidate clears the running widget without a notice. Invalid output or child failure shows `Prompt analysis failed — /promptor`.

The failure widget clears after the next non-empty user input. Analysis has a two-minute idle timeout and five-minute hard timeout.

This package does not search past sessions. It does not create Skills or project-local runtime state.

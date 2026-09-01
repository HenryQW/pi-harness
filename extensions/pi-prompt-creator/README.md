# `@henryqw/pi-prompt-creator`

Turn repeated requests or corrections in the current conversation into one reusable prompt candidate.

You decide whether to show, refine, and save it.

## Why

- **Created for**: Pi users who repeat requests or corrections and want a reusable prompt.
- **Advantage**: It isolates drafting in a tool-free child and saves only after explicit review.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-prompt-creator
```

Run `/task-models` before analysis. Assign a model to `fast`, or override `pi-prompt-creator/draft`.

## Use

Run `/promptor` in the interactive TUI.

The menu adapts to the current state:

| Item | Action |
| --- | --- |
| `Analyze now` or `Analyze again` | Start one visible background analysis. |
| `Automatic On` or `Automatic Off` | Save the automatic setting. |
| `Show candidate` | Add the candidate to the conversation for review. |
| `Dismiss candidate` | Forget the pending candidate. |
| `Save latest Main draft` | Save Main's newest completed review reply after you show a candidate. |

Only one analysis can run at a time. A pending candidate blocks another analysis.

Analysis uses a one-turn child with no base tools, user extensions, Skills, or saved session. The extension does not retry failed analysis.

New user input does not stop a running child. Branch navigation discards its old result without stopping the child.

## Config

`~/.pi/agent/config/pi-prompt-creator/config.json`

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `automatic` | Yes | `true` or `false` | `false` |
| `inputThreshold` | No | Positive integer | `3` |

Edit `inputThreshold`, then run `/reload` to apply the change.

A missing file quietly uses both defaults. Startup never creates or rewrites the file.

Malformed config or unknown keys disable automatic analysis. Pi warns once and leaves the file unchanged.

Only `Automatic On` or `Automatic Off` writes the config. Toggling preserves the configured threshold.

## Flow

![Prompt creator lifecycle from conversation to saved prompt](./docs/prompt-lifecycle.svg)

## Privacy

Analysis sends the current conversation to the child model configured through `/task-models`.

The payload includes the active compaction or branch summary, user text, and successfully completed assistant text. It also includes effective prompt names and descriptions.

Project context files and prompt templates are disabled for the child.

Tool traffic, thinking, images, custom messages, and inactive branches are excluded.

Automatic analysis is off by default. It starts only after you enable it through `/promptor`.

## Automatic mode

Automatic mode waits for the configured number of non-empty user inputs. The default is three.

It starts at the next idle `agent_settled` event. It starts at most once per extension runtime.

A manual analysis consumes that opportunity. Automatic mode persists, but counters and candidates do not.

Branch changes reset the input counter. Automatic analysis and candidate widgets require the interactive TUI.

## Review and save

A completed candidate stays in memory. The widget shows `Prompt ready — /promptor` until you show or dismiss it.

The extension never injects a candidate automatically. `Show candidate` adds one visible message and marks its contents as untrusted.

Refine the candidate with Main. Ask Main to return only the complete Final Prompt Draft before saving.

The save item appears only after you show a candidate and Main then completes a valid Markdown review reply.

Saving uses that latest retained Main reply as the entire file. Replies before the active compaction or branch summary cannot be saved.

An interrupted, failed, empty, or tool-use reply cannot be saved. The extension never falls back to an older reply.

A successful save ends that review. Show another candidate and complete another Main review reply before saving again.

The menu asks for a lowercase kebab-case name. A candidate name appears only as a hint.

Names start with a letter and contain at most 64 ASCII characters. Existing command names and prompt files are rejected.

Prompts are created at `~/.pi/agent/prompts/<name>.md`. Creation never replaces a file.

A successful save reloads Pi resources. If reload fails, the prompt remains saved and `/reload` can load it.

## Model routing

The extension registers `pi-prompt-creator/draft`. Its default task profile is `fast`.

Use `/task-models` to select the model and thinking level. The extension owns no model configuration.

## Limits and failures

The child payload stays within 30,000 characters, including its JSON envelope and prompt metadata.

It prioritizes the active summary, then the newest complete messages. It omits excess prompt metadata before conversation context.

Old messages may be omitted. Individual messages are never cut.

Generated candidate names use lowercase kebab-case and stay within 64 ASCII characters.

Candidate and Final Prompt Draft Markdown must be non-empty and at most 16 KiB.

Candidate and saved Markdown reject NUL and other terminal controls. Ordinary tabs and line feeds are allowed.

No candidate clears the running widget without a notice. Invalid output or child failure shows `Prompt analysis failed — /promptor`.

The failure widget clears after the next non-empty user input. Analysis has a two-minute idle timeout and five-minute hard timeout.

This package does not search past sessions. It does not create Skills or project-local runtime state.

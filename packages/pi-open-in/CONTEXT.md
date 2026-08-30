# Pi Open In

## Language

**Open command**:
The `/open` Pi command that launches configured command for current working directory.
_Avoid_: editor command, project opener

**Open command configuration**:
User config at `getAgentDir()/config/pi-open-in/config.json` selecting executable launched by `/open`; `/set-open-in <command>` updates it. A missing file silently defaults to `code` without being created. An existing file must be an object with exactly one non-empty string `command`; anything else makes `/open` fail visibly without touching the file. Command string is split on whitespace; tokens with spaces unsupported.
_Avoid_: project config, editor preference

**Current working directory**:
Pi session path passed to configured command by `/open`.
_Avoid_: process directory, repository root

**Open URI**:
Safe editor URI derived only when the open command executable is `code`, with or without flags; maps current working directory to `vscode://file/...`. The `-n` and `--new-window` flags map to the VS Code protocol's `windowId=_blank` query. Arbitrary configured commands cannot become OSC 8 links.
_Avoid_: command link, shell URI

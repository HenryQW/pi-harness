# Pi Open In

## Language

**Open command**:
The `/open` Pi command that launches configured command for current working directory.
_Avoid_: editor command, project opener

**Open command configuration**:
User config selecting executable launched by `/open`; `/set-open-in <command>` updates it, defaulting to `code` when the file is missing. An existing file must be an object with exactly one non-empty string `command`; anything else makes `/open` fail visibly without touching the file. Command string is split on whitespace; tokens with spaces unsupported.
_Avoid_: project config, editor preference

**Current working directory**:
Pi session path passed to configured command by `/open`.
_Avoid_: process directory, repository root

**Open URI**:
Safe editor URI derived only when open command is exactly `code`; maps current working directory to `vscode://file/...`. Arbitrary configured commands cannot become OSC 8 links.
_Avoid_: command link, shell URI

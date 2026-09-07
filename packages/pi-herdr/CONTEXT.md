# Pi Herdr

Pi Herdr provides shared process-level access to Herdr CLI while callers retain orchestration and command-specific response validation.

## Language

**Herdr Client**:
Thin wrapper binding one command executor to `herdr`, with raw, successful-text, and JSON-object execution modes.
_Avoid_: Herdr SDK, socket client, orchestration client

**Herdr Executor**:
Caller-supplied command function used by Herdr Client, preserving caller ownership of process execution, cwd, cancellation, and tests.
_Avoid_: Process manager, transport

**Herdr Pi-Agent Launcher**:
Small helper for the shared `agent start --kind pi --pane ... --` boundary and bounded structured pane-busy retry; callers still own Pi arguments and response/lifecycle semantics.
_Avoid_: Generic agent lifecycle framework, command catalog

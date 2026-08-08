# Pi Codex Accounts

This package enrolls multiple OpenAI Codex subscriptions through Pi while
keeping Pi as the owner of authentication and model persistence.

## Language

**Codex account**:
One authenticated OpenAI Codex subscription represented by native
`openai-codex` (A1) or a numbered `openai-codex-account-N` alias.

**Usage snapshot**:
Credential-free, time-stamped allowance data cached for one Codex account.

**Effective allowance**:
The lowest remaining percentage among an account's non-expired allowance
windows.

**Available account**:
An authenticated account with unknown allowance or known effective allowance
above 0%.

**Automatic routing**:
Selection of an available Codex account at the next agent-run boundary using
the latest usable snapshots.

**Manual switch**:
An explicit account selection through Pi model controls or
`/codex-accounts next`; it disables automatic routing for the current session.

**Agent run**:
The complete Pi agent loop beginning at `before_agent_start` and ending after
provider turns, tool calls, retries, and follow-ups settle.

Avoid “automatic summarization,” “retry,” or “restart” for these concepts; they
belong to the `pi-auto-compact` context.

# Flagless, conflict-only PR routing

## Decision

`/pr` accepts no flags or instructions. Validated branch configuration or the `origin` default selects a creation base. The command routes each guarded next step from fresh discovery and continues after a completed terminal helper action within the same invocation. On an open PR, intended dirty or ahead local work is scoped, committed, validated and published before other conditions. A base reported BEHIND does not trigger a rebase; a confirmed merge conflict does. Conflict rebases use the exact pinned base OID and one remote-OID force-with-lease push. Ambiguous conflict intent remains with the user.

Feedback discovery includes new or changed standalone conversation and review comments. The finalized sweep writes an attention marker after guarded completion. The marker is independent of the existing recoverable sweep file: malformed recovery and malformed markers remain untouched. After publication the active invocation rediscovers fresh GitHub state; a prior mergeability or CI snapshot is never authority for a new head.

## Consequences

This supersedes the base-BEHIND update and conversation-comment exclusions in ADR 0001. One invocation may complete multiple routes, but each must finish before fresh rediscovery selects another. A repeated route, incomplete helper, ambiguous mutation, declined approval, or external wait stops continuation. One feedback triage/fix cycle and one CI fix cycle are allowed per invocation. A successful push is never merge approval: the direct merge still asks for confirmation and revalidates.

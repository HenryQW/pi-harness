# Sweep recovery

The workflow owns one private, bounded (1 MiB), atomically replaced, versioned file per canonical worktree:

```text
<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json
```

It contains frozen PR authority, original head and exact lease, complete feedback, disposition ledger, owned paths, and mutation attempts. Run `/pr` for fresh route discovery: absent recovery selects `start`; matching valid recovery selects `resume`. Direct skill or tool calls cannot establish route authority.

Resume rechecks worktree, local changes, PR linkage, and remote head under lock, reconciles attempted mutations, then issues a new epoch and run ID. After publication, a moved base OID is tolerated only when base repository/ref and the exact published head remain fixed. `refresh` rechecks authority around complete feedback collection and binds the new base; later resolution/finalization cannot inherit a base-drift exception.

A post-publish `refresh` retains decisions for identical items, classifies new or edited actionable items as blocked for the next fix cycle, and saves an exact projection. Existing `refresh-pending` recovery can still use `show` and `record` to cover its frozen snapshot. No repeat approval is required. Resuming a recorded plan uses its saved ledger and owned paths, never a reconstructed plan; new sweeps start at the original clean HEAD.

A returned reply ID is saved before the verifying fetch; recovery can verify that exact ID and body without replaying the mutation. A lost response without a saved ID remains ambiguous even if a matching comment appears: stop without replaying or resolving. Malformed, oversized, obsolete, wrong-worktree, or route-mismatched recovery is preserved and blocks dispatch. Never repair, move, replace, or delete it automatically; report its path and blocker.

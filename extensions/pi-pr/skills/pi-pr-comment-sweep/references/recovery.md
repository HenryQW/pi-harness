# Sweep recovery

The workflow owns one private, bounded (1 MiB), atomically replaced, versioned file per canonical worktree:

```text
<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json
```

It contains frozen PR authority, original head and exact lease, complete feedback, disposition ledger, owned paths, and mutation attempts. Run `/pr` for fresh route discovery: absent recovery selects `start`; matching valid recovery selects `resume`. Direct skill or tool calls cannot establish route authority.

Resume rechecks worktree, local changes, PR linkage, and remote head under lock, reconciles attempted mutations, then issues a new epoch and run ID. Movement of the same base branch's tip alone does not block initial planning, scoped commits/publication, or recovery: base repository/ref, PR identity, destination, and the exact expected remote head/lease must still match. The frozen feedback/base, ledger, and owned paths remain intact. This does not permit replaying an uncertain mutation. After publication, `refresh` rechecks authority around complete feedback collection and binds the current base; later resolution/finalization cannot inherit a base-drift exception. A base that moves during collection preserves recovery and stops that refresh.

A recorded sweep with no pending or uncertain mutation may resume after a manual publication. Read-only discovery verifies unchanged PR/repository/ref linkage, a clean local HEAD equal to the live remote, descent from the original HEAD, and changes confined to owned paths. `resume` repeats those checks under lock and records the observed head as published without pushing, deleting recovery, or discarding the ledger. Continue with `refresh` before resolving; a moved base is rebound there. Dirty, unowned, divergent, or uncertain outcomes still block and preserve recovery.

A post-publish `refresh` retains decisions for identical items, classifies new or edited actionable items as blocked for the next fix cycle, and saves an exact projection. Existing `refresh-pending` recovery can still use `show` and `record` to cover its frozen snapshot. No repeat approval is required. Resuming a recorded plan uses its saved ledger and owned paths, never a reconstructed plan; new sweeps start at the original clean HEAD.

The `commit` action saves its parent HEAD and staged tree before running Git. A lost result blocks further commits and publication until `resume`: an unchanged HEAD permits a fresh commit attempt, while exactly one commit with the saved parent and tree is accepted without replay. A different history or committed tree (including hook changes) preserves recovery and stops for inspection. Older recovery without a commit attempt remains resumable.

A returned reply ID is saved before the verifying fetch; recovery can verify that exact ID and body without replaying the mutation. A lost response without a saved ID remains ambiguous even if a matching comment appears: stop without replaying or resolving. Malformed, oversized, obsolete, wrong-worktree, or route-mismatched recovery is preserved and blocks dispatch. Never repair, move, replace, or delete it automatically; report its path and blocker.

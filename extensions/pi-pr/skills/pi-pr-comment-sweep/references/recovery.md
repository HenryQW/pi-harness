# Sweep recovery

The workflow owns one versioned recovery file for each canonical worktree:

```text
<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json
```

The file is private, bounded to 1 MiB, and replaced atomically. It contains the
frozen PR authority, original head and lease, complete feedback, exact ledger,
owned paths, and mutation attempts.

Run `/pr` to enter recovery. After fresh route discovery, `/pr` checks this file
without changing it. It selects `start` when the file is absent. It selects
`resume` only when valid recovery matches the fresh route authority.

Resume checks the canonical worktree, local changes, PR linkage, and remote
head again under its lock. It reconciles an attempted push or thread resolution
before issuing a new epoch and run ID. Calls from the old run then fail. Direct
skill or tool calls cannot create route authority.

A completed post-publish `refresh` stores the new complete snapshot before any
replacement ledger. Recovery keeps that snapshot in `refresh-pending`, with its
new generation and fingerprint. Its status exposes only item IDs and kinds.
Use `show` with the resumed guard to inspect each frozen item. Then use `record`
without `ownedPaths` to supply exact complete coverage for that snapshot.
Resolution and finalization remain blocked until this record succeeds.

Malformed, oversized, obsolete, wrong-worktree, or route-mismatched recovery is
preserved and blocks dispatch. Never repair, move, replace, or delete it
automatically. Report the state path and exact blocker.

An unknown mutation is never replayed. If reconciliation cannot prove its exact
result, stop and report the state path and blocker.

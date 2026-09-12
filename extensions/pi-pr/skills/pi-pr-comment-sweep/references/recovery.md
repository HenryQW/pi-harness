# Sweep recovery

The workflow owns one versioned recovery file for each canonical worktree:

```text
<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json
```

The file is private, bounded to 1 MiB, and replaced atomically. It contains the
frozen PR authority, original head and lease, complete feedback, exact ledger,
owned paths, and mutation attempts.

Use `resume` when this file exists. Resume checks the canonical worktree, local
changes, PR linkage, and remote head. It reconciles an attempted push or thread
resolution before issuing a new epoch and run ID. Calls from the old run then
fail.

A completed post-publish `refresh` stores the new complete snapshot before any
replacement ledger. Recovery keeps that snapshot in `refresh-pending`, with its
new generation and fingerprint. Its status exposes only item IDs and kinds.
Use `show` with the resumed guard to inspect each frozen item. Then use `record`
without `ownedPaths` to supply exact complete coverage for that snapshot.
Resolution and finalization remain blocked until this record succeeds.

Malformed or oversized recovery is preserved and blocks the workflow. Never
repair, move, replace, or delete it automatically. An unknown mutation is never
replayed. If reconciliation cannot prove its exact result, stop and report the
state path and blocker.

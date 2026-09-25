# Sweep recovery

The workflow owns one versioned recovery file for each canonical worktree:

```text
<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json
```

The file is private, bounded to 1 MiB, and replaced atomically. It contains the
frozen PR authority, original head and lease, complete feedback, exact ledger,
approval, owned paths, and mutation attempts.

Run `/pr` to enter recovery. After fresh route discovery, `/pr` checks this file
without changing it. It selects `start` when the file is absent. It selects
`resume` only when valid recovery matches the fresh route authority.

Resume checks the canonical worktree, local changes, PR linkage, and remote
head again under its lock. After publication it tolerates a moved base OID
only while the base repository/ref and exact published head remain fixed.
`refresh` then rechecks the new base on both sides of feedback collection and
saves it with the new snapshot; resolution and finalization do not inherit
this exception. It reconciles an attempted push, review-thread reply,
or resolution before issuing a new epoch and run ID. Calls from the old run then
fail. Direct
skill or tool calls cannot create route authority.

A completed post-publish `refresh` stores the new complete snapshot before any
replacement ledger. Recovery keeps that snapshot in `refresh-pending`, with its
new generation and fingerprint. Its status exposes only item IDs and kinds.
Use `show` with the resumed guard to inspect each frozen item. Then use `record`
without `ownedPaths` to supply exact complete coverage for that snapshot.
Resolution and finalization remain blocked until this record succeeds and the user approves the refreshed plan again. An old approval never authorizes changed feedback decisions.

Malformed, oversized, obsolete, wrong-worktree, or route-mismatched recovery is
preserved and blocks dispatch. Never repair, move, replace, or delete it
automatically. Report the state path and exact blocker.

A recorded plan needs user approval before publication. Resume returns the
saved ledger and owned paths, and approval displays that exact plan. Approval
survives a resume; if declined, show the saved plan and ask again. Version-one
recovery with existing owned work can be approved with an explicit warning;
new sweeps require the original clean HEAD before and after confirmation.

An unknown mutation is never replayed. A same-body new reply cannot prove who
posted it, so a lost reply response blocks recovery rather than resolving the
thread. Report the preserved state path and blocker.

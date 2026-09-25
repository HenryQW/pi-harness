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
Resolution and finalization remain blocked until this record succeeds.

Malformed, oversized, obsolete, wrong-worktree, or route-mismatched recovery is
preserved and blocks dispatch. Never repair, move, replace, or delete it
automatically. Report the state path and exact blocker.

A recorded plan needs user approval before publication. Resume returns the
saved ledger and owned paths, and approval displays that exact plan. Approval
survives a resume; if declined, show the saved plan and ask again. Version-one
recovery with existing owned work can be approved with an explicit warning;
new sweeps require the original clean HEAD before and after confirmation.

An unknown mutation is never replayed. The reply mutation returns a GitHub
comment ID; when it is observed, the helper verifies that ID on the intended
thread. If other feedback changes at the same time, it preserves the confirmed
reply ID across `refresh` and requires fresh triage before resolving. The
helper verifies that same ID and body on the thread instead of reposting it.

If the mutation response was lost, a same-body comment cannot prove who posted
it. After an ambiguous `resume`, `recover-reply` shows the one live candidate
absent from the frozen snapshot, including its ID, author, time, URL, and body.
Only explicit operator confirmation marks that attempt applied. It rechecks the
candidate and full live fingerprint under the lock, sends no GitHub mutation,
and then requires `refresh` and fresh triage. Older refreshed recovery may have
lost an applied reply receipt: after recording the complete fresh feedback,
`recover-reply` can explicitly attest to one existing commit-link comment on
an unresolved addressed thread. It stores that exact comment ID before
`resolve`, without reposting. If the comment is absent, multiple candidates
match, the evidence changes, or the operator cannot attest to it, leave the
recovery file untouched and report the blocker. Never delete or edit recovery
by hand.

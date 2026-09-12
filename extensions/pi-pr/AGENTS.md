# Pi PR instructions

## Git authority

- Treat the configured push target as branch authority. Parse validated `%(push:short)` against configured remote names. Do not derive the destination ref from the local branch name or depend on `%(push:remoteref)`, which may be empty for inferred targets.
- After validation, capture the exact commit OID and use that OID as the push refspec source. Immediately before pushing, require local `HEAD` to remain equal to the captured OID and revalidate the saved destination and PR identity.
- An empty `git status --porcelain=v1 --untracked-files=all` result is not enough to prove safety. Reject in-progress merge, rebase, cherry-pick, revert, and sequencer state. Resolve Git state paths through Git so linked worktrees work.

## GitHub authority

- Discover current pull requests through the validated repository ref's GraphQL `associatedPullRequests` connection. Do not use global issue search: branch-only `head:<branch>` is unbounded, while `head:<owner>:<branch>` is not valid there. Validate every candidate repository, ref, and OID.
- Paginate every GitHub endpoint that may return multiple pages. Validate every page before flattening results or deriving repository policy.

## Discovery and mutation boundaries

- Treat a configured default branch with no pull request as a normal no-PR discovery. For example, clean `main -> origin/main` with GitHub default branch `main` returns `kind: "none"` with zero commits ahead. It must not become blocked or `status unavailable`.
- Keep passive discovery separate from mutation preflight. A head ref equal to the selected base ref disables creation during discovery, but actual creation preflight must still reject that same-ref request.
- Preserve a regression test whose current branch, push ref, and default base are all `main`. Never change its default base to another name merely to satisfy creation-preflight mocks.
- Reserve `status unavailable` for real lookup or validation failures, not valid non-actionable repository states.

## Command tests

- Treat strict command mocks as consumers of the production command sequence. When that sequence changes, update every affected mock in the same unit and keep unknown commands failing.

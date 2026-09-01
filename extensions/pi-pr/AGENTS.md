# Pi PR instructions

## Git authority

- Treat the configured push target as branch authority. Parse validated `%(push:short)` against configured remote names. Do not derive the destination ref from the local branch name or depend on `%(push:remoteref)`, which may be empty for inferred targets.
- After validation, capture the exact commit OID and use that OID as the push refspec source. Immediately before pushing, require local `HEAD` to remain equal to the captured OID and revalidate the saved destination and PR identity.
- An empty `git status --porcelain=v1 --untracked-files=all` result is not enough to prove safety. Reject in-progress merge, rebase, cherry-pick, revert, and sequencer state. Resolve Git state paths through Git so linked worktrees work.

## GitHub authority

- Paginate every GitHub endpoint that may return multiple pages. Validate every page before flattening results or deriving repository policy.

## Command tests

- Treat strict command mocks as consumers of the production command sequence. When that sequence changes, update every affected mock in the same unit and keep unknown commands failing.

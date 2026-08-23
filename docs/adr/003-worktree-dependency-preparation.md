# 003. Prepare Dependencies at Worktree Creation

- **Status:** accepted
- **Date:** 2026-08-22 (migrated from Obsidian vault)

## Context

New git worktrees need dependencies installed before they are usable. Doing this at Pi session startup misses worktrees created by other tools and pays repeated startup cost.

## Decision

`@henryqw/pi-deps` uses explicit per-repository opt-in and Git's shared `post-checkout` hook for new-worktree dependency preparation instead of Pi session startup.

## Consequences

- Covers every worktree creator, not just Pi.
- Failures attach to worktree creation.
- Avoids repeated Pi startup cost.
- Avoids global Git hook overrides.

Root lockfiles govern frozen Node and uv installs; foreign hooks are never modified.

# 003. Prepare Dependencies at Worktree Creation

- **Status:** accepted
- **Date:** 2026-08-22

## Context

New worktrees need dependencies before use. Pi session startup misses worktrees created by other tools and repeats work on every session.

## Decision

`@henryqw/pi-deps` uses explicit per-repository opt-in and Git's shared `post-checkout` hook to prepare new worktrees.

Root lockfiles govern frozen Node and uv installs. Foreign hooks are never modified.

## Consequences

Preparation covers every worktree creator, failures attach to creation, and Pi startup stays fast without a global hook override.

# 017. pi-subagent Role Skill Resolution

- **Status:** accepted
- **Date:** 2026-08-13 (migrated from Obsidian vault)

## Context

Role files must reference skills portably while Pi's Main effective registry already applies skill discovery, project trust, package resolution, and collision selection — yet the Pi child CLI still needs resolved file paths.

## Decision

Configure Role Skills by effective Pi Skill name and resolve each name from the Main registry when delegation starts; warn and skip unavailable names.

## Consequences

- Names keep Role files portable.
- The child receives only registry-approved matching Skill paths.
- Stale names remain visible warnings without stopping work.

Alternatives rejected: absolute paths (couple config to one machine); rescanning files (duplicates Pi discovery and can disagree with the effective registry); failing on missing optional Skills (blocks otherwise useful delegation).

## Notes

Source: user-requested skill-name routing, verified against Pi getCommands registry. Files: `packages/pi-subagent/README.md`, `packages/pi-subagent/extensions/subagent.ts`.

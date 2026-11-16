# 022. Retire pi-subagent and pi-cron

- **Status:** accepted
- **Date:** 2026-11-16

`@henryqw/pi-subagent` and `@henryqw/pi-cron` leave the active workspace. Their final source, documentation, and tests stay under `deprecated/`. Archives are excluded from workspace execution, tests, and publishing. npm deprecation is already applied for every published version. Do not publish a new version of either package.

Direct delegation uses `npm:billion-context` and `acp_delegate`. Checked worktrees have no replacement. Scheduled jobs have no replacement. The installer does not remove the retired packages, because there is no replacement install.

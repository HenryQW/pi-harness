# 008. pi-auto-dag Config-Defined Worker Profiles

- **Status:** superseded by [ADR 009](009-pi-auto-dag-subagent-owned-worker-infrastructure.md)
- **Date:** 2026-08-11, superseded 2026-08-17 (migrated from Obsidian vault)

## Context

Auto DAG needed a way to define worker launch policy (agent directory, skills, tools) without hardcoding paths or trusting arbitrary config-provided skill files.

## Decision

Pi Auto DAG configuration version 3 defined each Worker profile directly: description, absolute agent directory, effective Pi skill names, and baseline tools. External profile resolver commands were removed.

Configured skill names resolved only against Pi's ordered `before_agent_start` `systemPromptOptions.skills` registry. Auto DAG preserved matching registry order and duplicates, launched Workers with `--no-skills`, and injected each selected absolute `SKILL.md` path with `--skill`.

Run State version 3 stored selected registry entries as derived recovery data. The current Pi registry won when available; persisted entries allowed worker-event recovery before the first Main agent turn after restart.

## Consequences

- Pi remained authority for skill discovery, trust, precedence, and collision winners.
- Config could not provide arbitrary skill paths.
- Missing configured skill names blocked before Worker creation.
- Config v2 and Run State v2 were intentionally unsupported by package major version 5.

Superseded because defining profiles in Auto DAG duplicated Pi profile management and coupled Auto DAG to host backends; see ADR 009.

# 016. pi-subagent Role Configuration

- **Status:** accepted
- **Date:** 2026-08-13, updated 2026-08-18 (migrated from Obsidian vault)

## Decision

- **Configure Subagent Roles as user-owned Markdown files instead of adding JSON config or a profile abstraction.** Each Role already needs description, system instructions, exact tools, extensions, and skills; one Markdown file keeps that capability definition together and reuses Pi example conventions. Separate JSON would split prompts from capabilities and duplicate config; generic profiles are not present in the authoritative Pi CLI; project-local Roles need trust UX not required now. Roles remain explicit and editable; ambient child extensions and skills stay disabled; repository-controlled Roles do not execute. Source: user-approved pi-subagent implementation.
- **Store user-owned Role Markdown files directly under `~/.pi/agent/config/pi-subagent`, with no nested agents directory and no bundled presets.** The config path makes package ownership explicit and avoids claiming a top-level Pi resource namespace; this package has only one config resource type, so another directory level adds no information. Top-level `~/.pi/agent/subagents` risks future Pi namespace collision; `config/pi-subagent/agents` duplicates hierarchy; bundled example presets make models and capabilities implicit and age quickly. The package keeps the Pi example Markdown schema while users define every Role, Route, extension, skill, and tool capability explicitly. Source: user-approved config path correction.

## Update — 2026-08-18: tool policy

**Treat explicit Role tools as a built-in base policy; let Pi activate tools and Skills contributed by explicit Role/caller extension sources at child startup.** Pi owns effective tool provenance and resource discovery, so static package scanning would duplicate it and can disagree with runtime behavior. Tradeoff: `tools: []` now leaves explicitly loaded extension tools active rather than disabling every tool; use no extension sources for a zero-tool child. Ambient resources remain disabled, while configured extension packages and `resources_discover` Skills work without duplicate capability catalogs. Source: user-approved implementation and explicit memory confirmation. Files: `packages/pi-subagent/extensions/role-tools.ts`, `packages/pi-subagent/src/index.ts`.

## Notes

Files: `packages/pi-subagent/README.md`, `packages/pi-subagent/extensions/subagent.ts`.

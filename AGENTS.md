# Agent instructions

This file contains active repository-specific policy. ADRs record decisions, agent docs provide task runbooks, and scripts or workflows enforce checks. Fix disagreements at their source instead of adding another rule here.

## Code Exploring

When `.codegraph/codegraph.db` exists, use `codegraph_explore` for symbol lookups, call graphs, imports, and codebase mapping instead of manual file searching.

## Repository defaults

### Compatibility

Extensions are opinionated tools built for the maintainer's daily work. They do not guarantee backward compatibility.

### Pi registry authority

- Use Pi's effective skill and model registries, plus model metadata, as resource authority.
- Resolve skills and models at launch. Store names or classes in config, not arbitrary paths or copied catalogs.
- Do not add package-owned capability catalogs or duplicate discovery logic.

## Extension configuration

Follow [ADR 018](docs/adr/018-extension-config-homes.md):

- Each extension owns `getAgentDir()/config/<extension-id>/`, where the ID is one validated lowercase path component.
- Use `extensionConfigDir` and `extensionConfigPath` from `@henryqw/pi-config-store`; never construct these paths directly.
- Keep default user JSON at `config/<extension-id>/config.json` and all other owned files inside the same home.
- Only the owner writes its home. Consumers use an owner API or namespaced Pi events.
- Treat JSON as untrusted. Validate reads, preserve malformed files, and write only after explicit user action.
- Fail fast for required config. Keep usable optional defaults silent, and warn only when the user must act.

## Package releases

Each public workspace under `extensions/*` or `packages/*` releases independently. See [the release runbook](docs/releasing.md).

- Bump a package when `scripts/check-package-versions.mjs` classifies one of its changed files as published. This includes `package.json`, `README*`, licenses, source, build config, and files included by its package allowlist.
- Root-only changes and package test-only changes do not require a bump. The private root package never releases.
- Use patch for fixes or documentation, minor for backward-compatible features, and major for breaking changes.
- Bump each affected package once, after the final base sync, with `pnpm --filter ./<root>/<package> version <patch|minor|major> --no-git-tag-version`.
- Regenerate `pnpm-lock.yaml` after manifest edits and commit it when it changes. Do not create release tags.
- Before the final release commit or any push, run `pnpm run check:package-versions`.
- Successful CI for a push to `main` triggers `.github/workflows/publish.yml`, which publishes public workspaces whose versions are newer than npm.
- Before finishing, state which packages release and why. If none changed, state that CI will not publish.

## Documentation

- Write READMEs for users. Lead with what they can do or will see, then explain internals.
- Use plain English, active voice, short sentences, and short paragraphs. Keep commands, paths, API names, and errors exact.
- Prefer lists, tables, or diagrams only when they clarify the content. Remove repetition, marketing language, and implementation history.
- State requirements, limits, failures, and safety risks without simplifying away technical meaning.
- Follow [the diagram guide](docs/diagram-style.md) for repository diagrams.
- Set every README-linked SVG root's `width` and `height` to its `viewBox` dimensions. The docs site relies on the intrinsic size for image zoom.
- After an extension change, update its README when commands, config, behavior, requirements, limits, safety guidance, or package relationships changed.
- For README/template-only changes, preserve unique guidance, verify structure and version/lockfile consistency, and run the package-version check plus `git diff --check`. Skip runtime tests, typechecks, and pack checks unless runtime or package structure changed or local README assets need pack verification.
- Treat local files linked from a published README as package contents. Include required assets in the package allowlist and verify them with `npm pack --dry-run`.

## Task runbooks

| Task | Authority |
| --- | --- |
| GitHub issues | [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) |
| Triage labels | [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md) |
| Pi version upgrades | [`docs/agents/pi-version-upgrade.md`](docs/agents/pi-version-upgrade.md) |
| Domain terms, contexts, and ADRs | [`docs/agents/domain.md`](docs/agents/domain.md) |
| Completed config-home migration history | [`docs/agents/pi-config-store-migration.md`](docs/agents/pi-config-store-migration.md) |

## Knowledge storage

Follow [ADR 005](docs/adr/005-knowledge-tier-model.md): keep durable repository knowledge in git, resumable worktree state in `.context/progress.md`, and cross-project facts in `pi-memory`'s `MEMORY.md` or `USER.md`.

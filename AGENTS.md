# Agent instructions

Keep active repository-specific policy here. ADRs own decisions, agent docs own runbooks, and scripts or workflows enforce checks; fix disagreements at their source.

## Code exploration

When `.codegraph/codegraph.db` exists, use `codegraph_explore` for symbol lookups, call graphs, imports, and codebase mapping.

## Repository defaults

- Compatibility covers each package's documented public contract, not its internals or undocumented behavior. Breaking internal changes need no major release.
- Use Pi's effective skill and model registries and model metadata as authority. Resolve resources at launch; store names or classes, not paths or copied catalogs.
- For extension config homes, follow [ADR 018](docs/adr/018-extension-config-homes.md). Use `extensionConfigDir` and `extensionConfigPath` from `@henryqw/pi-config-store`, validate untrusted JSON, preserve malformed files, and write only after explicit user action.

## Package releases

For every published package, runtime imports reachable from its entry points must resolve from files in the packed artifact or declared runtime dependencies. If an extension imports sibling `src/` files, publish them; if it imports `dist/` files, build and pack them. Verify changed import paths or package layouts against `npm pack --dry-run`.

Follow [the release runbook](docs/releasing.md) and `scripts/check-package-versions.mjs` for published-file classification, version choice, lockfile updates, and publishing. Apply required version bumps before the first version check. Run `pnpm run check:package-versions` before the final release commit or any push. Before finishing, state which packages release and why; if none changed, state that CI will not publish.

For each new public package, check whether it exists on npm before finishing. If npm returns `E404`, explicitly prompt the maintainer with the package name, version, and first-publication/trusted-publisher steps from [the bootstrap checklist](docs/releasing.md#first-publication-checklist). Other lookup failures are blockers, not proof that the package is new. Report bootstrap work as pending; CI cannot perform the first publication. Do not authenticate, publish, or change npm trust settings without an explicit request.

## Documentation

Write user-facing READMEs in plain English: lead with the user outcome, keep commands, paths, API names, and errors exact, and state requirements, limits, failures, and safety risks. After an extension change, update its README if user-visible behavior or guidance changed. For extension READMEs, follow [the canonical template](extensions/README-template.md); use H3 for package-specific topics. `pnpm run docs:validate` enforces H2 names and order against the template.

Follow [the diagram guide](docs/diagram-style.md). Set each README-linked SVG root's `width` and `height` to its `viewBox` dimensions. Include local files linked from a published README in the package allowlist and verify them with `npm pack --dry-run`.

For README/template-only changes, preserve unique guidance and verify structure, version/lockfile consistency, `pnpm run check:package-versions`, and `git diff --check`. Skip runtime tests, typechecks, and pack checks unless runtime or package structure changed or local README assets need pack verification.

## First-party skills

This repository owns [pi-extension-workbench](.agents/skills/pi-extension-workbench/SKILL.md); maintain it here, not in `HenryQW/skills` or `skills-lock.json`. Keep installed Pi docs, examples, and declarations as runtime authority. Validate skill changes with `python3 .agents/skills/pi-extension-workbench/scripts/validate.py`.

## Task runbooks

- [GitHub issues](docs/agents/issue-tracker.md) and [triage labels](docs/agents/triage-labels.md)
- [Pi version upgrades](docs/agents/pi-version-upgrade.md)
- [Domain terms, contexts, and ADRs](docs/agents/domain.md)

## Knowledge storage

Follow [ADR 005](docs/adr/005-knowledge-tier-model.md): keep durable repository knowledge in git, resumable worktree state in `.context/progress.md`, and cross-project facts in `pi-memory`'s `MEMORY.md` or `USER.md`.

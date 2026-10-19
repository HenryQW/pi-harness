# Agent instructions

Keep active repository-specific policy here. ADRs own decisions, agent docs own runbooks, and scripts or workflows enforce checks; fix disagreements at their source. Nested `AGENTS.md` files in `extensions/`, `website/`, `extensions/pi-pr/`, and `extensions/pi-subagent/` add rules for their subtrees.

## Code exploration

When `.codegraph/codegraph.db` exists, use `codegraph_explore` for symbol lookups, call graphs, imports, and codebase mapping.

## Repository defaults

- Compatibility covers each package's documented public contract, not its internals or undocumented behavior. Breaking internal changes need no major release.
- Use Pi's effective skill and model registries and model metadata as authority. Resolve resources at launch; store names or classes, not paths or copied catalogs.
- Extension config follows [ADR 018](docs/adr/018-extension-config-homes.md) for config homes and [ADR 004](docs/adr/004-extension-config-safety.md) for warn and disable rules. Locate files with `extensionConfigDir` and `extensionConfigPath`, load user-edited config with `createConfigStore` (`fields` or `entries`), and report issues with `registerConfigReporting`; never parse config files directly. Preserve malformed files and write only after explicit user action. [The config-store reference](docs/agents/pi-config-store-migration.md) lists the contract and consumers.

## Checks

CI (`.github/workflows/ci.yml`) runs `pnpm run check:package-versions`, `pnpm run docs:validate`, `pnpm test`, `pnpm run typecheck`, and `pnpm run pack:check`. While iterating, scope checks to touched packages with `pnpm --filter <package> run <script>`; before finishing, run each root check that the change can affect.

## Package releases

For every published package, runtime imports reachable from its entry points must resolve from files in the packed artifact or declared runtime dependencies. If an extension imports sibling `src/` files, publish them; if it imports `dist/` files, build and pack them. Verify changed import paths or package layouts against `npm pack --dry-run`.

Follow [the release runbook](docs/releasing.md) and `scripts/check-package-versions.mjs` for published-file classification, version choice, lockfile updates, and publishing. Apply required version bumps before the first version check. Run `pnpm run check:package-versions` before the final release commit or any push. Before finishing, state which packages release and why; if none changed, state that CI will not publish.

When you add, remove, or rename an extension, also update the root `package.json` `pi.extensions` list and `CONTEXT-MAP.md`, then regenerate the installer list with `pnpm --filter @henryqw/pi-docs run generate:installer` (`docs:validate` fails when it is stale). When extensions or their internal runtime or peer dependencies change, update `docs/extension-dependencies.html`, `docs/extension-dependencies.svg`, and the root README alt text.

For each new public package, check whether it exists on npm before finishing. If npm returns `E404`, explicitly prompt the maintainer with the package name, version, and first-publication/trusted-publisher steps from [the bootstrap checklist](docs/releasing.md#first-publication-checklist). Other lookup failures are blockers, not proof that the package is new. Report bootstrap work as pending; CI cannot perform the first publication. Do not authenticate, publish, or change npm trust settings without an explicit request.

## Documentation

These rules apply to every README: root, `extensions/`, and `packages/`. `pnpm run docs:validate` enforces the mechanical ASD-STE100 rules in `website/ste.ts`, but passing it does not prove full conformance.

Write user-facing READMEs in ASD-STE100 Simplified Technical English with the package's `CONTEXT.md` terms: lead with the user outcome, keep commands, paths, API names, and errors exact, and state requirements, limits, failures, and safety risks. After a package change, update its README if user-visible behavior or guidance changed. For extension READMEs, follow [the canonical template](extensions/README-template.md); use H3 for package-specific topics. `pnpm run docs:validate` enforces H2 names and order against the template.

Follow [the diagram guide](docs/diagram-style.md). Set each README-linked SVG root's `width` and `height` to its `viewBox` dimensions. Include local files linked from a published README in the package allowlist and verify them with `npm pack --dry-run`.

For README/template-only changes, preserve unique guidance and run `pnpm run docs:validate`, `pnpm run check:package-versions`, and `git diff --check`. A package README is a published file, so it needs a patch bump. Skip runtime tests, typechecks, and pack checks unless runtime or package structure changed or local README assets need pack verification.

## First-party skills

This repository owns [pi-extension-workbench](.agents/skills/pi-extension-workbench/SKILL.md); maintain it here, not in `HenryQW/skills` or `skills-lock.json`. Keep installed Pi docs, examples, and declarations as runtime authority. Validate skill changes with `python3 .agents/skills/pi-extension-workbench/scripts/validate.py`. The repository also owns [extension-sweep](.agents/skills/extension-sweep/SKILL.md) for cross-package optimization, test-pruning, and documentation sweeps.

After you change a package skill that has a suite in [evals/](evals/README.md), run `node evals/run.ts --skill <name>` and report the results. Evals call a model, so CI does not run them.

## Task runbooks

- [Package releases](docs/releasing.md)
- [GitHub issues](docs/agents/issue-tracker.md) and [triage labels](docs/agents/triage-labels.md)
- [Pi version upgrades](docs/agents/pi-version-upgrade.md)
- [Herdr version upgrades](docs/agents/herdr-version-upgrade.md)
- [Domain terms, contexts, and ADRs](docs/agents/domain.md)

## Knowledge storage

Follow [ADR 005](docs/adr/005-knowledge-tier-model.md): keep durable repository knowledge in git, resumable worktree state in `.context/progress.md`, and cross-project facts in `pi-memory`'s `MEMORY.md` or `USER.md`.

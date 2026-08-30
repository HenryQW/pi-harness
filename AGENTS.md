# Agent instructions

## Compatibility

These extensions are highly opinionated tools built for the maintainer's daily work. No support, migrations, or backward compatibility are offered. Breaking changes may be introduced at any time.

## Extension Config Home

- Every extension owns one config home at `getAgentDir()/config/<extension-id>/`. The extension ID must be one validated lowercase path component.
- Use `extensionConfigDir(extensionId, agentDir?)` and `extensionConfigPath(extensionId, agentDir?)` from `@henryqw/pi-config-store`; do not construct config paths directly.
- The default user-editable JSON file is `config/<extension-id>/config.json`, provided by `extensionConfigPath`.
- All other extension-owned files, including generated state and custom formats, must stay inside the home and use `extensionConfigDir`.
- Only the owning extension writes its home. Consumers use an owner API or namespaced Pi events instead of reading another extension's files.

## Extension config safety

- Treat extension config JSON as untrusted user data.
- Validate reads; preserve malformed files; never rewrite config during startup.
- Write only after explicit user action. Fail fast for correctness-critical config; use explicit defaults only for optional config.
- Warn only when user action is required. Missing optional config with usable defaults is normal and stays silent.

## Pi registry as authority

- Use Pi's effective skill/model registries and model metadata as resource authority.
- Resolve skills and models at launch; configs use names or classes, not arbitrary paths or copied catalogs.
- Avoid duplicate discovery logic and package-owned capability catalogs.

## Package release policy

This repository is npm workspace monorepo. Each public package under `packages/*` releases independently.

- Bump package version when change affects published files, runtime behavior, public API, package metadata, or runtime dependencies.
- Bump every affected package when one change touches multiple packages.
- Bump each affected package's npm version only once per PR.
- Do not bump version for root-only CI, Dependabot, development dependency, test-only, or repository documentation changes.
- Use patch for fixes, minor for backward-compatible features, and major for breaking changes.
- Bump with npm; do not edit versions by hand:

  ```bash
  npm version patch --workspace packages/<package> --no-git-tag-version
  ```

- Commit version and `package-lock.json` changes with feature or fix. Do not create release tags.
- Push `main`; `.github/workflows/publish.yml` publishes each public workspace whose version is newer than npm.
- Root package `@henryqw/pi-packages` is private and never releases.
- PR CI enforces version bumps for published package changes; test-only package changes are excluded.
- Before finishing, state which packages release and why. If no package version changed, state that CI will not publish.

## Documentation fast path

Every `README.md` is for people:

- Use simple English.
- Keep sentences short; aim for 20 words or fewer.
- Put one main idea in each sentence.
- Use direct verbs and active voice.
- Explain what readers can do or will see before explaining internals.
- Prefer common words, such as “uses” instead of “consumes,” “starts” instead of “invokes,” and “works with” instead of “integrates with.”
- Avoid jargon and internal architecture terms unless readers need them. Define necessary technical terms on first use.
- Keep commands, paths, package names, API names, and error messages exact.
- Keep paragraphs to three sentences or fewer. Use lists for steps and options.
- Use tables for comparisons and diagrams for flows or relationships when they are clearer than prose. Do not add a visual when a short sentence or list is easier to read.
- Remove repeated details, marketing language, and implementation history.
- State requirements, limits, failures, and safety risks plainly.
- Never simplify away important technical meaning.
- After any extension change, check its `README.md` and update it when commands, config, behavior, requirements, limits, safety guidance, or package relationships changed.

For README/template-only changes:

- Keep cohesive work in one bounded implementer/reviewer unit, including any required workspace version bumps and lockfile update.
- Preserve or relocate unique guidance when deleting standard sections.
- Validate structure, version/lockfile consistency, and `git diff --check`.
- Skip runtime tests, typechecks, pack checks, and progress tracking unless runtime/package structure changes or the work becomes resumable.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `HenryQW/pi-packages`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses default canonical labels. See `docs/agents/triage-labels.md`.

### Pi version upgrades

Audit and migrate all extension packages to a published Pi release with `docs/agents/pi-version-upgrade.md`.

### Config store migration

Build and migrate extension config homes with `docs/agents/pi-config-store-migration.md`.

### Domain docs

Multi-context layout uses root `CONTEXT-MAP.md` and per-package `CONTEXT.md` files. See `docs/agents/domain.md`.

### Knowledge tiers

- `pi-memory` (`MEMORY.md` and `USER.md`) is global cross-project memory; never store project-specific facts there.
- Durable repository knowledge belongs in git: `docs/adr/`, `AGENTS.md`, and `CONTEXT.md` files.
- Resumable per-worktree task state belongs in `.context/progress.md`.

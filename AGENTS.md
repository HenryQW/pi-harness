# Agent instructions

## Compatibility

These extensions are highly opinionated tools built for the maintainer's daily work. No support, migrations, or backward compatibility are offered. Breaking changes may be introduced at any time.

## Extension config paths

- An extension with one config file and no extension-named config directory must use:

  ```ts
  const configPath = () => join(getAgentDir(), "config", "extension-name.json");
  ```

- If an extension-named config directory exists, every config file owned by that extension must live in it. Multiple configs therefore require an extension-named directory, for example:

  ```ts
  join(getAgentDir(), "config", "pi-multi-codex", "usage.json");
  ```

## Extension config safety

- Treat extension config JSON as untrusted user data.
- Validate reads; preserve malformed files; never rewrite config during startup.
- Write only after explicit user action. Fail fast for correctness-critical config; use explicit defaults only for optional config.

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

### Domain docs

Multi-context layout uses root `CONTEXT-MAP.md` and per-package `CONTEXT.md` files. See `docs/agents/domain.md`.

### Knowledge tiers

- `pi-memory` (`MEMORY.md` and `USER.md`) is global cross-project memory; never store project-specific facts there.
- Durable repository knowledge belongs in git: `docs/adr/`, `AGENTS.md`, and `CONTEXT.md` files.
- Resumable per-worktree task state belongs in `.context/progress.md`.

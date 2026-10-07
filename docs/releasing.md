# Release packages

Public workspaces release independently when their published surface changes. The private root workspace never releases.

## Choose the release set

`scripts/check-package-versions.mjs` is the executable authority. It requires a version bump for changes to a public package's:

- `package.json`, including development dependency changes;
- `README*`, `LICENSE*`, or `LICENCE*`;
- source or build configuration;
- files included by the package's `files` allowlist.

Root-only changes and package test-only changes do not require a bump. Classify the changed files, not the author or update source, so dependency automation has no blanket exemption.

## Prepare versions

Before version bumps, fetch and merge current `origin/main` with `update-from-main`. Resolve source conflicts first; regenerate `pnpm-lock.yaml` instead of hand-merging it. Record the final main SHA and use it as the release baseline.

Bump each affected package exactly once. Classify the package's own documented public contract, not the size of the diff or the version of a dependency:

- **Patch:** fixes, documentation, refactors, implementation dependency updates, and consumer dependency-range updates that preserve the consumer's contract.
- **Minor:** backward-compatible features and a raised Pi peer floor within the same Pi major.
- **Major:** incompatible changes to exported APIs, commands or tool schemas, configuration or persisted data that requires user action, or documented behavior, including a function removed because Pi now provides it; dropping a Pi major or a Node.js runtime.

If an internal `@henryqw/*` workspace gets a major bump, update every direct consumer's range and add those consumers to the release set. A consumer that adapts while preserving its own contract normally receives a patch; the dependency's major release alone does not make it breaking.

For a `0.x` package, use patch for compatible fixes and minor for features or breaking changes. Move to `1.0.0` only when intentionally declaring its public contract stable.

Edit `version` in the package's `package.json` directly. Use `extensions` as the root for Pi extensions and `packages` for support libraries. After all manifest and version edits, run `pnpm install --lockfile-only --ignore-scripts`. Commit `pnpm-lock.yaml` when it changes; do not create release tags.

Before the final release commit or any push, run:

```bash
pnpm run check:package-versions
```

Pull-request CI runs the same version check, plus tests, typechecks, and pack checks in `.github/workflows/ci.yml`. Pi `devDependencies` pin the floor, so these checks test the floor. Direct pushes to `main` rely on the local version check.

When a published README links local files, include them in the package allowlist and verify that package with `npm pack --dry-run`.

## Pi peer ranges

The floor is the oldest Pi version the package supports, normally the major's `.0` release (for example `^1.0.0`). Pin Pi `devDependencies` to the floor.

- Keep the floor when unchanged code works with the target. Do not raise a peer dependency's minimum merely to match the development or validation version.
- Raise the floor only to adopt a Pi feature or required fix. Use the first version that provides it, for example `^1.0.4`. Within one Pi major, this is a minor release of our package. State the new minimum in its README and update Pi `devDependencies` to the new floor.
- Accept a new Pi major by widening the range when unchanged code supports both, for example `^1.0.0 || ^2.0.0`. Dropping a Pi major is a major release of our package.
- Use the same range style across Pi peers in a package. Add a Pi peer only for a directly imported package. Preserve unrelated peers such as `typebox`.

## Publish

Push `main`. After CI succeeds, `.github/workflows/publish.yml` compares each public workspace version with npm and publishes only newer versions. Private workspaces are skipped.

## First publication checklist

A new package needs one authenticated maintainer publication before npm can accept its trusted-publisher configuration. CI cannot bootstrap it with OIDC. Complete this setup before relying on CI to release that package; later versions use `.github/workflows/publish.yml`.

When adding a public workspace, check `npm view <package-name> version`. An `E404` means the package is unavailable in the registry; ask the maintainer to verify ownership and complete the steps below. Authentication, network, and other lookup errors are blockers, not evidence of a missing package. Prompt with the exact package name, version, and directory, and keep the setup marked pending until the final trust check and exact-version check pass.

### Maintainer steps

Run from the package directory (`extensions/<directory>` or `packages/<directory>`) at the reviewed, validated commit intended for release. Keep the package under `@henryqw` and run its documented build/checks first. These commands use npm 11.15 or newer for the trust CLI:

```sh
# 1. Confirm the package and inspect the artifact.
PACKAGE=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
npm pack --dry-run

# 2. Authenticate with a maintainer account, then publish the first version.
npx --yes npm@^11.15.0 whoami
npx --yes npm@^11.15.0 login --auth-type=web # Only if not signed in.
npx --yes npm@^11.15.0 publish --access public

# 3. From the repository root, check trust, apply changes, then check again.
cd "$(git rev-parse --show-toplevel)"
bash .agents/skills/npm-ops/sync.sh --check
bash .agents/skills/npm-ops/sync.sh # Apply only after reviewing mismatches.
bash .agents/skills/npm-ops/sync.sh --check

# 4. Verify the initial version.
npm view "$PACKAGE@$VERSION" version
```

Authenticate, publish, and change trust settings only after an explicit request. Complete login and 2FA in the browser; never paste credentials or one-time passwords into chat. Publication is public, not a dry run. If its response is lost, verify the exact version on npm before deciding whether to retry.

Step 3 uses the [`npm-ops` trusted publishing sync](../.agents/skills/npm-ops/SKILL.md#trusted-publishing). It creates missing trust configuration and can change other packages' mismatched settings. Inspect the check results before applying changes. Report bootstrap complete only after verifying the exact version, publisher repository `HenryQW/pi-harness`, workflow `publish.yml`, and permission to publish. No registry deprecations are included in this checklist.

CI trusted publishing requires npm CLI 11.5.1 or newer and GitHub OIDC; the workflow grants `id-token: write`. No npm token needs to be added to GitHub secrets.

## Retire a package

Archive the final source, docs, and tests under `deprecated/`, excluded from workspaces, tests, and publishing. Point the README to the replacement and record the decision in an ADR.

Repository retirement does not deprecate npm versions. After the replacement is published, use the [`npm-ops` skill](../.agents/skills/npm-ops/SKILL.md#deprecate-packages-or-versions) to draft, preview, apply, and verify deprecation. Live deprecation needs an explicit request, maintainer authentication, and possibly browser 2FA. A request to update the skill or draft a message is not authorization. Deprecation adds install warnings; it does not unpublish versions or delete users' data.

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

After the final base sync, bump each affected package exactly once. Classify the package's own documented public contract, not the size of the diff or the version of a dependency:

- **Patch:** fixes, documentation, refactors, implementation dependency updates, and consumer dependency-range updates that preserve the consumer's contract.
- **Minor:** backward-compatible features.
- **Major:** incompatible changes to exported APIs, commands or tool schemas, configuration or persisted data that requires user action, documented behavior, or the supported host/runtime range.

An internal dependency's major release does not automatically make its consumers breaking. A consumer that adapts while preserving its own contract normally receives a patch.

For a `0.x` package, use patch for compatible fixes and minor for features or breaking changes. Move to `1.0.0` only when intentionally declaring its public contract stable.

Do not raise a peer dependency's minimum merely to match the version used for development or validation. If the package remains compatible with the old minimum, widen the range to include the new tested version while preserving that minimum. If the package requires a newer peer contract and drops previously supported hosts, that is a breaking change for packages at `1.x` or later.

On a clean working tree, use `pnpm --filter ./<root>/<package> version patch --no-git-tag-version` (replace `patch` with the chosen release level). This command refuses a dirty tree; when editing published files, update the version in that package's `package.json` directly instead of stashing or committing unfinished work to run it.

Use `extensions` as the root for Pi extensions and `packages` for support libraries. Regenerate `pnpm-lock.yaml` after manifest edits, commit it when it changes, and do not create release tags.

Before the final release commit or any push, run:

```bash
pnpm run check:package-versions
```

Pull-request CI runs the same version check. Direct pushes to `main` rely on the local check.

When a published README links local files, include them in the package allowlist and verify that package with `npm pack --dry-run`.

## Publish

Push `main`. After CI succeeds, `.github/workflows/publish.yml` compares each public workspace version with npm and publishes only newer versions. Private workspaces are skipped.

## First publication checklist

A new package needs one authenticated maintainer publication before npm can accept its trusted-publisher configuration. CI cannot bootstrap it with OIDC. Complete this setup before relying on CI to release that package; later versions use `.github/workflows/publish.yml`.

When adding a public workspace, check `npm view <package-name> version`. An `E404` means the package is unavailable in the registry; ask the maintainer to verify ownership and complete the steps below. Authentication, network, and other lookup errors are blockers, not evidence of a missing package. Prompt with the exact package name, version, and directory, and keep the setup marked pending until both checks in step 4 pass.

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

# 3. Once the package exists, configure its trusted publisher.
npx --yes npm@^11.15.0 trust github "$PACKAGE" \
  --repo HenryQW/pi-harness --file publish.yml --allow-publish --yes

# 4. Verify the initial version and the trusted publisher.
npm view "$PACKAGE@$VERSION" version
npx --yes npm@^11.15.0 trust list "$PACKAGE" --json
```

Authenticate, publish, and change trust settings only after an explicit request. Complete login and 2FA in the browser; never paste credentials or one-time passwords into chat. Publication is public, not a dry run. If its response is lost, verify the exact version on npm before deciding whether to retry.

If trust settings already exist, inspect them before step 3 and use the repository's `npm-ops` skill for repairs; its bulk sync can change other packages' mismatched settings. Report bootstrap complete only after verifying the exact version, publisher repository `HenryQW/pi-harness`, workflow `publish.yml`, and permission to publish. No registry deprecations are included in this checklist.

CI trusted publishing requires npm CLI 11.5.1 or newer and GitHub OIDC; the workflow grants `id-token: write`. No npm token needs to be added to GitHub secrets.

## Retire merged packages

`@henryqw/pi-herdr-tools@1.0.0` consolidates `pi-herdr-btw`, `pi-herdr-clone`, and `pi-herdr-rename`. The final pre-merge source, documentation, and tests of these packages and the earlier `pi-herdr-done` are archived under `deprecated/`. Their READMEs point to the replacement; the archives are excluded from active workspaces, tests, and publishing. The shared `@henryqw/pi-herdr` library stays active.

Bootstrap the new package and configure its trusted publisher as above. Repository retirement alone does not deprecate npm versions. Use the repository's [`npm-ops` skill](../.agents/skills/npm-ops/SKILL.md#deprecate-packages-or-versions) to automate deprecation: it drafts the migration message, verifies replacement availability, previews the exact version selectors, applies an explicitly requested deprecation, and checks every affected version.

For this consolidation, the targets are `@henryqw/pi-herdr-btw@*`, `@henryqw/pi-herdr-clone@*`, `@henryqw/pi-herdr-rename@*`, and `@henryqw/pi-herdr-done@*`; the replacement is `@henryqw/pi-herdr-tools@1.0.0`. The draft should explain the merge, instruct users to install the replacement, remove the old sources in the relevant user/project scopes, and restart Pi, and link to `https://pi.henry.wang/extensions/pi-herdr-tools` for migration.

Registry deprecation requires maintainer authentication and may require browser 2FA. It adds install warnings without unpublishing versions or deleting users' data. Do not deprecate the old packages before the replacement is publicly available. Asking to update the skill or draft a message does not authorize live deprecation.

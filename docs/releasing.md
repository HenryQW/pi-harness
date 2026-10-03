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

## Configure trusted publishing

Complete this once for each new package:

1. Bootstrap its first version with an authenticated local npm publish.
2. In npm package settings, add a GitHub Actions trusted publisher for `HenryQW/pi-harness` and `publish.yml`.
3. Keep the package under the `@henryqw` scope.

Trusted publishing requires npm CLI 11.5.1 or newer and GitHub OIDC.

## Retire merged packages

`@henryqw/pi-herdr-tools@1.0.0` consolidates `pi-herdr-btw`, `pi-herdr-clone`, and `pi-herdr-rename`. These old workspaces are retired under `deprecated/` and will not publish further versions. The shared `@henryqw/pi-herdr` library stays active.

Bootstrap the new package and configure its trusted publisher as above. Verify the replacement is publicly installable before adding registry warnings; repository retirement alone does not deprecate npm versions:

```sh
npm view @henryqw/pi-herdr-tools@1.0.0 version
for package in pi-herdr-btw pi-herdr-clone pi-herdr-rename pi-herdr-done; do
  npm deprecate "@henryqw/$package@*" "Merged into @henryqw/pi-herdr-tools. Install the replacement, remove old installs, and restart Pi. See https://pi.henry.wang/extensions/pi-herdr-tools for migration."
  npm view "@henryqw/$package" deprecated
done
```

Registry deprecation requires maintainer authentication and may require browser 2FA. It adds install warnings without unpublishing versions or deleting users' data. Do not deprecate the old packages before the replacement is available.

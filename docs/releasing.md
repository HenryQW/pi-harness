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

```bash
pnpm --filter ./<root>/<package> version patch --no-git-tag-version
```

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

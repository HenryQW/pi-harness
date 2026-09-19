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

After the final base sync, bump each affected package exactly once. Use patch for fixes or documentation, minor for backward-compatible features, and major for breaking changes.

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

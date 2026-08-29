# Pi Version Upgrade

Use this workflow when auditing a published `@earendil-works/pi-*` release and upgrading this repository's extensions to it.

## Inputs

Record in `.context/progress.md`:

- exact target version, such as `0.85.0`;
- release notes or changelog;
- current branch and the `origin/main` SHA used as the baseline;
- migration decisions and validation status.

A release note is a lead, not proof that an extension needs source changes. Verify behavior against the target's published docs, examples, and types.

## 1. Establish the baseline and authority

1. Before editing manifests or versions, bring the branch up to date with `origin/main` using the `update-from-main` workflow. Record the merged main SHA.
2. Verify the target package is published:

   ```bash
   npm view "@earendil-works/pi-coding-agent@$TARGET" version
   ```

3. Resolve the active Pi authority with `pi-extension-workbench`. If active Pi is not the target, inspect a temporary copy of the published target artifact instead of GitHub, a source checkout, or remembered APIs:

   ```bash
   tmp="$(mktemp -d)"
   npm pack "@earendil-works/pi-coding-agent@$TARGET" --pack-destination "$tmp"
   tar -xzf "$tmp"/*.tgz -C "$tmp"
   TARGET_PI_ROOT="$tmp/package"
   ```

Stop if the target is unpublished or the published artifact does not contain the claimed API.

## 2. Inventory and assess

Enumerate `packages/*/package.json`. A package is an extension when `pi.extensions` is non-empty. Do not hardcode the package count. Shared libraries without extension entry points are outside the blanket upgrade unless the release requires a direct change.

For each changelog item, record one decision:

| Decision | Meaning |
| --- | --- |
| `migrate` | Existing extension behavior must use or honor the new API. |
| `regression` | A Pi core fix affects the extension; raise the floor and prove current code works before rewriting it. |
| `no action` | The extension does not own the affected behavior, or Pi instruments/provides it centrally. |

Search extension entry points, direct imports, relevant tests, and the target artifact for exact API names. Do not add no-op handlers, copied model/provider catalogs, speculative features, or compatibility fallbacks.

## 3. Upgrade the dependency baseline

For every extension package:

- set every existing `@earendil-works/pi-*` peer range to exactly `^<target-version>` (for example, `^0.85.0`);
- use the same range style across all Pi peers;
- do not add a Pi peer unless the package directly imports it;
- preserve unrelated peers such as `typebox`;
- update existing explicit README minimum-version text, without adding repetitive version prose everywhere.

Do not bump workspace package versions yet. Run `npm install` once to update `package-lock.json`, then verify the installed family resolves to the target:

```bash
npm ls \
  @earendil-works/pi-agent-core \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
```

Use the installed target docs/types for implementation. If tests pass but new APIs fail typechecking, verify the actual installed version before changing source; stale `node_modules` is not a compatibility requirement.

## 4. Implement only justified migrations

Apply the smallest source changes from the assessment. For each changed package:

1. trace the existing behavior and all callers;
2. follow the nearest published target example;
3. add or update one high-value regression for the changed contract;
4. update README and `CONTEXT.md` only when behavior or domain language changed;
5. run that package's test and typecheck/build.

Independent runtime packages may be delegated in parallel after the dependency baseline is committed. Keep manifests, workspace versions, and `package-lock.json` in one central unit; runtime units must not edit them.

For core fixes classified as `regression`, do not rewrite working source unless the regression fails against the target.

## 5. Re-sync, then version

Before package version bumps, fetch and merge current `origin/main` again with `update-from-main`. This prevents choosing versions relative to a stale main branch. Resolve source conflicts first and regenerate `package-lock.json` rather than hand-merging generated lockfile sections.

Using the final merged main SHA as the base, identify public packages with published-file changes. Bump each affected package exactly once and only now:

```bash
npm version patch --workspace packages/<package> --no-git-tag-version
```

Choose minor or major only when the actual package change requires it. The npm command must update both the manifest and lockfile.

## 6. Validate the release set

Commit the migration and version changes, then run once after the final code, dependency, and version state is stable:

```bash
npm ls \
  @earendil-works/pi-agent-core \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
node scripts/check-package-versions.mjs "$FINAL_MAIN_SHA" HEAD
npm test
npm run typecheck
npm run pack:check
git diff --check "$FINAL_MAIN_SHA" HEAD
```

Run credentialed live tests or interactive TUI smoke tests only when the changed behavior needs them and the environment supports them. Report any skipped interactive validation explicitly.

If final-main integration changes a package version or published file, recalculate that package's bump and rerun the version check. Do not hide a failed release check with a compatibility path.

## 7. Report

State:

- target Pi version and final main baseline;
- packages with source migrations, regression-only validation, and no action;
- exact validation commands that passed;
- untested live or interactive behavior;
- every package that will release and why;
- shared libraries that will not release.

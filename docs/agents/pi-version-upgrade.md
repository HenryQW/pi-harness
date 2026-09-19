# Pi Version Upgrade

Use this workflow when auditing a published `@earendil-works/pi-*` release and upgrading this repository's extensions to it.

## Inputs

Set the exact target once before step 1 and record that value in `.context/progress.md`:

```bash
TARGET=0.85.0
```

Record in `.context/progress.md`:

- exact target version, such as `0.85.0`;
- release notes or changelog;
- current branch and the `origin/main` SHA used as the baseline;
- migration decisions and validation status.

A release note is a lead, not proof that an extension needs source changes. Verify behavior against the target's published docs, examples, and types.

## 1. Establish the baseline and authority

1. Before editing manifests or versions, bring the branch up to date with `origin/main` using the `update-from-main` workflow. Record the merged main SHA.
2. Resolve the active Pi APIs with `pi-extension-workbench`, then map every referenced API to the exact published package that owns it. Treat that package's artifact as authority: `@earendil-works/pi-ai` for `pi-ai` APIs, `@earendil-works/pi-agent-core` for core APIs, `@earendil-works/pi-tui` for TUI APIs, and `@earendil-works/pi-coding-agent` only for APIs it publishes. Do not use `pi-coding-agent` as authority for APIs owned by another package.
3. Verify each relevant target package is published. Keep the package list in both commands below in sync, adding any other owning `@earendil-works/pi-*` package found in the inventory:

   ```bash
   set -e
   for package in pi-coding-agent pi-agent-core pi-ai pi-tui; do
     npm view "@earendil-works/$package@$TARGET" version
   done
   ```

4. Inspect each relevant exact published artifact, not GitHub, a source checkout, or remembered APIs. Add every relevant owning package to this loop:

   ```bash
   set -e
   tmp="$(mktemp -d)"
   for package in pi-coding-agent pi-agent-core pi-ai pi-tui; do
     artifact="$tmp/$package"
     mkdir "$artifact"
     npm pack "@earendil-works/$package@$TARGET" --pack-destination "$artifact"
     tar -xzf "$artifact"/*.tgz -C "$artifact"
   done
   ```

   Use `$tmp/<package>/package` only for APIs owned by that package; inspect its docs, examples, and types for the audit.

Stop if the target is unpublished or the published artifact does not contain the claimed API.

## 2. Inventory and assess

Enumerate `extensions/*/package.json`. Every package there must define non-empty `pi.extensions`; do not hardcode the package count. Support libraries under `packages/*` are outside the blanket upgrade unless the release requires a direct change.

For each changelog item, record one decision:

| Decision | Meaning |
| --- | --- |
| `migrate` | Existing extension behavior must use or honor the new API. |
| `regression` | A Pi core fix affects the extension; raise the floor and prove current code works before rewriting it. |
| `no action` | The extension does not own the affected behavior, or Pi instruments/provides it centrally. |

Search extension entry points, direct imports, relevant tests, and the published artifact of each owning package for exact API names; audit each API against its own artifact, not a different Pi package. Do not add no-op handlers, copied model/provider catalogs, speculative features, or compatibility fallbacks.

## 3. Upgrade the dependency baseline

For every extension package:

- keep an existing `@earendil-works/pi-*` peer range unchanged when it already includes the target;
- when unchanged code supports both the existing range and the target, widen the range to include the new tested version without removing the supported lower bound (for adjacent `0.x` lines, for example, `>=0.84.4 <0.86.0`);
- raise the peer floor to `^<target-version>` only when the package actually requires the target contract or a target regression fix; dropping the previous supported range is a breaking change for packages at `1.x` or later;
- use the same range style across all Pi peers in one package;
- do not add a Pi peer unless the package directly imports it;
- preserve unrelated peers such as `typebox`;
- update existing explicit README minimum-version text only when the minimum actually changes, without adding repetitive version prose everywhere.

Do not bump workspace package versions yet. Run `pnpm install --lockfile-only --ignore-scripts` once to update `pnpm-lock.yaml`. pnpm has no unsaved-install equivalent, so use npm only for this temporary target-family probe without creating a package lock:

```bash
set -e
npm install --ignore-scripts --no-save --package-lock=false \
  "@earendil-works/pi-agent-core@$TARGET" \
  "@earendil-works/pi-ai@$TARGET" \
  "@earendil-works/pi-coding-agent@$TARGET" \
  "@earendil-works/pi-tui@$TARGET"
for package in pi-agent-core pi-ai pi-coding-agent pi-tui; do
  test "$(node -p "require('./node_modules/@earendil-works/$package/package.json').version")" = "$TARGET"
done
```

The `test` equality assertion is the gate; `npm ls` output alone is not verification. Run this exact install and assertion again after final dependency/version edits, before final validation. Use the installed target docs/types for implementation. If tests pass but new APIs fail typechecking, verify the actual installed version before changing source; stale `node_modules` is not a compatibility requirement.

## 4. Implement only justified migrations

Apply the smallest source changes from the assessment. For each changed package:

1. trace the existing behavior and all callers;
2. follow the nearest published target example;
3. add or update one high-value regression for the changed contract;
4. update README and `CONTEXT.md` only when behavior or domain language changed;
5. run that package's test and typecheck/build.

Independent runtime packages may be delegated in parallel after the dependency baseline is committed. Keep manifests, workspace versions, and `pnpm-lock.yaml` in one central unit; runtime units must not edit them.

For core fixes classified as `regression`, do not rewrite working source unless the regression fails against the target.

## 5. Re-sync, then version

Before package version bumps, fetch and merge current `origin/main` again with `update-from-main`. This prevents choosing versions relative to a stale main branch. Resolve source conflicts first and regenerate `pnpm-lock.yaml` rather than hand-merging generated lockfile sections.

Record the final base immediately after that sync:

```bash
FINAL_MAIN_SHA="$(git rev-parse origin/main)"
```

Using `FINAL_MAIN_SHA` as the base, identify public packages with published-file changes and choose each required bump. If any internal `@henryqw/*` workspace gets a major bump, update every direct consumer's dependency range to the new major and include every such consumer in the release set, even when only its manifest changes. Give that consumer a patch when it adapts while preserving its own documented contract; the dependency's major version alone does not make the consumer breaking.

Bump each package in the final release set exactly once and only now:

```bash
pnpm --filter ./<root>/<package> version patch --no-git-tag-version
```

Follow `docs/releasing.md` when choosing the bump. In particular, use a major only for an incompatible change to a `1.x` or later package's own documented public contract; use a minor for breaking changes during `0.x`. After all workspace versions and direct consumer ranges are updated, run `pnpm install --lockfile-only --ignore-scripts` to regenerate `pnpm-lock.yaml`, before the final install or any release validation.

## 6. Validate the release set

After the final code, dependency, and version state is stable, repeat the exact target-family install and equality assertion from step 3. The assertion must pass before these checks run once against the final working tree:

```bash
npm ls \
  @earendil-works/pi-agent-core \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
pnpm run check:package-versions
pnpm test
pnpm run typecheck
pnpm run pack:check
git diff --check "$FINAL_MAIN_SHA"
```

Create the final release commit only after these checks pass. Run credentialed live tests or interactive TUI smoke tests only when the changed behavior needs them and the environment supports them. Report any skipped interactive validation explicitly.

If final-main integration changes a package version or published file, recalculate that package's bump and rerun the version check. Do not hide a failed release check with a compatibility path.

## 7. Report

State:

- target Pi version and final main baseline;
- packages with source migrations, regression-only validation, and no action;
- exact validation commands that passed;
- untested live or interactive behavior;
- every package that will release and why;
- shared libraries that will not release.

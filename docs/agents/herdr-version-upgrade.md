# Herdr Version Upgrade

Audit every stable Herdr release (`v*` tags in [`herdrdev/herdr`](https://github.com/herdrdev/herdr/releases)), including patches. Skip preview builds. Herdr is not an npm dependency: our packages call the `herdr` CLI found on `PATH`, so a Herdr release breaks them at runtime, not at install time or during a typecheck. An audit causes a release only when a decision changes a package.

Set `TARGET` to the target version and `BASE` to the last audited version below. Record both, the `origin/main` SHA, the consumer list, decisions, and validation status in `.context/progress.md`.

## 1. Scan for Herdr consumers

Each audit starts with a new scan. Do not use the consumer list from an earlier audit:

```bash
rg -l -i herdr extensions packages --glob '!**/node_modules/**' --glob '!**/dist/**' | cut -d/ -f1-2 | sort -u
```

For each listed package, read the matches and record each contact surface that it has:

| Surface | Examples |
| --- | --- |
| CLI commands and their output | `herdr.run([...])`, `herdr.json([...])` through `@henryqw/pi-herdr`, or a direct `herdr` subprocess |
| Environment variables | `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID` |
| Pi events read by Herdr's Pi integration | `herdr:blocked` |
| Herdr paths and naming | `~/.herdr/worktrees/...` |

A package with only names, prose, or links to other packages is not a consumer. Record its exclusion. Packages in `deprecated/` are out of scope.

For each consumer that requires Herdr, record its minimum Herdr version from its README and from any runtime check, for example `MIN_HERDR_VERSION` in `pi-subagent`. If the two differ, or the minimum is not stated, record a `change`. An optional integration that works without Herdr, such as `pi-ask-question`'s `herdr:blocked` event, states no minimum; audit only its surface.

## 2. Inspect the target release

```bash
set -e
tmp="$(mktemp -d)"
raw=https://raw.githubusercontent.com/herdrdev/herdr
curl -fsSL "$raw/v$TARGET/CHANGELOG.md" -o "$tmp/CHANGELOG.md"
for v in "$BASE" "$TARGET"; do
  curl -fsSL "$raw/v$v/docs/next/api/herdr-api.schema.json" -o "$tmp/schema-raw-$v.json"
  jq -S . "$tmp/schema-raw-$v.json" > "$tmp/schema-$v.json"
  curl -fsSL "$raw/v$v/docs/next/website/src/content/docs/cli-reference.mdx" -o "$tmp/cli-$v.mdx"
done
diff "$tmp/schema-$BASE.json" "$tmp/schema-$TARGET.json" || true
diff "$tmp/cli-$BASE.mdx" "$tmp/cli-$TARGET.mdx" || true
```

Stop if the tag is missing. The schema `protocol` value is the socket API protocol that `pi-subagent` checks. A changelog item is a lead, not proof: confirm it in the schema or the CLI reference diff.

## 3. Audit and implement

Read every changelog section in `(BASE, TARGET]`, including `Breaking Changes`. Compare each item and each schema or CLI change with every consumer surface from step 1. Search the sources and tests for the exact command, field, error code, variable, or event name. Record one decision per item, in this priority order:

| Decision | Action |
| --- | --- |
| `remove` | Herdr now provides the behavior. Delete our workaround or feature, and point the README to Herdr's replacement. |
| `change` | Adapt to changed commands, output, or errors, or use a new Herdr feature to remove probes, retries, polling, or subprocesses. |
| `none` | No consumer is affected. |

Raise a consumer's minimum Herdr version only to adopt a feature or a required fix. Use the first version that provides it. Put the same version in the README and in any runtime check. As with a raised Pi floor, this is a minor release of the consumer. Choose version bumps with [the release runbook](../releasing.md).

## 4. Test the target

Install the target as the active `herdr`, then confirm it with `herdr --version` and `herdr status server`. Run `pnpm test` and `pnpm run typecheck` for each consumer. These tests use stub executors, so they prove only our side of the contract. For each `change` item, and for each consumer command that the changelog, schema, or CLI diff touches, run the affected command or feature live in a Herdr pane. Then release with [docs/releasing.md](../releasing.md).

Run live checks in a separate workspace (`herdr workspace create --cwd <scratch-repo> --no-focus`) on a scratch Git repository with an `origin` remote, a root `package.json` `test` script, a committed `pnpm-lock.yaml`, and `node_modules/` in `.gitignore`. Without these, isolated validation leaves the worktree dirty. Copy any Skills that the Roles require, such as `pi-extension-workbench`, into the scratch repository. Start Pi with only the local consumers so that installed copies do not duplicate them, for example `herdr agent start live --kind pi --pane <pane> -- -ne -e <repo>/extensions/pi-task-models/extensions/task-models.ts -e <consumer entry>...`. Drive the Pi session with `herdr agent prompt`. Child Pi processes that the consumers start load the installed packages, not the local ones. Close the scratch workspace when you finish.

Add an audit log entry, even when every decision is `none`. Report the consumer list, decisions, live checks, and untested surfaces.

## Audit log

Add one entry per audit: the version range, the date, the consumers, and each `remove` or `change` decision with its changelog item. `none` items need no entry. The last entry's upper version is `BASE`.

- Baseline `0.9.3` (2026-10-10): every package that calls the Herdr CLI (`@henryqw/pi-herdr`, `pi-herdr-tools`, `pi-subagent`, and `pi-pr`) raised its minimum to the latest stable Herdr, without an audit of earlier releases.

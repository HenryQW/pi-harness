# Pi Version Upgrade

Audit every published `@earendil-works/pi-*` release, including patches and versions already accepted by peer ranges. Pi patches can add features and breaking changes.

Set `TARGET` to the target version and `BASE` to the last audited version below. Record both, the `origin/main` SHA, decisions, and validation status in `.context/progress.md`.

## 1. Inspect published artifacts

Unpack each relevant package at `TARGET`; add other owning packages to the loop when needed:

```bash
set -e
tmp="$(mktemp -d)"
for package in pi-coding-agent pi-agent-core pi-ai pi-tui; do
  mkdir "$tmp/$package"
  npm pack "@earendil-works/$package@$TARGET" --pack-destination "$tmp/$package"
  tar -xzf "$tmp/$package"/*.tgz -C "$tmp/$package"
done
```

Use `$tmp/<package>/package` only for APIs that package owns. `pi-coding-agent/package/CHANGELOG.md` holds the release notes. A release note is a lead, not proof: verify behavior against the target's published docs, examples, and types. Stop if the target is unpublished or its artifact lacks the claimed API.

## 2. Audit and implement

Read every changelog section in `(BASE, TARGET]`, including `Breaking Changes`. Compare each item with each extension's README and entry points. Search sources, tests, and the owning artifact for exact API, flag, setting, or event names. Include `packages/*` support libraries when an item affects them. Record one decision per item, in this priority order:

| Decision | Action |
| --- | --- |
| `remove` | Pi now provides the behavior. Delete our version in this release: [retire the extension](../releasing.md#retire-a-package), or delete the function or internal code and point the README to Pi's replacement. |
| `change` | Adapt to required changes, or improve performance with fewer hooks, scans, subprocesses, renders, or workarounds. |
| `none` | No extension is affected. |

Do not add runtime version checks. Choose peer ranges with [Pi peer ranges](../releasing.md#pi-peer-ranges).

Implement `remove` items first, then `change` items; record before and after measurements for performance changes in the PR.

## 3. Test the target

Before you release, test the final commit at the target. Each workspace resolves its own pinned Pi packages, so use a temporary workspace override. The trap restores the files also when a check fails:

```bash
(
  set -e
  trap 'git checkout -- pnpm-workspace.yaml pnpm-lock.yaml && pnpm install --frozen-lockfile' EXIT
  printf '\noverrides:\n' >> pnpm-workspace.yaml
  for package in pi-agent-core pi-ai pi-coding-agent pi-tui; do
    printf "  '@earendil-works/%s': %s\n" "$package" "$TARGET" >> pnpm-workspace.yaml
  done
  pnpm install && pnpm test && pnpm run typecheck
)
```

If pnpm rejects the target under `minimumReleaseAge`, add the target to `minimumReleaseAgeExclude` in the same temporary edit. Fix failures in a new commit and repeat the target test. Run live or interactive TUI tests only when the changed behavior needs them. Then release with [docs/releasing.md](../releasing.md).

Add an audit log entry, even when every decision is `none`. Report decisions, the target-run result, untested live or interactive behavior, and npm deprecations pending maintainer action.

## Audit log

Add one entry per audit: the version range, the date, and each `remove` or `change` decision with its changelog item. `none` items need no entry. The last entry's upper version is `BASE`.

- `1.0.1` to `1.0.4` (2026-10-07): all `none`.
- `1.0.4` to `1.1.0` (2026-10-09): `change` for "Added `aborted` to `agent_settled`": `@henryqw/pi-memory` drops deferred work from cancelled runs. All other items `none`. Every Pi-dependent workspace now uses one Pi `1.1.0` package graph, which removes mixed `pi-ai` and `pi-tui` type identities. With the raised floor, `@henryqw/pi-subagent` also removed its obsolete Pi `1.0.0` rejection of `oauth.clientRegistration` `cimd`.

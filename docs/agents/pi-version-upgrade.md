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

### Audit the workbench skill

Also compare each item with [pi-extension-workbench](../../.agents/skills/pi-extension-workbench/SKILL.md) and its `references/`. Record a `change` decision when an item adds, renames, removes, or changes the contract of an event, API, doc, or example that the skill names, or adds a native API that the skill should prefer to custom code. Then check that each doc and example that the skill cites exists in the target artifact:

```bash
(
  cd .agents/skills/pi-extension-workbench
  rg -oN --no-filename '`[A-Za-z0-9_./-]+\.(ts|md)`' SKILL.md references | tr -d '`' | sort -u |
    while read -r path; do
      case "$path" in docs/* | examples/* | dist/*) ;; *) path="examples/extensions/$path" ;; esac
      test -e "$tmp/pi-coding-agent/package/$path" || echo "missing: $path"
    done
)
```

Replace or remove each missing citation. Set the `Last reviewed against Pi` comment in `SKILL.md` to `TARGET`, also when all skill decisions are `none`. Run `python3 .agents/skills/pi-extension-workbench/scripts/validate.py`.

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
  PI_BIN="$PWD/extensions/pi-pr/node_modules/.bin/pi" node evals/run.ts --model <provider/id>
)
```

If pnpm rejects the target under `minimumReleaseAge`, add the target to `minimumReleaseAgeExclude` in the same temporary edit. Fix failures in a new commit and repeat the target test. Run live or interactive TUI tests only when the changed behavior needs them. The last command runs the skill evals with the target Pi before the trap restores the original install (see [evals/README.md](../../evals/README.md)). Report failing cases. Then release with [docs/releasing.md](../releasing.md).

Add an audit log entry, even when every decision is `none`. Report decisions, workbench skill changes, the target-run result, untested live or interactive behavior, and npm deprecations pending maintainer action.

## Audit log

Add one entry per audit: the version range, the date, and each `remove` or `change` decision with its changelog item. `none` items need no entry. The last entry's upper version is `BASE`.

- `1.0.1` to `1.0.4` (2026-10-07): all `none`.
- `1.0.4` to `1.1.0` (2026-10-09): `change` for "Added `aborted` to `agent_settled`": `@henryqw/pi-memory` drops deferred work from cancelled runs, `@henryqw/pi-bark` sends no **Pi finished** notification for cancelled runs, and `@henryqw/pi-prompt-creator` skips automatic analysis after cancellation. All other items `none`. Every Pi-dependent workspace now uses one Pi `1.1.0` package graph, which removes mixed `pi-ai` and `pi-tui` type identities. With the raised floor, `@henryqw/pi-subagent` also removed its obsolete Pi `1.0.0` rejection of `oauth.clientRegistration` `cimd`.
- `1.1.0` to `1.2.0` (2026-10-13): `change` for "`before_agent_start` also fires for `pi.sendMessage(..., { triggerTurn: true })` runs; `BeforeAgentStartEvent` is a union on `messageType`": `@henryqw/pi-herdr-tools` automatic rename ignores custom-message runs, which have no `prompt`. All other items `none`; the peer floor stays `^1.1.0`. Reviewed later (2026-10-15): the workbench skill gets `change` for the `before_agent_start` union, the busy starting run, and `reachesTools`.
- `1.2.0` to `1.3.0` (2026-10-16): `change` for the workbench skill only: "Resumed sessions keep their active tools" adds native restoration and CLI selection guidance; "Fixed tool calls whose final arguments are malformed JSON" adds native rejection and `ToolCall.argumentsError` preservation guidance. All runtime items `none`; the peer floor stays at `1.1.0`. Published artifacts match the installed target, and all skill citations exist. Full target tests, typechecks, and live or interactive checks remain pending.
- `1.3.0` to `1.5.0` (2026-11-03), including published `1.4.0`: `change` decisions:
  - Summary authentication fix: `pi-auto-compact` lets the model registry own authentication and provider overrides. Renderer keybinding fix: `pi-session-recall` uses the injected helper; `pi-subagent` uses its custom component's keybinding manager.
  - Inline blocked status: `pi-task-models` and `pi-subagent` selection screens report a question. Native authorization registration and configuration fixes: `pi-subagent` accepts `oauth.clientRegistration: "auto"` and an initial byte-order mark in `mcp.json`. Usage totals: it preserves `totalFromProvider` and marks a sum provider-reported only when every part is.
  - Schema/import changes: shared `pi-subagent` schemas use TypeBox string enums outside the host. Execution output limits: Pi-typed test results in `pi-codegraph`, `pi-pr`, and `pi-rtk-test` include `truncated`. Packages adapted to the new contracts require Pi 1.5.0 or later and use pinned `1.5.0` development dependencies; unchanged packages can retain older pins.
  - Workbench skill: removed the deleted sandbox citation, corrected section navigation, and recorded schema coercion and limits, renderer helpers and caches, persisted Markdown fields, bounded execution, active-tool restoration/order, summary limits/authentication, native package changelogs, host/standalone imports, authorization registration, provider headers, and inline blocked status. Review marker: `1.5.0`. No retirement: native execution still lacks required process features, and terminal status does not replace Herdr events or Role authorization.
  - Validation: inspected the installed `1.5.0` target and both release sections; all skill file citations and named navigation sections exist; `python3 .agents/skills/pi-extension-workbench/scripts/validate.py` passed its seven resolver cases. Both normal and all-Pi-1.5 target test runs passed 2,028 tests with 2 skipped. Both typechecks, `pnpm run check:package-versions`, `pnpm run docs:validate`, `pnpm run pack:check`, and the source HTML diagram self-check passed. Model-backed target evals passed all 21 cases; 62 of 63 trials passed. Trial 2 of `pi-subagent/read-only-research-direct` failed because the generated task name exceeded 29 characters; the quality case passed 2 of 3. The first eval command timed out after 33 passing trials; remaining cases were run separately. No live provider authentication or interactive terminal/Herdr checks were run. No npm publication or deprecation action occurred.
- `1.5.0` to `1.5.2` (2026-11-12), including `1.5.1`: `change` for authentication cancellation: `pi-auto-compact` rejects aborted summaries. `pi-pr` initializes the native display test fixture. `pi-subagent` recognizes Bun's Windows virtual entry. `pi-add-dir` waits for idle before command reloads. `pi-footer` counts native usage entries. `pi-memory` and `pi-herdr-tools` report blocked status for approval and selection overlays. The workbench records changed overlay, Markdown transformer, schema coercion, read/grep, reload, and session-switch contracts. The native MCP validator does not replace Role-specific security checks and would add a runtime dependency; the adapter remains. No extension retirement was identified. The target suite passed 2,366 tests with 2 skipped, and target typecheck passed. Before these changes, model-backed target evaluation with MiniMax passed 10 of 21 cases and 38 of 63 trials; other models were blocked by quota or region. Live compaction passed on the target candidate. Windows binaries and interactive overlay and session-switch paths were not tested. No npm publication or deprecation action occurred.

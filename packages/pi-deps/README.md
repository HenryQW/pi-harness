# `@henryqw/pi-deps`

Prepare locked Node and uv dependencies whenever Git creates a new worktree for an opted-in repository.

## Why

- **Created for**: Installing locked dependencies whenever Git creates a new worktree in an opted-in repository.
- **Advantage**: Prepares each checkout regardless of which tool created it, without paying install cost at every Pi startup.

## Install

```bash
pi install npm:@henryqw/pi-deps
```

Node 22.19 or newer, Git, and each selected package manager must be available on `PATH` used by Git.

## Supported managers

Only current major versions are supported; older majors are not handled and fall back to the lockfile default below.

| Manager | Command | Lockfile |
| --- | --- | --- |
| npm | `npm ci` | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| Yarn | `yarn install --immutable` | `yarn.lock` (Yarn Classic 1.x is not supported) |
| Bun | `bun install --frozen-lockfile` | `bun.lock`, `bun.lockb` |
| uv | `uv sync --locked` | `uv.lock` |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/deps` | command | Toggle dependency preparation for future worktrees in current repository. |

Run `/deps` once from any worktree to enable preparation through repository's shared `post-checkout` hook. Run it again to disable. Hooks without this package's marker are never overwritten or removed. After updating the package, run `/deps` twice in each opted-in repository to replace the copied hook with the current version. A configured `core.hooksPath` replaces the shared hooks directory, so `/deps` refuses instead of installing where Git would ignore or share the hook.

Only Git-root lockfiles are inspected. npm, pnpm, Yarn, and Bun use frozen installs; uv uses `uv sync --locked`. Node and uv both run when both lockfile types exist. Root npm and uv workspaces remain package-manager concerns; nested independent projects are not scanned.

Creation returns immediately. The hook validates lockfiles synchronously — conflicting Node lockfiles, `packageManager` mismatches, and unsupported declarations still fail the worktree command fast — then a detached installer runs the frozen installs in the background. Its outcome lands in `<worktree gitdir>/pi-deps/status.json` with command output in the adjacent `install.log`; the file is removed once a Pi session reports it. A Pi session opened in the worktree shows an editor widget while installing, auto-dismisses success after five seconds, and keeps install failures visible (including missing executables). Other tools creating worktrees get the same background install but must consume the status file themselves. Already-present `node_modules`, `.pnp.cjs`, or `.venv` are skipped. Worktrees created with `git worktree add --no-checkout` never run `post-checkout`, so they are not prepared. Because installs finish after creation returns, a consumer may start using a worktree before dependencies are ready.

Dependency installation may execute repository-controlled build and install scripts. Enable only repositories you trust.

## Config

| Package-owned editable config | Package-owned generated state |
| --- | --- |
| None | `<worktree gitdir>/pi-deps/status.json` and adjacent `install.log`; do not edit them. |

## Remove

Disable each opted-in repository before removing package because copied Git hook is self-contained:

```text
/deps
```

```bash
pi remove npm:@henryqw/pi-deps
```

## Development

```bash
npm test --workspace @henryqw/pi-deps
npm run typecheck --workspace @henryqw/pi-deps
npm run pack:check --workspace @henryqw/pi-deps
```

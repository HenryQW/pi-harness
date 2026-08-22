# `@henryqw/pi-deps`

Prepare locked Node and uv dependencies whenever Git creates a new worktree for an opted-in repository.

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

Run `/deps` once from any worktree to enable preparation through repository's shared `post-checkout` hook. Run it again to disable. Hooks without this package's marker are never overwritten or removed. After updating the package, run `/deps` twice in each opted-in repository to replace the copied hook with the current version.

Only Git-root lockfiles are inspected. npm, pnpm, Yarn, and Bun use frozen installs; uv uses `uv sync --locked`. Node and uv both run when both lockfile types exist. Root npm and uv workspaces remain package-manager concerns; nested independent projects are not scanned.

Creation waits for installs. Missing executables, conflicting Node lockfiles, `packageManager` mismatches, and install failures make worktree command fail while leaving created worktree available for inspection. Unsupported repositories and already-present `node_modules`, `.pnp.cjs`, or `.venv` are skipped.

Dependency installation may execute repository-controlled build and install scripts. Enable only repositories you trust.

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

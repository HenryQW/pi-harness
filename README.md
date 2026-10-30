# Henry Pi Harness

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/HenryQW/pi-harness/blob/main/LICENSE)
[![npm profile](https://img.shields.io/badge/npm-%40henryqw-CB3837.svg?logo=npm)](https://www.npmjs.com/~henryqw)

Pi extensions for pull requests, subagents, memory, Herdr panes, and other agent workflows. These extensions use strong workflow preferences, so read each package guide before you install it. The guides are at [pi.henry.wang](https://pi.henry.wang).

## Install

```sh
curl -fsSL https://pi.henry.wang/install.sh | sh
```

The installer does these steps:

1. Installs Pi and Herdr if they are missing, and stops if a version is below the minimum.
2. Shows the installed Pi and Herdr versions and asks before it updates either tool.
3. Asks which extensions to install: all (the default), a selection, or none.
4. Installs the selected extensions from npm.

Without an interactive terminal, the installer installs all extensions and does not update Pi or Herdr.

| Option | Effect |
| --- | --- |
| `--all` | Install all extensions without a prompt. |
| `--update` | Approve available Pi and Herdr updates without a prompt. |

```sh
curl -fsSL https://pi.henry.wang/install.sh | sh -s -- --update
```

To install one extension, use Pi directly, for example `pi install npm:@henryqw/pi-pr`.

## Config files

An extension that you can configure keeps its files in `~/.pi/agent/config/<package>/`. `~/.pi/agent` is the default Pi agent directory. If you set `PI_CODING_AGENT_DIR`, Pi uses that directory.

Each config file is optional, unless its package guide says otherwise. These rules apply to each file:

- The file must be a JSON object in valid UTF-8, at most 64 KiB.
- Pi shows each problem one time in each session, with the file path and the reason. Without a UI, the warning goes to stderr.
- Pi ignores unknown keys.
- A misspelled key, such as `maxToken` when `maxTokens` is missing, makes that setting invalid.
- An invalid setting uses its default.
- A file problem makes the whole file invalid: malformed JSON, invalid UTF-8, a file larger than 64 KiB, an unreadable file, or a non-object root. All settings then use their defaults.
- Reading a file never changes it. Only the commands that a package guide names write the file.

Some settings disable a feature when they are invalid, and do not use a default. Each package guide gives these settings, what a file problem does, and when edits apply. For the exact rules, see [the pi-config-store load rules](https://pi.henry.wang/packages/pi-config-store#load-rules).

## Extension dependencies

Each row shows an active extension. A filled square marks a **direct** runtime or peer dependency on the package above its column. Empty rows have no internal dependencies. Column counts show how many extensions depend directly on that package.

![Matrix showing 27 direct internal dependency edges across 20 active Pi extensions and seven dependency packages; Pi Subagent uses Pi Task Models for routes and Pi Herdr for selected-checkout admission; Pi Cron uses Pi Subagent for explicit Role resources and server exposure rules; the optional Pi Goal query adds no dependency edge](./docs/extension-dependencies.svg)

The matrix excludes development and transitive dependencies, deprecated extensions, and `@deprecated/`.

## Development

The repository is a pnpm workspace. Extensions are in `extensions/`, support libraries are in `packages/`, and the documentation website is in `website/`. Archived packages are in `deprecated/` and are not part of the workspace.

```sh
pnpm install
pi -e ./extensions/pi-undo/extensions/undo.ts
```

`pnpm install` also builds the support libraries. Use `pi -e` with an extension entry file to test that extension from source.

CI runs these checks on each pull request:

| Command | Check |
| --- | --- |
| `pnpm test` | Repository script tests, eval tests, and the tests of each workspace package. |
| `pnpm run typecheck` | TypeScript types in each package. |
| `pnpm run pack:check` | The npm artifact of each published package. |
| `pnpm run docs:validate` | The installer list, README structure, Simplified Technical English rules, and the website. |
| `pnpm run check:package-versions` | Version bumps for changed published files. |

To release a package, follow [the release runbook](https://github.com/HenryQW/pi-harness/blob/main/docs/releasing.md).

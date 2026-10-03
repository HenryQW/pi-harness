# Henry Pi Harness

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/HenryQW/pi-harness/blob/main/LICENSE)
[![npm profile](https://img.shields.io/badge/npm-%40henryqw-CB3837.svg?logo=npm)](https://www.npmjs.com/~henryqw)

Highly opinionated Pi harness.

See [the doc](https://pi.henry.wang).

## Install

```sh
curl -fsSL https://pi.henry.wang/install.sh | sh
```

The installer shows installed Pi and Herdr versions. It asks before updating either tool. After selected replacement packages install successfully, it removes their retired npm sources: `pi-herdr-clone` replaces `pi-herdr-done`, and `pi-footer` replaces `pi-open-in`. The existing Open In config stays in place.

Use `--update` to approve available updates without a prompt:

```sh
curl -fsSL https://pi.henry.wang/install.sh | sh -s -- --update
```

## Extension dependencies

Each row is an active extension; a filled square marks a **direct** dependency on the package named above its column. Empty rows have no internal dependencies. Column counts show how many extensions depend directly on that package.

![Matrix showing direct workspace dependencies for all 20 active Pi extensions](./docs/extension-dependencies.svg)

Deprecated extensions and `@deprecated/` are excluded.

# `@henryqw/pi-config-store`

Build validated JSON configuration stores for Pi extensions, with shared paths and atomic mutations.

This package is an extension-author library. End users do not install it directly in Pi.

## Why

- **Created for**: Extension authors who need one safe home for user-editable JSON.
- **Advantage**: Reuse path, validation, locking, and atomic-write behavior instead of rebuilding it.

## Install

Add it to an extension package with your package manager. Do not run `pi install` for this library.

## Use

Create a JSON store with a default factory and an owner parser.

```ts
import {
  createConfigStore,
  extensionConfigDir,
  extensionConfigPath,
} from "@henryqw/pi-config-store";

type Config = { enabled: boolean };

const parseConfig = (value: unknown): Config => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Invalid config");
  }
  return value as Config;
};

const home = extensionConfigDir("my-extension");
const path = extensionConfigPath("my-extension");

const store = createConfigStore({
  extensionId: "my-extension",
  defaults: () => ({ enabled: true }),
  parse: parseConfig,
});

const loaded = store.loadSync();
await store.save({ enabled: false });
const updated = await store.update((current) => ({
  ...current,
  enabled: !current.enabled,
}));
await store.remove();
```

`parseConfig` returns validated `Config` data or throws.

| Surface | Type | Purpose |
| --- | --- | --- |
| `extensionConfigDir(extensionId, agentDir?)` | function | Returns an extension's config home. |
| `extensionConfigPath(extensionId, agentDir?)` | function | Returns the home’s `config.json` path. |
| `createConfigStore({ extensionId, agentDir?, defaults, parse })` | function | Creates a store. `defaults` is `() => T`; `parse` is `(value: unknown) => T`. |
| `store.path` | `string` | Gives the store's `config.json` path. |
| `store.loadSync()` | `{ source: 'file' \| 'missing'; value: T }` | Loads and validates the current value. |
| `store.save(value: T)` | `Promise<void>` | Validates and replaces the whole config under a lock. |
| `store.update(mutator: (current: T) => T)` | `Promise<T>` | Locks a read-modify-write operation and returns the updated value. |
| `store.remove()` | `Promise<void>` | Removes only the store's `config.json` file. |

By default, helpers use Pi's `getAgentDir()`.

- The config home is `getAgentDir()/config/<extension-id>/`.
- The default JSON file is `getAgentDir()/config/<extension-id>/config.json`.
- Pass `agentDir` to use another agent directory.
- Path helpers return paths without filesystem side effects.

An extension ID must be one lowercase path component.
The helpers and store reject IDs with path separators or multiple components.

JSON reads and writes have a 64 KiB limit.
UTF-8 decoding is strict.
The `parse` function validates parsed `unknown` data.
Values are validated before mutations are written.

A valid file returns `{ source: 'file', value }` from `loadSync()`.
A missing file returns `{ source: 'missing', value: defaults() }`.
A missing read does not create or write a file.

A present malformed or schema-invalid file is not missing.
Invalid UTF-8, oversized JSON, invalid JSON, and parser failures throw errors.
Malformed and schema-invalid files remain unchanged.

`save`, `update`, and `remove` are asynchronous.
Every mutation uses a lock.
Writes use a same-directory temporary file and atomic rename.

Repository default: most extension owners may assume one active config writer unless their package explicitly documents multi-process or concurrent writers.
Under that consumer assumption, reload the extension after a manual or external edit before its next write.
A stale in-memory full replacement is outside the supported workflow.

`store.save(value)` locks and replaces the whole config.
The lock serializes writes, but does not merge fields from stale values.

Use `store.update(mutator)` for read-modify-write when an extension supports multiple processes, sessions, or writers.
Use it also to preserve concurrent field changes.
It reads the latest valid config under the store lock.

For custom formats, call `extensionConfigDir(extensionId, agentDir?)`.
Use the format's native library inside that directory.

Only the owning extension writes its config home.
Consumers use the owner's API or namespaced Pi events.
They do not read or write another extension's files directly.

# `@henryqw/pi-config-store`

Give extension authors one safe home for Pi extension files. A bad user config never stops an extension and is never silent: the store reports each problem and uses safe defaults, or it disables the extension when a default is not safe. End users do not install this package directly in Pi.

## Install

```bash
npm install @henryqw/pi-config-store
```

Use your extension package's package manager. Do not run `pi install` for this library. Requires `@earendil-works/pi-coding-agent` 1.1.0 or later in the 1.x series.

## Use

Declare each top-level key in a field table. Give each optional field a default. Mark a key as `required` when no safe default exists.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigStore, field, parsers, registerConfigReporting, required } from "@henryqw/pi-config-store";

export default function (pi: ExtensionAPI) {
  const store = createConfigStore({
    extensionId: "my-extension",
    fields: {
      token: required(parsers.string({ trim: true })),
      split: field(parsers.oneOf(["right", "down"] as const), "right"),
      directory: field(parsers.absolutePath(), "/var/my-extension", { onInvalid: "disable" }),
      overrides: field(parsers.record(parsers.boolean(), { key: parsers.absolutePath() }), {}),
    },
  });
  const reporter = registerConfigReporting(pi, [store]);

  pi.registerCommand("my-command", {
    handler: async (_args, ctx) => {
      const loaded = store.loadSync();
      reporter.report(ctx, store, loaded);
      if (loaded.status === "disabled") return;
      // Use loaded.value.
    },
  });
}
```

`registerConfigReporting` shows launch problems. Call `reporter.report` after each lazy read, so that new problems also show once.

### Load rules

| Problem | Result |
| --- | --- |
| Unknown key | The store ignores the key and reports an `unknown-key` issue. |
| Near-miss key: an unknown key that misspells a declared key that is not in the file | The store reports an `invalid-value` issue on the declared key, such as `maxTokens: unknown key "maxToken"; did you mean "maxTokens"?`. It then applies the rule of that field: the default, or a disabled config for a `required` field or a field with `onInvalid: "disable"`. |
| Invalid optional value | The store uses the field default and reports an `invalid-value` issue. |
| Invalid nested entry in `parsers.record`, `parsers.array`, or `parsers.object` | The store drops only that entry and reports it. |
| Invalid value in a field with `onInvalid: "disable"` | The config is disabled. |
| Missing or invalid `required` field | The config is disabled. This includes a missing file. |
| `check` failure | The store reports an `invalid-config` issue and uses all defaults. The config is disabled when a field is required or has `onInvalid: "disable"`. |
| Malformed JSON, invalid UTF-8, file larger than 64 KiB, unreadable path, path that is not a regular file (such as a directory, FIFO, or device), or non-object root | The store reports one issue for the file and uses all defaults. The config is disabled when a field is required or has `onInvalid: "disable"`. |

A near-miss key is equal to the declared key except for letter case, or it has a small edit distance from the declared key. The limit is one edit (insert, delete, replace, or swap of two adjacent characters) for each three characters of the declared key, and a maximum of two edits. Thus, a declared key of one or two characters matches only a different letter case. The rule applies to each field table, also in `parsers.object`, but not to the keys of `parsers.record` or `entries`.

`loadSync()` does not throw for file content or I/O problems, and it never writes.

When the config is disabled, disable the extension's features. Keep config repair commands available, so that the user can fix the file.

### Launch reporting

On each `session_start`, `registerConfigReporting(pi, stores)` loads each store. It shows one notification for each file that has issues:

| Status | Severity | Text |
| --- | --- | --- |
| `disabled` | `error` | `<extension-id> disabled (<path>): <issues>` |
| `ok` with issues | `warning` | `<extension-id> config issues (<path>): <issues>; defaults replace invalid settings.` |

When `ctx.hasUI` is false, the reporter writes the same text to stderr. Each issue shows one time in each session. The reporter identifies an issue by its file path, kind, key, and message. All reporters in the Pi process share this record, also the reporters of other extensions. Thus, when two extensions report the same file, each issue shows one time. A new `session_start` event starts a new record.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `createConfigStore({ extensionId, agentDir?, fileName?, fields, check? })` | function | Creates a store for a JSON object with a field table. |
| `createConfigStore({ extensionId, agentDir?, fileName?, entries, check? })` | function | Creates a store for a JSON object whose keys are entry names. `entries` is normally `parsers.record(...)`. A missing file gives `{}`. |
| `field(parse, fallback, { onInvalid? })` | function | Declares an optional field. `onInvalid: "disable"` disables the config instead of using `fallback` for an invalid value. |
| `required(parse)` | function | Declares a required field. |
| `parsers` | object | Gives reusable field parsers. Refer to [Field parsers](#field-parsers). |
| `FieldParser<T>` | type | `(raw: unknown, report: Report) => T`. Throw to reject the whole value. |
| `Report` | type | `(path: KeyPath, message: string, kind?: "unknown-key" \| "invalid-value") => void`. Reports a dropped nested entry. `path` is relative to the parsed value. |
| `ConfigLoad<T>` | type | `{ status: "ok"; source; value; issues }` or `{ status: "disabled"; source; issues }`. `source` is `"file"` or `"missing"`. |
| `ConfigIssue` | type | `{ kind, key, message }`. `key` is a key path such as `jobs[2].cwd`, or `""` for the whole file. |
| `formatConfigIssues(issues)` | function | Formats issues as `key: message; ...`. |
| `registerConfigReporting(pi, stores)` | function | Reports issues on `session_start` and returns a `ConfigReporter`. |
| `reporter.report(ctx, store, result)` | method | Shows issues in `result` that the session did not show yet. |
| `store.extensionId` | `string` | Gives the owner extension ID. |
| `store.path` | `string` | Gives the store's file path. |
| `store.loadSync()` | `ConfigLoad<T>` | Loads and validates the current file. |
| `store.save(value: T)` | `Promise<void>` | Validates `value` strictly and replaces the whole file under a lock. |
| `store.update(mutator: (current: T) => T)` | `Promise<T>` | Locks a read-modify-write operation and returns the written value. |
| `store.replaceIfUnchanged(snapshot, value: T)` | `Promise<void>` | Validates `value` strictly and replaces the whole file under a lock, but only when the file has not changed since `snapshot`. |
| `store.remove()` | `Promise<void>` | Removes only the store's file. |
| `extensionConfigDir(extensionId, agentDir?)` | function | Returns an extension's config home. |
| `extensionConfigPath(extensionId, agentDir?)` | function | Returns the home's `config.json` path. |
| `readTextFileBoundedSync(path, maxBytes)` | function | Reads bounded strict UTF-8 text synchronously. |
| `readTextFileBounded(path, maxBytes, options?)` | async function | Reads bounded strict UTF-8 text. `options.signal` can cancel it. |
| `writePrivateTextFileAtomically(path, contents, options?)` | async function | Flushes and atomically replaces UTF-8 text. `options.signal` can cancel it. |

### Field parsers

| Parser | Accepts |
| --- | --- |
| `parsers.boolean()` | `true` or `false`. |
| `parsers.number({ min?, max?, greaterThan?, lessThan? })` | A finite number in range. `min` and `max` are inclusive. |
| `parsers.integer({ min?, max?, greaterThan?, lessThan? })` | A safe integer in range. |
| `parsers.string({ trim? })` | A string with non-whitespace text. `trim: true` removes surrounding whitespace. |
| `parsers.absolutePath()` | An absolute path without control characters. |
| `parsers.oneOf(values)` | One of `values`. |
| `parsers.nullable(parse)` | `null`, or a value that `parse` accepts. |
| `parsers.object(fields)` | A nested object with its own field table. A missing or invalid required nested field rejects the object. |
| `parsers.record(value, { key? })` | A map. A rejected key is an `unknown-key` issue. A rejected value is an `invalid-value` issue. The store drops the entry in both cases. |
| `parsers.array(item, { unique? })` | An array. The store drops a rejected item. With `unique`, it drops a later item that has the same identity. |

Write other rules as a `FieldParser`. Write cross-field rules in `check`.

By default, helpers use Pi's `getAgentDir()`. Pass `agentDir` to use another agent directory. Path helpers return paths without filesystem side effects.

For custom files that are not hand-edited JSON, such as generated state, use `extensionConfigDir` and the bounded text helpers. The text helpers do not parse data, handle missing files, or lock access. The owning extension controls their format, schema, recovery, and lock policy.

Only the owning extension writes its config home. Consumers use the owner's API or namespaced Pi events. They do not read or write another extension's files directly.

## State and storage

- The config home is `getAgentDir()/config/<extension-id>/`.
- The default JSON file is `getAgentDir()/config/<extension-id>/config.json`. Use `fileName` for another hand-edited JSON file in the same home, such as `presets.json`.
- A missing file without required fields gives `{ status: "ok", source: "missing", value, issues: [] }` with the defaults. The store does not create a file.

`save`, `update`, and `remove` are asynchronous. Every mutation uses a lock. Writes use a same-directory temporary file and atomic rename.

## Limits and recovery

An extension ID must be one lowercase path component. A `fileName` must be one JSON file name. The helpers and store reject other values.

JSON reads and writes have a 64 KiB limit. UTF-8 decoding is strict.

Reads never change a file. A malformed or invalid file stays unchanged until the user edits it or an explicit write replaces it.

`store.update(mutator)` refuses a file that has any issue or a disabled config. It throws an error that gives the path and the issues, and it does not change the file. `store.save(value)` is an explicit full replacement. It validates `value` with the load rules and throws on any issue. It replaces a malformed file. Parsers of a store that writes must accept their own output.

A direct text read requires `maxBytes` to be a positive safe integer. It consumes at most `maxBytes + 1` bytes and rejects a larger file. Invalid UTF-8 throws, and missing-file errors pass through unchanged.

A direct text write creates or restricts its parent directory to mode `0700` where supported. It writes a same-directory temporary file at mode `0600`, flushes it, then renames it. Failures before rename clean the temporary file. A successful rename is committed, so later cancellation does not turn success into an error.

Repository default: most extension owners can assume one active config writer. Under that assumption, reload the extension after a manual or external edit before its next write. A stale in-memory full replacement is outside the supported workflow.

`store.save(value)` locks and replaces the whole config. The lock serializes writes, but does not merge fields from stale values. Use `store.update(mutator)` when an extension supports multiple processes, sessions, or writers, or to keep concurrent field changes. It reads the latest config under the store lock.

To repair a file that has issues from a value that the user confirmed earlier, use `store.replaceIfUnchanged(snapshot, value)`. `snapshot` must be a `loadSync()` result of a store for the same file; another object throws a `TypeError`. Under the lock, the store reads the file again and compares all its bytes with the bytes that `snapshot` read. A missing file matches only a missing file. If the file changed, the method throws `Config at <path> changed since it was read; nothing was written. Read it again and retry.` and does not change the file.

A load reads at most 64 KiB + 1 byte, and it does not open a FIFO in a way that blocks. Thus, a snapshot of a file that is larger than 64 KiB, unreadable, or not a regular file cannot prove the file contents. For such a snapshot, the method throws `Config at <path> was not read completely (<reason>), so it cannot be replaced safely; nothing was written. Fix, shrink, or remove the file, then retry.` and does not change the file.

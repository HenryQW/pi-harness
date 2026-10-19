# `@henryqw/pi-bark`

Get [Bark](https://bark.day.app) push notifications when Pi finishes, fails, or needs input.

## Install

```bash
pi install npm:@henryqw/pi-bark
```

1. Open the Bark App.
2. Copy its test URL.
3. Get the Device Key after the host, without sample content such as `/Test`.
4. Run `/set-bark` in Pi.

For `https://api.day.app/your-device-key/Test`, use:

```text
/set-bark your-device-key
```

For a self-hosted server, use:

```text
/set-bark your-device-key https://bark.example.com
```

Treat the Device Key as a secret. Anyone with it can send push notifications to your device.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-herdr-tools`](https://pi.henry.wang/extensions/pi-herdr-tools) | Improves | Adds the same Pi session title to automatic Bark status notifications. |

## Use

Run `/copyb` without arguments to copy the latest Pi response to your clipboard and send it to Bark.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/bark <on\|off\|inherit> \| default <on\|off>` | command | Sets the current CWD override or notification default. |
| `/copyb` | command | Copies and sends the last agent message. |
| `/set-bark <device-key> [server-url]` | command | Saves the Device Key and Server URL. |
| `pi-bark-key [--force \| --disable]` | command | Generates, replaces, or disables the Custom Encryption Key. |

All commands are for users. Run `/` commands in Pi and `pi-bark-key` in a terminal.

`/copyb` selects the same text as Pi's `/copy`, then trims outer whitespace. Markdown, code blocks, internal spacing, and line breaks stay unchanged. After copying, it sends a Bark V2 request to `<serverUrl>/push`. Without Push Encryption, the JSON uses standard Bark parameters:

```json
{
  "device_key": "your-device-key",
  "body": "the last agent message"
}
```

![Manual /copyb and automatic notifications share a sender. Push Encryption protects content; device_key stays plaintext. HTTPS protects transport.](./docs/push-encryption-flow.svg)

### Automatic status notifications

| Notification | When it sends |
| --- | --- |
| **Pi needs input** | Pi opens a blocking prompt, including `ask_question`. Closing a prompt sends nothing. |
| **Pi failed** | The run ends with an unrecovered failure and will not continue automatically. |
| **Pi finished** | The run ends normally and will not continue automatically. |

The last agent response decides the outcome: provider errors mean failure; successful retries clear them. Failed compaction during a run, including overflow recovery, also means failure. Each run starts clean; earlier runs and other branches do not affect it. Failed idle `/compact` sends nothing.

Cancelled runs, including Escape, and cancelled compactions send no settled notification. Input notifications and `/copyb` remain available. A new run cancels a pending settled notification.

Status notifications contain the Pi session name (`Unnamed` if unset), but no prompt, agent output, or error text. With `pi-herdr-tools`, Herdr shows the same name. pi-bark never calls Herdr or reads its state.

Automatic notifications default to enabled. Run `/bark off` or `/bark on` for a CWD override; `/bark inherit` removes it. `/bark default off` changes the default for CWDs without overrides. These global config settings do not affect `/copyb`.

## Config

Package-owned: `~/.pi/agent/config/pi-bark/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `serverUrl` | Bark server base URL. | HTTP or HTTPS URL; optional path, no query or fragment delimiter. | Required. `/set-bark` writes `"https://api.day.app"` if omitted. |
| `deviceKey` | Receiving Bark App installation. | Non-empty string. | Required. |
| `encryption` | Custom Encryption Key and Bark settings. | AES256-GCM object or `null`. | Required. Commands write `null` to new files to disable Push Encryption. |
| `statusNotifications` | Notification default and CWD overrides. | Global boolean default; absolute-CWD boolean overrides. | Enabled; no overrides. |

Changes apply on the next command or status event without restart. Queued notifications retain event-time settings.

### Push Encryption

Optional Push Encryption prevents the Bark server and Apple Push Notification service from reading content in all pushes, including `/copyb` and status notifications.

1. Configure the Device Key with `/set-bark`.
2. Generate and save a Custom Encryption Key:

   ```bash
   npx --yes --package=@henryqw/pi-bark -- pi-bark-key
   ```

   `npx` temporarily downloads the package and runs `pi-bark-key`. It saves the key to config and prints it once.

3. Open **Bark App → Push Encryption**.
4. Enter these settings:

   | Setting | Value |
   | --- | --- |
   | Algorithm | `AES256` |
   | Mode | `GCM` |
   | Padding | `noPadding` |
   | Key | Generated 32-character, 32-byte ASCII key. |

5. If Bark requires an IV, enter any 12 ASCII characters, such as `000000000000`.
6. Save the settings.
7. Run `/copyb`; confirm Bark shows the exact last agent message, not `Decryption Failed`.

The saved IV is an older-version placeholder. Each push uses a new 12-byte IV, sent with Ciphertext. Bark uses this per-push value. pi-bark appends the GCM authentication tag before Base64 encoding.

Never paste key command output into shared logs: the Custom Encryption Key can decrypt your push content.

The command preserves existing keys. To replace one, run this command and update the Bark App:

```bash
npx --yes --package=@henryqw/pi-bark -- pi-bark-key --force
```

To disable Push Encryption, run this command and disable it in the Bark App:

```bash
npx --yes --package=@henryqw/pi-bark -- pi-bark-key --disable
```

App and pi-bark settings must match. Config has this shape; use `"encryption": null` to disable encryption:

```json
{
  "serverUrl": "https://api.day.app",
  "deviceKey": "your-device-key",
  "encryption": {
    "algorithm": "AES256",
    "mode": "GCM",
    "padding": "noPadding",
    "key": "your-32-character-custom-key"
  },
  "statusNotifications": {
    "defaultEnabled": true,
    "cwdOverrides": {
      "/srv/quiet-project": false
    }
  }
}
```

Use HTTPS. HTTP exposes the Device Key and, without Push Encryption, push content. Push Encryption never protects the Device Key.

Missing config stays missing until a command writes it. `/set-bark` preserves encryption and notification settings. Running `pi-bark-key` first writes `"deviceKey": null`; pi-bark stays disabled until `/set-bark`. Writes are private and atomic. Pi commands never print the Device Key, Server URL, or Custom Encryption Key.

## Limits and recovery

Bark and Apple Push Notification service limit payload size. pi-bark never truncates content; oversized messages return a Bark error. `/copyb` waits at most 15 seconds. Failed pushes do not undo the clipboard copy.

Config checks occur at startup and each read, without writing. Each problem shows once per session:

| Problem | Result and recovery |
| --- | --- |
| Unknown key or invalid `statusNotifications` | Warns, ignores unknown keys or uses the affected value's default, and continues sending. |
| Missing file or invalid/missing `deviceKey` | Disables sending. Run `/set-bark`. |
| Invalid/missing `serverUrl`, including `serverURL` | Disables sending, never substitutes the public server that would receive your Device Key. Run `/set-bark` with the correct URL. |
| Invalid/missing `encryption`, including `encyption` | Disables sending, never substitutes unencrypted content. Run `pi-bark-key --force` or `pi-bark-key --disable`. |
| Malformed JSON or non-object file | Disables sending. Fix or move the file. |

Disabled pi-bark reports errors. `/set-bark` and `pi-bark-key` remain available; `/bark` reports the problem without writing. Notification settings cannot enable a disabled configuration.

Before writing, commands report new problems through Pi notifications or key-script stderr. Repairable files are replaced; unknown keys and invalid notification entries are removed. Concurrent file changes stop the write with an error; run the command again.

Commands preserve malformed files. They stop if a required key is invalid or missing and the command cannot set it. `/set-bark` sets `serverUrl` and `deviceKey`; `pi-bark-key --force` and `pi-bark-key --disable` set `encryption`. Fix the file or use the matching repair command.

See Bark's [Push Encryption documentation](https://github.com/Finb/Bark/blob/master/docs/en-us/encryption.md).

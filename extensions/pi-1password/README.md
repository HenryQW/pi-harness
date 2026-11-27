# `@henryqw/pi-1password`

Approve 1Password requests on the Mac in front of you while Pi runs on another computer. Pi can list vault and item metadata and run approved actions.

## Install

```bash
pi install npm:@henryqw/pi-1password
```

Install the command line interface (CLI) on the Approval Mac.

```bash
npm install --global @henryqw/pi-1password
```

Use Node.js 22.19.0 or later. Install [Herdr](https://herdr.dev/) on the Pi host to discover remote Macs. On each Approval Mac, enable [1Password desktop integration](https://1password.dev/cli/app-integration/) and put `op` in `/opt/homebrew/bin` or `/usr/local/bin`.

### Connect another Mac

The **Pi host** runs your Pi session. The **Approval Mac** runs `op` and displays the 1Password prompt. In the commands below, run each step on the named computer.

| Connection | Purpose |
| --- | --- |
| Pi host to Approval Mac | Herdr provides the host address. Pi uses Secure Shell (SSH) to check macOS and the signed `op` command. |
| Approval Mac to Pi host | The approval terminal starts the reverse SSH tunnel. Requests travel from the Pi host socket to `op` on the Approval Mac. |

Both connections need working SSH keys and known host keys. The Pi host must allow reverse Unix socket forwarding.

1. On the Pi host, run `/1password` to find the saved Mac and its profile ID. The picker shows the ID in parentheses.
2. Create a private directory on the Pi host, under a directory your user controls.

   ```bash
   mkdir -m 700 "$HOME/.pi-1password"
   printf '%s\n' "$HOME/.pi-1password/work.sock"
   ```

3. Add the profile ID in [Config](#config). Use the printed path for `socket`.
4. In a local terminal on the Approval Mac, start the connection. Replace the host alias and the socket path with your values.

   ```bash
   pi-1password serve pi-host /home/user/.pi-1password/work.sock
   ```

5. Keep that terminal open. On the Pi host, run `/1password` and select the Mac.
6. Ask Pi to list vaults for your account. If 1Password prompts, approve the request on the Approval Mac. Check that the result names the selected Mac.

## Use

Select the Approval Mac in each Pi process. Select it again when you move to another Mac. For lists on the Pi host itself, run `/1password local` on macOS.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/1password` | Pi command | Show the current selection and open the picker. It lists reachable, enabled Herdr Macs with `op`. It includes the local Mac if `op` is available. |
| `/1password <machine>` | Pi command | Select a saved Herdr machine by label or profile ID. Use `/1password local` to select the macOS Pi host. |
| `onepassword_list` | Pi tool | List vaults or items. Set `account` to select an account and `vault` to limit an item list. |
| `onepassword_action` | Pi tool | Run an approved action by name on the selected remote Mac. Pi receives only its status. |
| `op` | Pi skill | Select the correct account and handle 1Password data safely. |
| `pi-1password serve <ssh-host> <remote-socket> [--actions-file <absolute-path>]` | Shell command | Start a reverse Secure Shell (SSH) connection from the Approval Mac. `--actions-file` loads named grants there. |

If you use more than one account, give Pi the account sign-in address when you request a list. Pi includes vault and item names in its context. Use a specific vault to limit item names.

### Verify a fresh approval

1. Lock 1Password on the selected Approval Mac to end its existing approvals.
2. In Pi, ask for a vault list for one account. Check the account in the prompt on the Approval Mac and approve it.
3. Ask for a second list for the same account within 10 minutes. Both lists must succeed. The second request should reuse the approval if the app stayed unlocked.

### Approve an action

An action makes an HTTPS GET request from a remote Approval Mac. It sends one credential to one configured URL. Pi receives completion status for a 2xx response. Redirects fail, and the response body stays on the Approval Mac.

1. Create a file on the Approval Mac with mode `0600`. Keep it outside synced directories and paths that the Pi host can change.
2. Add each action to the file. Use vault and item identifiers in `reference` when possible. Store the reference only.

   ```json
   {
     "check-service": {
       "account": "example.1password.com",
       "reference": "op://vault-id/item-id/credential",
       "url": "https://api.example.com/status",
       "header": "bearer"
     }
   }
   ```

   | Field | Value |
   | --- | --- |
   | Action name | Start with a lowercase letter. Use up to 64 lowercase letters, digits, or hyphens. |
   | `account` | 1Password sign-in address or account identifier on the Approval Mac. |
   | `reference` | Exact 1Password field reference. |
   | `url` | Exact HTTPS destination. Use a service you trust with this credential. |
   | `header` | `bearer` sends `Authorization: Bearer <value>`. `x-api-key` sends `X-API-Key: <value>`. |

3. Start the Approval Terminal with that file. Use the same socket as in [Connect another Mac](#connect-another-mac).

   ```bash
   pi-1password serve pi-host /home/user/.pi-1password/work.sock --actions-file "$HOME/.config/pi-1password/actions.json"
   ```

4. Select the remote Mac with `/1password`. Ask Pi to run `check-service`.

Any process under the Pi host user can invoke the granted actions while the tunnel is open. Close the terminal to revoke access. Restart it to load changes to the file.

For isolation, give the Herdr profile a separate, unprivileged macOS login. The Pi host must lack shell access to the desktop account that runs the Approval Terminal.

## Flow

| Step | Computer | Action |
| --- | --- | --- |
| Select | Pi host | Select a Mac with `op` from the saved Herdr machines or select the local Mac. |
| Request | Pi host | Send a list request or action name through the private socket and reverse SSH connection. |
| Approve | Approval Mac | Run native `op`. The 1Password app prompts there when it needs authorization. |
| Use | Approval Mac | For an action, send the credential to the configured HTTPS service. |
| Return | Pi host | Return list metadata or action status to Pi. |

1Password authorizes each account in the approval terminal separately. Authorization expires after 10 minutes of inactivity. It also expires 12 hours after the initial approval. Lock 1Password to revoke its approvals. Close the approval terminal to disconnect Pi. [1Password approval rules](https://1password.dev/cli/app-integration-security/)

## Config

Package-owned path `~/.pi/agent/config/pi-1password/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `targets` | Socket settings by Herdr machine profile ID. | Copy the ID from `/1password` or `herdr machine list --json`. The `--json` flag requests structured output. | Empty |
| `targets.<id>.socket` | Socket on the Pi host. | Unique absolute path of at most 100 bytes. Use letters, digits, dots, slashes, underscores, and hyphens. | Required |

For example, use `{"targets":{"example-profile-id":{"socket":"/home/user/.pi-1password/work.sock"}}}` and replace `example-profile-id` with the saved profile ID.

Edit the file on the Pi host. The next request uses the new values. A config issue blocks requests until you fix it. [Config files](https://pi.henry.wang/overview#config-files)

## Limits and recovery

| What you see | What to check |
| --- | --- |
| Mac missing from the picker | Enable its Herdr profile. Check SSH access, macOS, and the signed `op` installation. Discovery needs no account access. |
| `socket setup required` | Add the socket path under that Mac's profile ID. |
| Mac disconnected | Check that `pi-1password serve` is running on the Approval Mac. Check the SSH host and socket permissions if it stopped. |
| Route changed or wrong Mac | Check the profile and socket path. Select the Mac again with `/1password`. The bridge checks the Mac's hardware identifier before each request. |
| Approval did not complete | Check the selected Mac for a 1Password prompt. Check desktop integration and the account if no prompt appears. |
| Approval Mac busy | Wait for the current request to finish. Each approval terminal handles one request at a time. |
| Approved action failed | Check the account and field reference on the Approval Mac. Check that the configured service returns a 2xx response. |

- Use a distinct socket path for each Mac. The Pi user must own the private socket directory (`0700`) and socket (`0600`).
- Use a path without symbolic links. Parent directories must belong to the Pi user or root and prevent other users from replacing entries.
- If an old socket remains, verify that its tunnel has stopped before you remove it.
- A request can take up to 60 seconds on the Approval Mac.
- The action file and its parent directories must have no extra access grants. Disable Node.js HTTP debug logging before you enable actions.
- A list can return up to 1 mebibyte. Select one vault if the item list exceeds the limit.
- Run other `op` commands directly on the Mac with desktop integration.
- If Pi already loads a skill named `op`, keep one copy active to avoid a name conflict.

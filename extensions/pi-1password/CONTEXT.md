# Pi 1Password

## Terms

| Term | Meaning |
| --- | --- |
| Pi host | Computer where the Pi session runs. |
| Approval Mac | Mac where native `op` runs under 1Password desktop integration. |
| Approval terminal | Terminal session that runs the companion on the Approval Mac. 1Password owns its authorization lifetime. |
| Launcher key | Restricted Secure Shell key used by an existing restricted pairing. |
| Approval target | The local Mac or a saved Herdr machine with a socket path derived from its profile ID. The user can override the path. |
| Secret reference | An `op://` identifier that native `op` resolves to a secret value. |
| Action grant | Approval Mac configuration that binds a name to an account, secret reference, and HTTPS destination. |

## Boundaries

- Select the Approval Mac explicitly. Herdr supplies the saved remote profiles. A Secure Shell (SSH) check verifies the native `op` signature and version.
- The approval terminal compares its hardware identifier with the selected Mac before it runs a request.
- Pi can list vault and item metadata or request a granted action by name. An action uses the grant's credential in a fixed HTTPS request and returns status only.
- The tunnel status returns the terminal busy state and action names without invoking `op`. It does not query 1Password authorization.
- An authenticated reverse SSH tunnel connects the Pi host to the approval terminal. The account that owns the socket on the Pi host can use the enabled operations.
- The saved SSH login starts the approval terminal as the Approval Mac's desktop user. It can also run shell commands as that user.
- The on-demand terminal limits its own operations to metadata lists. It checks the Pi host proof on the open Herdr connection and adds a reverse socket forward on that connection.
- The on-demand terminal removes its forward when Pi exits or after 10 minutes without a request. The Herdr connection stays open.
- For foreground approval, the terminal checks SSH aliases and known hosts. The user can supply an alias to bypass detection. The terminal may open a connection if it has no shared connection.
- An existing launcher key can start only its configured approval terminal. That terminal checks the paired host proof before it accepts requests.
- When you use action grants, keep the grant file and the Approval Mac's desktop account outside the Pi host's control.
- The 1Password desktop app verifies the native `op` process and authorizes the approval terminal. Pi cannot move a system prompt between Macs.

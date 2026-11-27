# Pi 1Password

## Terms

| Term | Meaning |
| --- | --- |
| Pi host | Computer where the Pi session runs. |
| Approval Mac | Mac where native `op` runs under 1Password desktop integration. |
| Approval terminal | Terminal that runs the companion on the Approval Mac. The paired launcher starts it on demand. 1Password owns its authorization lifetime. |
| Launcher key | Dedicated Secure Shell key that can start only one configured approval terminal. |
| Approval target | The local Mac or a saved Herdr machine with a socket path derived from its profile ID. The user can override the path. |
| Secret reference | An `op://` identifier that native `op` resolves to a secret value. |
| Action grant | Approval Mac configuration that binds a name to an account, secret reference, and HTTPS destination. |

## Boundaries

- Select the Approval Mac explicitly. Herdr supplies the saved remote profiles. A Secure Shell (SSH) check verifies the native `op` signature and version.
- The approval terminal compares its hardware identifier with the selected Mac before it runs a request.
- Pi can list vault and item metadata or request a granted action by name. An action uses the grant's credential in a fixed HTTPS request and returns status only.
- The tunnel status returns the terminal busy state and action names without invoking `op`. It does not query 1Password authorization.
- An authenticated reverse SSH tunnel connects the Pi host to the approval terminal. The account that owns the socket on the Pi host can use the enabled operations.
- Pairing verifies the Pi host before it adds the restricted public key. The fixed command checks the same host proof before it accepts requests.
- The action grant file and the desktop account that runs the approval terminal must stay outside the Pi host's control.
- The 1Password desktop app verifies the native `op` process and authorizes the approval terminal. Pi cannot move a system prompt between Macs.

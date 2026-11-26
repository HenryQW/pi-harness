# Short Magpie labels in the Pi model picker

The Pi `/model` list uses the keys from the local Magpie relay. For example, Pi shows `vps/claude/opus-5.5 [magpie]`. The patch makes the list show `claude/opus-5.5` and `group/frontier`.

Pi uses the full keys for search, requests, and thinking level settings. The selected model still shows its display name below the list. Apply the patch on each Mac that uses the relay.

## Apply or restore after a Pi update

Run this command from the repository root on the Mac that runs Pi.

```sh
node scripts/patch-pi-model-picker.mjs
```

The script reads the active managed Pi release from `~/.pi/agent/install/current-version`. It locates the picker in the bundle that the Pi launcher uses. The script checks the edited bundle for syntax errors before it replaces the file. It saves the original next to it with the suffix `.picker-labels-original`.

Pi 1.6.0 and 1.6.1 use the same picker code. The script stops if a new Pi release changes that code. A Pi update or reinstall can replace the patch. Run the script again if the prefix returns.

Start a new Pi process. Open `/model` and select a short label. Use `pi --list-models opus-5.5` to check that the key still has the `vps/` prefix.

## Roll back

Use the paths printed by the script. Copy the `.picker-labels-original` file over the bundle for the same release. Start a new Pi process.

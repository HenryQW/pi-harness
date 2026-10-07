# Deprecated extensions

The retired Herdr packages keep their final pre-merge source, documentation, and tests here for reference. These archives are excluded from active workspaces, extension loading, CI tests, and publishing; they are not maintained replacements for the published packages.

Use [`@henryqw/pi-herdr-tools`](../extensions/pi-herdr-tools/README.md) for cloning, side questions, conversation titles, and worktree completion. Install it before removing old packages, then restart Pi. Each archived package's README links to the migration instructions.

Repository retirement is separate from npm deprecation. Add registry warnings only after the replacement is publicly installable; follow the [release runbook](../docs/releasing.md#retire-a-package).

| Extension | Reason |
| --- | --- |
| [`@henryqw/pi-model-thinking`](./pi-model-thinking) | Pi v0.84.3 added native per-model thinking defaults. |
| [`@henryqw/pi-orchestrator`](./pi-orchestrator) | `@henryqw/pi-subagent` now owns durable checked isolated graphs. |
| [`@henryqw/pi-herdr-btw`](./pi-herdr-btw) | Merged into [`@henryqw/pi-herdr-tools`](../extensions/pi-herdr-tools/README.md). |
| [`@henryqw/pi-herdr-clone`](./pi-herdr-clone) | Merged into [`@henryqw/pi-herdr-tools`](../extensions/pi-herdr-tools/README.md). |
| [`@henryqw/pi-herdr-done`](./pi-herdr-done) | Merged into `pi-herdr-clone`, then [`@henryqw/pi-herdr-tools`](../extensions/pi-herdr-tools/README.md). |
| [`@henryqw/pi-herdr-rename`](./pi-herdr-rename) | Merged into [`@henryqw/pi-herdr-tools`](../extensions/pi-herdr-tools/README.md). |

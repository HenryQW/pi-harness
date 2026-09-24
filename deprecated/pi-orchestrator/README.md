# `@henryqw/pi-orchestrator` (retired)

Retired because `@henryqw/pi-subagent` now owns durable checked isolated graphs. A second package would split the same Role, route, executor, and recovery contract.

Remove existing installs with `pi remove npm:@henryqw/pi-orchestrator`, then use `delegate_task` with `mode: "isolated"`. See [`extensions/pi-subagent/README.md`](../../extensions/pi-subagent/README.md).

Existing `~/.pi/agent/config/pi-orchestrator/` state is not migrated. Published versions are no longer maintained.

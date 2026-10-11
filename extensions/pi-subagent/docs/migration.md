# Migrate from 26.x to 27.0.0

Version 27.0.0 changes how direct tasks declare writes, how Role files load, and one library function. Most users must do two things: make sure Main sends `access` on each direct task, and fix Role files that have unknown keys. Use the [checklist](#upgrade-checklist) at the end.

## Direct tasks must declare `access`

Each direct task must now have `access: "read"` or `access: "write"`. A request without `access`, or with another value, fails before launch. The error names the task, for example `tasks[1].access must be "read" or "write" (missing)`.

Main sets `access`, not you. The packaged `pi-subagent` Skill and the tool schema tell Main to do this. You must change requests only if you wrote them yourself, for example in saved prompts, examples, or scripts.

Use `write` when the task can change files, Git state, or external resources. Use `read` for all other tasks. Nothing enforces `read`: there is no sandbox, and a read task keeps all of its Role's tools.

Single task, before:

```json
{ "mode": "direct", "role": "scout", "name": "Map sign-in flow", "task": "Trace sign-in. Do not edit files." }
```

Single task, after:

```json
{ "mode": "direct", "role": "scout", "name": "Map sign-in flow", "task": "Trace sign-in. Do not edit files.", "access": "read" }
```

Parallel tasks, before:

```json
{
  "mode": "direct",
  "tasks": [
    { "role": "scout", "name": "Inspect service", "task": "Inspect the service boundary." },
    { "role": "reviewer", "name": "Inspect tests", "task": "Inspect the test contract." }
  ]
}
```

Parallel tasks, after:

```json
{
  "mode": "direct",
  "tasks": [
    { "role": "scout", "name": "Inspect service", "task": "Inspect the service boundary.", "access": "read" },
    { "role": "reviewer", "name": "Inspect tests", "task": "Inspect the test contract.", "access": "read" }
  ]
}
```

Chain, before:

```json
{
  "mode": "direct",
  "chain": [
    { "role": "scout", "name": "Collect evidence", "task": "Collect exact evidence." },
    { "role": "implementer", "name": "Apply fix", "task": "Fix the issue in this report and commit it:\n{previous}" }
  ]
}
```

Chain, after:

```json
{
  "mode": "direct",
  "chain": [
    { "role": "scout", "name": "Collect evidence", "task": "Collect exact evidence.", "access": "read" },
    { "role": "implementer", "name": "Apply fix", "task": "Fix the issue in this report and commit it:\n{previous}", "access": "write" }
  ]
}
```

## Roles no longer classify writes

In 26.x, pi-subagent used each Role's tools, extensions, and MCP servers to decide if a request could write. A Role with any extension or MCP server counted as a writer. In 27.0.0, only `access` decides this. The results are:

- A request with only `read` tasks does not reserve the checkout, and its tasks return plain text. Its parallel `tasks` run at the same time, up to `maxSubagents`; a `chain` still runs its steps in order. Roles that load a provider extension now run in parallel too.
- A request with one or more `write` tasks runs its tasks one at a time. It reserves the checkout until all of its workers are proved stopped. Each task must return a JSON completion object, as in 26.x.
- **Inspect status and recovery** in `/subagent` now works with a `scout` Role that loads extensions or MCP servers. It runs as a read task with the Role's own resources.

## Unknown Role frontmatter keys are rejected

Role Markdown files can only use these frontmatter keys: `name`, `description`, `modelClass`, `tools`, `extensions`, `skills`, and `mcps`. In 26.x, other keys had no effect. In 27.0.0, a file with another key is invalid. The error names the file and the key:

```text
<file>: unknown Role frontmatter key "color"; expected name, description, modelClass, tools, extensions, skills, mcps.
```

To fix it, open the file and remove the key. Keys copied from other agent tools often cause this error. Examples are `color` and `model`. For a model, use `modelClass` with `fast`, `balanced`, `frontier`, or `fav`. Main can also select a route or a `model` on each task.

## Role errors are reported per file

In 26.x, one invalid Role file stopped all Roles from loading. In 27.0.0, each file loads on its own:

- Valid Roles load and work.
- A task that names the Role of an invalid file fails, and the error names that file.
- Two files with the same `name` make that name unavailable until you remove one.

Run `/subagent roles` to see each Role, its source (built-in, user override, or user), its resolved model route, its resources, and all file errors. This command only reads. It does not need a Herdr pane.

## New `roleDefaults` setting

`~/.pi/agent/config/pi-subagent/config.json` accepts an optional `roleDefaults` object. Its `extensions`, `tools`, and `skills` arrays merge into every built-in and user Role. The defaults come first in each list, and duplicates are removed. Use it for the provider extension that every child needs:

```json
{
  "roleDefaults": {
    "extensions": ["npm:@example/pi-provider"]
  }
}
```

**Warning:** 26.x rejects the `roleDefaults` key, and an unknown key blocks all delegation. Upgrade to 27.0.0 before you add `roleDefaults` to the file.

## Library API: `loadRoles` is replaced

This section applies only if your code imports `@henryqw/pi-subagent`. `loadRoles` is removed. Use `loadRoleCatalog` to load all Roles and `findRole` to select one. The catalog also contains each Role's source and the per-file errors, and it applies `roleDefaults`.

Before:

```ts
import { loadRoles } from "@henryqw/pi-subagent";

const role = loadRoles().find((candidate) => candidate.name === "scout");
if (!role) throw new Error("Unknown Role: scout");
```

After:

```ts
import { findRole, loadRoleCatalog } from "@henryqw/pi-subagent";

const catalog = loadRoleCatalog();
const role = findRole(catalog, "scout"); // Throws with the file error if the Role is invalid.
for (const error of catalog.errors) console.warn(error.message);
```

## Worker output header and partial output

Each worker result that Main receives now starts with a header. The header tells Main that the text is the worker's output and has no user authority. Text that looks like harness framing gets a backslash, for example `<system-reminder>` tags or lines that start with `Human:` or `Assistant:`. No other text changes. Isolated status previews use the same header.

When a task fails after its worker wrote text, the result keeps a short excerpt marked as partial output. Partial output is never a success.

If you parse worker results, expect the header line before the worker text.

## New features you can use

These features do not need changes to your setup.

- **`continueFrom`**: Main can continue a finished direct worker, for example `"continueFrom": "D7.1"`, with the same Role. The worker resumes its saved Pi session in a new Herdr tab, so it keeps its earlier context. Main uses it for follow-up questions or corrections on the same work. After a continuation, continue the newest reference: an older reference to the same session is refused. For unrelated work, Main starts a fresh task.
- **Stop this worker**: in `/subagent`, a running workflow with only `read` tasks shows **Stop this worker** for each running worker. It stops only that worker. The other workers continue, and Main receives one result when the workflow finishes. Workflows with a `write` task keep only **Close/cancel-and-release ALL owned workers in this workflow**.

## Upgrade checklist

1. Make a copy of the Role files (`*.md`) and `config.json` in `~/.pi/agent/config/pi-subagent/`.
2. Remove unknown frontmatter keys, such as `color` or `model`, from each Role file in `~/.pi/agent/config/pi-subagent/`.
3. Upgrade with `pi install npm:@henryqw/pi-subagent`, then restart Pi.
4. Run `/subagent roles`. Fix each file error that it shows.
5. Optional: add `roleDefaults` to `config.json` for resources that every Role needs. Do this only after the upgrade.
6. Add `access` to each direct task in saved prompts, scripts, or examples that you wrote.
7. If your code imports the library, replace `loadRoles` with `loadRoleCatalog` and `findRole`.
8. If you parse worker results, expect the worker output header.
9. Do a small `read` delegation to make sure that the setup works.

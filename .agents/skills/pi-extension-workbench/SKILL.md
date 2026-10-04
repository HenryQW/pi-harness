---
name: pi-extension-workbench
description: Use when developing, modifying, or debugging a Pi extension or Pi extension package, including requests identified only by package name.
---

<!-- Last reviewed against Pi 1.0.0; verify contracts against each installed version. -->

# Pi Extension Workbench

Use APIs shipped with the active installed Pi, not remembered APIs or an
unrelated source checkout. For an explicitly targeted Pi source checkout,
inspect that checkout, but verify extension runtime behavior against installed Pi.

## Resolve authority

Run the resolver; it identifies the package loaded by the active `pi` command,
including launcher shims, or fails with a diagnostic:

```bash
PI_CODING_AGENT_ROOT="$(<skill_dir>/scripts/resolve-authority.sh)" || exit
export PI_CODING_AGENT_ROOT
```

Record the path and its `package.json` version. Shell calls do not share exports;
set `PI_CODING_AGENT_ROOT='<printed-path>'` in later shell calls that need it.
Installed docs, examples, and declarations define the runtime contract.

## Load progressively

Inspect target manifest and entry points first. A package-named request counts
as extension work when `pi.extensions`, a conventional extension entry point,
or a default factory using `ExtensionAPI` identifies it. A core import alone
may identify an SDK app instead; do not apply extension assumptions to it.

Read only matching navigation aids:

- Events, cleanup, compaction, branch-aware state:
  [lifecycle-and-state.md](references/lifecycle-and-state.md)
- Tool results, exposure, nested calls, commands, messages:
  [tools-and-commands.md](references/tools-and-commands.md)
- Dialogs, components, rendering, TUI/RPC/non-UI behavior:
  [ui-and-modes.md](references/ui-and-modes.md)
- Packaging, compatibility, MCP/providers/models, isolated smoke loading:
  [packages-and-integrations.md](references/packages-and-integrations.md)

Search installed `docs/extensions.md` for the exact API, then read that section
and the smallest matching example in `examples/extensions/`. Follow a specialized
doc only when needed. Use installed declarations under `dist/core/extensions/`
when prose does not settle a signature or event result. Do not read the whole
guide or every skill reference by default. Missing APIs require a clear
incompatibility report, not an invented fallback.

## Work

1. Read repository instructions, owning manifest, entry point, callers, tests,
   and neighboring patterns. Check installed version and target support policy;
   wildcard host peers declare no minimum, not support for every historical Pi.
   Verify any explicitly supported minimum before selecting a newer API.
2. Choose the smallest native integration and installed example. Reuse Pi,
   context, events, session/settings APIs, and Node APIs before adding machinery.
3. Trace affected callers; preserve trust-boundary validation, visible failures,
   cancellation, resource cleanup, branch semantics, and supported modes.
4. Make the smallest focused change; avoid speculative compatibility paths,
   abstractions, configuration, and dependencies.
5. Test changed non-trivial behavior using existing tooling. Run focused tests
   and available package typecheck/build. For load/lifecycle changes, use the
   isolated smoke procedure only after inspecting startup side effects; test
   reload, branch restoration, cancellation, or mode behavior when affected.
6. Update target README for changed commands, configuration, tools, or behavior.
   Do not bump versions, create release tarballs, install, or publish unless asked.

Report exact validation and untested modes or interactive behavior. If an
explicit support minimum cannot be verified, report the compatibility blocker.

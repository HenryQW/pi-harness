# Package instructions

## Extension config

Use `@henryqw/pi-config-store`. By default, an extension has one active config writer: reload after an external edit before writing again. `store.save(value)` serializes whole-file replacement but does not merge stale fields. When multiple writers are supported or concurrent field changes must survive, use `store.update(mutator)` to read and modify the latest valid config under the lock.

## Message-style widgets

- Give each widget one purpose and concise, width-safe copy. For persistent actions, prefer one line prefixed with a semantic status icon and a space; avoid decorative icons or redundant state.
- Color the icon with `ctx.ui.theme`, but make the text meaningful without color. Never hard-code ANSI sequences.
- Provide a plain-text fallback for non-TUI or RPC modes, and clear the widget at a defined lifecycle point.

## README

Use [README-template.md](README-template.md) for every package README: retain only applicable sections in its canonical order, with no placeholders or filler. Add an explanatory diagram for an extension with meaningful flows or relationships; do not add one merely to satisfy a rule. In extension READMEs, start links to local files with `./` (or `../` for parent paths): use `./docs/auto-compact-flow.svg`, not `docs/auto-compact-flow.svg`, or `docs:build` fails.

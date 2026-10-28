# Package instructions

## Extension config

Use `@henryqw/pi-config-store`. By default, an extension has one active config writer: reload after an external edit before writing again. `store.save(value)` serializes whole-file replacement but does not merge stale fields. When multiple writers are supported or concurrent field changes must survive, use `store.update(mutator)` to read and modify the latest valid config under the lock.

## Tool parameter schemas

Every registered tool's parameter schema must serialize as a plain object root with `type: "object"` and `properties`, without root `anyOf`/`oneOf`. Some OpenAI-compatible providers reject a root without `type`, while the Claude bridge may omit root unions. For variant actions, expose a flat object schema and validate the strict union at the tool boundary; nested unions remain valid. Test both the registered root and rejection of invalid variants.

## Message-style widgets

- Give each widget one purpose and concise, width-safe copy. For persistent actions, prefer one line prefixed with a semantic status icon and a space; avoid decorative icons or redundant state.
- Color the icon with `ctx.ui.theme`, but make the text meaningful without color. Never hard-code ANSI sequences.
- Provide a plain-text fallback for non-TUI or RPC modes, and clear the widget at a defined lifecycle point.

## README

Follow [README-template.md](README-template.md) for every package README. [website/AGENTS.md](../website/AGENTS.md) owns the local link rule.

Extension READMEs omit routine package and dependency versions; use manifests as the authority. Keep explicit versions only for essential compatibility or migration requirements.

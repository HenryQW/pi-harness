# UI and Modes

Read installed `docs/extensions.md` section `UI and modes`; follow `docs/tui.md`
only for components and `docs/rpc-extension-ui.md` for protocol-supported UI.
Example paths below are relative to `examples/extensions/`.

| Mode | Gate | Supported surface |
|---|---|---|
| Interactive | `ctx.mode === "tui"` | Full terminal UI |
| RPC | `ctx.hasUI` is true | Supported protocol UI, not custom terminal components |
| JSON/print | `ctx.hasUI` is false | No dialogs; define non-UI behavior |

A dangerous operation requiring confirmation must block when confirmation is
unavailable, unless an explicit safe non-UI policy authorizes it. Do not use
`hasUI` alone for overlays, custom editors, or terminal input.

## Smallest surface first

| Need | Choice | Example |
|---|---|---|
| Dialog or notification | Standard `ctx.ui` controls | `timed-confirm.ts`, `rpc-demo.ts` |
| Persistent chrome | Status/widget/title/editor text | `status-line.ts`, `widget-placement.ts` |
| Transcript formatting | Message/tool/entry renderer | `message-renderer.ts`, `entry-renderer.ts`, `todo.ts` |
| Custom terminal interaction | `custom()` / `CustomEditor` | `overlay-test.ts`, `modal-editor.ts` |
| Autocomplete composition | Existing composition API | `github-issue-autocomplete.ts` |

- Select storage by semantics, not appearance: `sendMessage` affects model
  context; `appendEntry` stores non-model data. Add a renderer only when useful.
- Keep rendering synchronous and free of I/O. Bound width with Pi TUI helpers
  and theme tokens; invalidate caches and request rendering after state changes.
- Respect configured keybindings and expected cancellation. Extend `CustomEditor`,
  forward unowned input, and compose with prior editor factories.
- Clear timers and UI state on completion/shutdown. Keep business logic separate
  so non-interactive modes remain functional.
- Test the affected mode: RPC startup does not verify TUI layout, keyboard input,
  overlays, or non-UI confirmation policy. Report untested behavior explicitly.

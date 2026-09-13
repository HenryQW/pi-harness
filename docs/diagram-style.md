# Diagram style

Use this guide for diagrams in repository READMEs and documentation.

## Source files

Keep each diagram's editable HTML and exported SVG together under the owning package's `docs/` directory.

The HTML file is the source of truth. Link the SVG from Markdown so GitHub and npm render it.

Use matching names:

```text
docs/example-flow.html
docs/example-flow.svg
```

## Canvas

Use a `1280 × 720` SVG `viewBox` for full-width README diagrams. Set the SVG `width` and `height` to the same values.

Keep a 40px safe area. Reserve the bottom 60px for a horizontal legend when one is needed.

Use a clean background without shadows, gradients, or decorative patterns.

## Colors

| Role | Value | Use |
| --- | --- | --- |
| Paper | `#f0eee9` | Page and SVG background |
| Paper 2 | `#e6e4de` | Zones and quiet containers |
| Ink | `#101828` | Primary text and borders |
| Muted | `#4c5665` | Connectors and secondary text |
| Soft | `#6a7282` | Labels and low-emphasis text |
| Accent | `#1d4ed8` | One or two focal elements |
| White | `#ffffff` | Standard nodes |

Use ink at low opacity for subtle fills and rules. Use accent at 8% opacity for focal fills.

## Typography

| Role | Font | Size | Weight |
| --- | --- | --- | --- |
| Title | Instrument Serif | 28px | 400 |
| Node name | Geist | 12px | 600 |
| Technical text | Geist Mono | 8px | 400–500 |

Use sans-serif text for names. Use monospace only for commands, fields, paths, protocols, and short labels.

## Shapes and connections

- Use 6–8px corner radii.
- Draw connectors before nodes.
- Use horizontal, vertical, or rounded right-angle connectors.
- Never use diagonal connectors.
- Keep separate attach points for separate connections.
- Put every connector label on a paper-colored mask with a visible gap from the line.
- Use dashed borders only for boundaries, optional paths, or unavailable paths.
- Use blue for one primary path. Keep other paths muted.

## Accessibility and export

Every SVG must include `role="img"`, a prefixed `aria-labelledby`, and matching `<title>` and `<desc>` elements.

Place `<title>` first inside the SVG. Keep font imports inside `<defs>` so the exported SVG renders in browsers.

Run the diagram skill's self-check and geometry check before publishing. Also run `git diff --check`.

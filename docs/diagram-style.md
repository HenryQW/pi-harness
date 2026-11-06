# Diagram style

Use this guide for diagrams in repository READMEs and documentation.

## Source files

For new Mermaid diagrams and diagrams converted to Mermaid, Markdown code blocks can be the source of truth. Give these diagrams an accessible title with `accTitle` and an accessible description with `accDescr`. Add a visible Markdown link to a static Scalable Vector Graphics (SVG) fallback for npm and readers without Mermaid support. Keep existing diagram assets. These Mermaid requirements do not require changes to other existing diagrams.

For other diagrams, keep editable Hypertext Markup Language (HTML) and exported SVG files together under the owning package's `docs/` directory. The HTML file is the source of truth. Link the SVG from Markdown so GitHub and npm render it.

Use matching names:

```text
docs/example-flow.html
docs/example-flow.svg
```

## Canvas

The following canvas, color, typography, connection, and export rules apply to static SVG diagrams.

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

Place `<title>` first inside the SVG. Export with `python3 .agents/skills/diagram-design/scripts/export_svg.py <file> --system-fonts` so the SVG uses installed fonts or system fallbacks without network requests.

Run the vendored [diagram-design](../.agents/skills/diagram-design/SKILL.md) self-check (`python3 .agents/skills/diagram-design/scripts/self_check.py <file>`) and, from a diagram-design repository checkout, `scripts/verify-geometry.py` before publishing. Also run `git diff --check`.

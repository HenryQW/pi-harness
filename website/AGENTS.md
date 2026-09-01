# Agent instructions

## Repository Markdown

README image paths must start with `./` or `../`.

The website inlines relative SVGs and rewrites other relative images only when paths use one of those prefixes. Bare paths such as `docs/diagram.svg` bypass both transforms and resolve against the generated page route.

Use `./docs/diagram.svg` for an image stored beside a README's `docs/` directory. Update `repository-markdown.test.ts` when changing this behavior.

## Diagram design guide

Use this profile whenever `/skill:diagram-design` creates or redraws a diagram for this website.

The skill owns diagram type selection, layout, connectors, accessibility, complexity limits, and export checks. This guide owns the website's visual skin and project defaults. Do not copy the skill's universal rules here.

### Sources and maintenance

The current sources of truth are:

- `blume.config.ts` for background, accent, fonts, and radius;
- `theme.css` for foreground, muted surfaces, borders, and code surfaces;
- `pages/index.astro` for the website's visual hierarchy;
- `../extensions/pi-subagent/docs/delegate-flow.svg` as a skin example, not a layout template.

When those sources change, update this guide in the same change. If this guide conflicts with the source files, stop and resolve the conflict before drawing.

### Brand direction

Use a warm editorial surface, deep navy text, quiet borders, and one blue accent. Prefer clear structure over decoration.

Default to the minimal light variant. Do not use gradients, shadows, glow, a dot pattern, sketch styling, terminal styling, or animation unless the request needs them. Do not add a logo unless identity is part of the diagram's meaning.

### Color tokens

These hex values are the diagram equivalents of the website's OKLCH tokens.

| Role | Light | Dark | Use |
|---|---|---|---|
| `paper` | `#f0eee9` | `#101828` | Canvas |
| `paper-2` | `#e6e4de` | `#18243a` | Zones and optional framed surfaces |
| `ink` | `#101828` | `#f0eee9` | Primary text and strokes |
| `muted` | `#4c5665` | `#cdd1d9` | Secondary text and default arrows |
| `soft` | `#6a7282` | `#99a1af` | Sublabels and boundary labels |
| `rule` | `rgba(16,24,40,0.141)` | `rgba(240,238,233,0.18)` | Hairlines |
| `rule-solid` | `#d5d8db` | `#cdd1d9` | Strong borders and baselines |
| `accent` | `#1d4ed8` | `#8fb3ff` | One or two focal elements |
| `accent-tint` | `rgba(29,78,216,0.08)` | `rgba(143,179,255,0.10)` | Focal fill |
| `link` | `#1d4ed8` | `#8fb3ff` | External and HTTP/API paths |

Use `accent` on at most two elements. Use `ink`, `muted`, and `soft` for everything else. Keep `ink` and `muted` at WCAG AA contrast against `paper`.

For charts that need distinct overlapping series, use this order. Reserve `accent` for the single focal series.

| Series | Light | Dark |
|---|---|---|
| `series-1` | `#7c8f6f` | `#9caf8f` |
| `series-2` | `#5e7a9b` | `#82a0c0` |
| `series-3` | `#b8915a` | `#d3ad7a` |
| `series-4` | `#9c6b50` | `#b88670` |
| `series-5` | `#6e6479` | `#8d8298` |

Use full color for series strokes. Use `0.18` fill opacity in light mode and `0.22` in dark mode. Do not use series colors in non-chart diagrams.

### Typography

Use this font stylesheet for standalone HTML:

```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=Noto+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@400&display=swap" rel="stylesheet">
```

| Role | Family | Weight | Standard size | Use |
|---|---|---:|---:|---|
| Page title | Instrument Serif | 400 | 28px | Standalone editorial wrapper only |
| Node name | Geist | 600 | 12px | Human-readable names |
| Sublabel | Geist Mono | 400 | 9px | Ports, protocols, URLs, and field types |
| Eyebrow or tag | Geist Mono | 500 | 8px | Uppercase, tracked labels |
| Arrow label | Geist Mono | 400 | 8px | Short connector annotations |
| Callout | Instrument Serif italic | 400 | 14px | Editorial asides only |

Use the skill's larger type ramp for slides and social images. Website headings outside the diagram remain Geist. Embedded SVGs normally need only Geist and Geist Mono because their accessible title is not visible.

Never use mono for human-readable names. Never use JetBrains Mono. Follow the skill's language-specific fallback and minimum-size rules when labels are not Latin.

### Shape and surface tokens

| Token | Value |
|---|---:|
| Thin stroke | `0.8` |
| Default stroke | `1` |
| Strong stroke | `1.2` |
| Small radius | `4` |
| Node radius | `6` |
| Container radius | `8` |
| Layout grid | `4` |

Keep coordinates, dimensions, padding, and gaps on the 4px grid. Use borders instead of shadows.

Use these semantic node treatments:

| Node | Fill | Stroke |
|---|---|---|
| Focal | `accent-tint` | `accent` |
| Backend, API, or step | `#ffffff` in light mode; `paper-2` in dark mode | `ink` |
| Store or state | `ink` at `0.05` opacity | `muted` |
| External | `ink` at `0.03` opacity | `ink` at `0.30` opacity |
| Input or user | `muted` at `0.10` opacity | `soft` |
| Optional or async | `ink` at `0.02` opacity | `ink` at `0.20` opacity, dashed `4,3` |
| Security boundary | `accent` at `0.05` opacity | `accent` at `0.50` opacity, dashed `4,4` |

### Project defaults

Unless the request says otherwise:

- format: self-contained HTML source, then only the requested SVG or PNG export;
- size: `doc-wide` (`1280×720`) for a full-width website figure, or `doc-inline` (`960×600`) inside prose;
- detail: `balanced`;
- audience: `mixed`;
- motion: `none`;
- background: a clean `paper` fill with no frame or texture.

Before delivery, run the skill's taste gate and self-check. Also verify the exact font families with `getComputedStyle` and inspect the final render at its intended size.

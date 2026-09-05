---
name: Henry Pi Harness
description: Personal, documentation-first catalogue for focused Pi extensions.
colors:
  paper: "oklch(0.949 0.007 88.6)"
  ink-navy: "oklch(0.21 0.034 263.4)"
  utility-blue: "oklch(0.488 0.217 264.4)"
  utility-blue-dark: "oklch(0.77 0.116 264.4)"
  paper-muted: "oklch(0.919 0.008 91.5)"
  slate-copy: "oklch(0.45 0.028 259.8)"
  navy-surface: "oklch(0.26 0.045 263.4)"
  mist-copy: "oklch(0.86 0.012 264.5)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
heroTypography:
  display:
    desktop: { fontSize: "72px", lineHeight: 1.05, letterSpacing: "-2.4px" }
    tablet: { fontSize: "64px", lineHeight: 1.05, letterSpacing: "-2px" }
    mobile: { fontSize: "clamp(32px, 10vw, 40px)", lineHeight: 1.05, letterSpacing: "-1.2px" }
  proof:
    desktop: "20px"
    tablet: "19px"
    mobile: "18px"
  action:
    desktop: "18px"
    tablet: "17px"
    mobile: "16px"
  code:
    desktop: "13px"
    tablet: "12.5px"
    mobile: "12px"
  benchmarkLabel:
    desktop: { fontSize: "13px", fontWeight: 400, lineHeight: 1.4 }
    tablet: { fontSize: "12.5px", fontWeight: 400, lineHeight: 1.35 }
    mobile: { fontSize: "12px", fontWeight: 500, lineHeight: 1.35 }
  benchmarkValue:
    desktop: { fontSize: "13px", fontWeight: 500, lineHeight: 1.35 }
    tablet: { fontSize: "12.5px", fontWeight: 500, lineHeight: 1.35 }
    mobile: { fontSize: "12px", fontWeight: 500, lineHeight: 1.35 }
  method:
    desktop: "11px"
    tablet: "10.5px"
    mobile: "10px"
heroLayout:
  referenceWidths:
    desktop: "1280px"
    tablet: "1024px"
    mobile: "390px"
  pageRail:
    desktop: "64px"
    tablet: "40px"
    mobile: "24px"
  proofGap:
    desktop: "40px"
    tablet: "32px"
    mobile: "32px"
  terminalPadding:
    desktop: "12px 16px"
    tablet: "12px 16px"
    mobile: "16px"
  terminalGap:
    desktop: "12px"
    tablet: "12px"
    mobile: "16px"
  controlTargetMobile: "44px"
figmaTokens:
  typographyStylePrefix: "Hero/"
  layoutVariableCollection: "Hero layout tokens"
rounded:
  sm: "0.25rem"
  pill: "9999px"
spacing:
  control-y: "0.5rem"
  control-x: "1rem"
  card: "1.25rem"
  page-mobile: "1.5rem"
  page-desktop: "4rem"
  section: "4rem"
components:
  button-primary:
    backgroundColor: "var(--blume-accent)"
    textColor: "var(--blume-accent-foreground)"
    rounded: "{rounded.sm}"
    padding: "{spacing.control-y} {spacing.control-x}"
    height: "2.75rem"
  button-secondary:
    backgroundColor: "var(--blume-background)"
    textColor: "var(--blume-foreground)"
    rounded: "{rounded.sm}"
    padding: "{spacing.control-y} {spacing.control-x}"
    height: "2.75rem"
  extension-card:
    backgroundColor: "var(--blume-background)"
    textColor: "var(--blume-foreground)"
    rounded: "{rounded.sm}"
    padding: "{spacing.card}"
---

# Design System: Henry Pi Harness

## Overview

**Creative North Star: "The Personal Engineering Notebook"**

Henry Pi Harness pairs a warm paper canvas with ink-navy type and a single utility-blue accent. It reads as a personal, proof-driven place for serious Pi tooling: the author identity and live-looking work screenshot make it human, while concise sans type, monospaced package names, and thin rules keep it exact.

The interface is intentionally quiet. It uses flat, bordered surfaces and sparse color to support scanning instead of treating a documentation catalogue like a marketing campaign. Dark mode keeps the same hierarchy on a deep navy work surface.

**Key Characteristics:**

- Warm editorial surface with technical, dark-mode continuity.
- One blue accent for actions, links, and high-signal metadata.
- Geist for readable product copy; Geist Mono for identifiers, versions, and commands.
- Flat, rule-led organisation with compact, practical controls.

## Colors

The palette is warm and restrained in light mode, then turns into a navy work surface in dark mode. The accent changes to a lighter blue on dark backgrounds rather than introducing another hue.

### Primary

- **Utility Blue** (`oklch(0.488 0.217 264.4)`): Light-mode actions, links, and focused metadata.
- **Night Utility Blue** (`oklch(0.77 0.116 264.4)`): The dark-mode accent for the same roles.

### Neutral

- **Warm Paper** (`oklch(0.949 0.007 88.6)`): Light-mode page surface and dark-mode primary text.
- **Ink Navy** (`oklch(0.21 0.034 263.4)`): Light-mode primary text and dark-mode page surface.
- **Paper Mist** (`oklch(0.919 0.008 91.5)`): Light-mode muted and code surfaces.
- **Slate Copy** (`oklch(0.45 0.028 259.8)`): Light-mode supporting copy.
- **Navy Surface** (`oklch(0.26 0.045 263.4)`): Dark-mode muted and code surfaces.
- **Night Mist** (`oklch(0.86 0.012 264.5)`): Dark-mode supporting copy.

### Named Rules

**The One Accent Rule.** Use utility blue for an action, link, or meaningful state. Do not use it as a general surface color.

## Typography

**Display Font:** Geist, with the system sans stack as fallback.

**Body Font:** Geist, with the system sans stack as fallback.

**Label/Mono Font:** Geist Mono, with the system monospace stack as fallback.

**Character:** The system is clear and compact, never decorative. Sans text handles explanations and headings; mono type marks package names, versions, commands, and other machine-readable facts.

### Hierarchy

- **Display** (600): Homepage statement. Use the responsive hero scale below.
- **Headline** (500, `1.5rem`, `1.25`): Section titles and card headings.
- **Body** (400, `1rem`, `1.5`): Explanations and documentation copy.
- **Label** (500, `0.875rem`, `1.25`): Buttons, navigation, and compact interface text.
- **Mono** (500, `0.875rem`, `1.25`): Package names and versions. Use `0.75rem` for compact metadata.

### Responsive Hero Type Tokens

These values define the approved hero hierarchy at each reference viewport. Figma stores them as local text styles under `Hero/`.

| Role | Desktop · 1280px | Tablet · 1024px | Mobile · 390px |
|---|---:|---:|---:|
| Display | `72px / 1.05 / -2.4px` | `64px / 1.05 / -2px` | `clamp(32px, 10vw, 40px) / 1.05 / -1.2px` |
| Proof statement | `20px` | `19px` | `18px` |
| CTA | `18px` | `17px` | `16px` |
| Terminal code | `13px` | `12.5px` | `12px` |
| Benchmark label | `13px / 400 / 1.4` | `12.5px / 400 / 1.35` | `12px / 500 / 1.35` |
| Benchmark value | `13px / 500 / 1.35` | `12.5px / 500 / 1.35` | `12px / 500 / 1.35` |
| Method note | `11px` | `10.5px` | `10px` |

Display values list `font-size / line-height / letter-spacing`. Benchmark values list `font-size / font-weight / line-height`.

### Named Rules

**The Identifier Rule.** Reserve monospaced type for names users may copy, search, install, or compare.

## Layout

Use a centered content column capped at `90rem`. The reference rails are `64px` desktop, `40px` tablet, and `24px` mobile.

The desktop hero at `1280px` and wider uses a two-column proof grid with a `40px` gap and a `624px` hero. From `1024px` through `1279px`, the tablet hero uses two equal columns with a `32px` gap; at the `1024px` reference, its proof rail is `944px` wide with `456px` columns. This mode uses a shared proof top edge, a `96px` terminal, a `152px` benchmark and proof grid, a `624px` hero, and CTA at `y=544`. From `768px` through `1023px`, the identity triangle centers below the heading and the proof panels fill the content rail, stacked with a `32px` gap in a `280px` proof area. This stacked-tablet mode uses an `872px` hero and CTA at `y=784`. Below `768px`, proof panels stay full-width and stacked with a `32px` gap, an `884px` hero, CTA at `y=820`, and a full-width proof method. Terminal padding is `12px 16px` on desktop and tablet, then `16px` on mobile. Internal terminal gaps are `12px`, `12px`, and `16px` respectively. Figma stores these values in the `Hero layout tokens` variable collection.

Extension lists move from one column to two at `640px` and three at `1024px`. Keep cards equal-height within a row, with metadata pinned beneath the description. Primary actions and footer links keep a `2.75rem` minimum height. Header search and icon controls stay compact at `2.25rem`.

### Named Rules

**The HUG-first Rule.** In Figma, use Auto Layout and HUG content whenever content can determine size. Use FILL for responsive rows and fixed sizes only for bounded text, touch targets, artwork, charts, or overlapping animation frames.

## Elevation & Depth

The system is flat by default. Thin, low-contrast borders define cards, controls, and dividers. The sticky header uses a tonal surface without its own border. Do not add interface shadows to create hierarchy; use surface contrast, borders, and spacing instead. Product screenshots may retain their own visual treatment because they are evidence, not interface chrome.

### Named Rules

**The Flat-by-Default Rule.** A surface earns separation through a rule or a tonal shift before it earns depth.

## Shapes

Use the shared `0.25rem` radius for buttons, cards, and compact controls. Use `9999px` only for avatars, logo marks, and small round controls. Borders are thin and quiet; avoid oversized rounding and ornamental containers.

## Components

### Buttons

- **Shape:** Compact rectangle with the shared `0.25rem` radius and a `2.75rem` minimum height.
- **Primary:** Utility-blue fill, mode-aware contrast text, and `0.5rem 1rem` padding.
- **Hover / Focus:** Hover slightly reduces the accent fill. Keyboard focus uses a visible `2px` blue ring with offset.
- **Secondary:** Background-colored surface with a quiet border; it stays subordinate to the primary action.

### Cards / Containers

- **Corner Style:** Shared `0.25rem` radius.
- **Background:** Page background; hover shifts toward the muted surface.
- **Shadow Strategy:** None.
- **Border:** One thin mode-aware border.
- **Internal Padding:** `1.25rem`.

### Navigation

- **Header:** Use Blume's built-in `PageLayout` header without homepage CSS or script overrides. It is `4rem` high with `1rem` side padding and `1.5rem` from the medium breakpoint.
- **Brand:** Use the configured `favicon.ico` at `1.25rem`, followed by the product name.
- **Search:** Use Blume's outlined pill trigger. Show only the icon below `64rem`; show `Search` and `⌘K` at larger widths.
- **Actions:** Use Blume's native `2.25rem` GitHub and theme icon buttons.
- **Footer:** Text-first navigation with a minimum `2.75rem` hit area and an underline-on-hover cue.

### Extension Card

Package name and version form the scan line, with the name in Geist Mono. A short explanation follows, then a divider and download proof. The whole card is one keyboard-focusable link.

### Extension Catalog

At `1280px` and wider, use a `768px × 520px` scroll viewport. Reserve a `16px` right gutter inside it. The content grid is `752px` wide, with two `364px` cards and a `24px` gap. Place the `4px` scrollbar `8px` from the cards and `4px` from the viewport edge. Below `1280px`, let the catalog follow page flow and hide the custom rail.

## Do's and Don'ts

### Do:

- **Do** use warm paper, ink navy, and a single utility blue as the dominant visual language.
- **Do** give package names, versions, and commands a monospaced treatment.
- **Do** use thin rules and generous section gaps to group dense technical information.
- **Do** preserve visible keyboard focus and use `2.75rem` targets for primary actions and footer links.

### Don't:

- **Don't** introduce a second accent hue, decorative gradients, or interface shadows to make the catalogue feel louder.
- **Don't** use mono for explanatory prose or headings.
- **Don't** make every card or control blue; blue is a decision signal.
- **Don't** replace real product proof with fabricated testimonials, metrics, or imagery.

## Website Change Approval

Before coding any user-facing website change:

1. Update the corresponding Figma design first.
2. Iterate on the Figma design until the user approves it.
3. Then get the user's explicit approval to implement that approved design.

Do not modify website source code before both approvals. A browser prototype does not replace the Figma design step.

## Diagram Profile

Use this profile whenever `/skill:diagram-design` creates or redraws a diagram for this website.

The skill owns diagram type selection, layout, connectors, accessibility, complexity limits, and export checks. This profile owns the website's visual skin and project defaults. Do not copy the skill's universal rules here.

### Sources and Maintenance

The current sources of truth are:

- `blume.config.ts` for background, accent, fonts, and radius;
- `theme.css` for foreground, muted surfaces, borders, and code surfaces;
- `pages/index.astro` for the website's visual hierarchy;
- `../extensions/pi-subagent/docs/delegate-flow.svg` as a skin example, not a layout template.

When those sources change, update this profile in the same change. If this profile conflicts with the source files, stop and resolve the conflict before drawing.

### Brand Direction

Use a warm editorial surface, deep navy text, quiet borders, and one blue accent. Prefer clear structure over decoration.

Default to the minimal light variant. Do not use gradients, shadows, glow, a dot pattern, sketch styling, terminal styling, or animation unless the request needs them. Do not add a logo unless identity is part of the diagram's meaning.

### Color Tokens

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

### Shape and Surface Tokens

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

### Project Defaults

Unless the request says otherwise:

- format: self-contained HTML source, then only the requested SVG or PNG export;
- size: `doc-wide` (`1280×720`) for a full-width website figure, or `doc-inline` (`960×600`) inside prose;
- detail: `balanced`;
- audience: `mixed`;
- motion: `none`;
- background: a clean `paper` fill with no frame or texture.

Before delivery, run the skill's taste gate and self-check. Also verify the exact font families with `getComputedStyle` and inspect the final render at its intended size.

---
target: entire homepage UI, especially layout
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/henry/.herdr/worktrees/pi-harness/worktree-lucky-stone-d3b4/website/pages/index.astro"
target_fingerprint: "sha256:b740e867f4c178219403347171aa1933c993cc6abd079a528f5fa4432c17f509"
target_path: /Users/henry/.herdr/worktrees/pi-harness/worktree-lucky-stone-d3b4/website/pages/index.astro
timestamp: 2026-09-05T04-40-53Z
slug: website-pages-index-astro
---
## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Copy, mode, search, and empty states respond clearly; catalog result count is visually hidden. |
| 2 | Match system / real world | 3 | Workflow outcomes are understandable, but “Main,” “Pi Roles,” and mode behavior assume prior knowledge. |
| 3 | User control and freedom | 3 | Search and theme controls are clear; the nested catalog scroll and temporary touch previews reduce control. |
| 4 | Consistency and standards | 2 | The outer rail is shared, but internal grids, breakpoints, radii, and type values still diverge. |
| 5 | Error prevention | 3 | Copying is safe, but `curl | sh` lacks nearby scope and safety context. |
| 6 | Recognition rather than recall | 3 | Workflow-led discovery works; package relationships and mode meanings remain implicit. |
| 7 | Flexibility and efficiency | 3 | Global search, catalog search, direct links, and copy help experienced users. |
| 8 | Aesthetic and minimalist design | 3 | The visual system is disciplined, but mobile orchestration and nested catalog scrolling add avoidable bulk. |
| 9 | Error recovery | 3 | Copy failure and catalog-empty recovery are explicit. |
| 10 | Help and documentation | 3 | Documentation is strong, but benchmark and installer context are thin at their decision points. |
| **Total** |  | **29/40** | **Good foundation; fix the responsive topology before polishing.** |

## Design Specificity Verdict

**Visually specific, structurally uneven.**

The warm paper, ink navy, utility blue, monospaced identifiers, author identity, and evidence-oriented hero feel authored for Henry Pi Harness. The weaker area is layout behavior between breakpoints. Several sections still behave like a fixed 1280px Figma canvas placed inside a nominally fluid 1440px shell.

The deterministic scan returned 44 findings: 14 `overused-font` warnings, 16 undocumented font-size advisories, 7 undocumented radius advisories, and 7 undocumented color advisories. The Geist warnings are false positives because Geist and Geist Mono are required by the brief. The other findings mainly expose drift between `DESIGN.md` and the approved implementation.

CDP browser evidence covered 1440px, 1280px, 1024px, 720px, and 390px states. It found no horizontal overflow, runtime exceptions, or console errors. Overlay injection succeeded but produced no `impeccable` console findings.

## Overall Impression

The desktop page has a strong editorial cadence and clear personality. The biggest opportunity is making the responsive layout serve the primary path: understand value → choose workflow → find extension → read or install.

## What’s Working

1. The macro hierarchy is excellent. Hero, workflows, orchestration, catalog, and footer read as distinct bands.
2. Workflow-first discovery is the strongest section. Outcome titles lead and package identifiers stay secondary.
3. The visual language is disciplined. Flat surfaces, restrained blue, Geist/Geist Mono, and thin rules support the engineering-notebook identity.

## Priority Issues

### [P1] The benchmark collides at tablet width

At 1024px, the expanded comparison SVG overlaps the method line by 25.92px. Stop the shared homepage container from overriding the hero’s responsive cap, or move the benchmark graphic and method into normal flow with the SVG capped at its intrinsic width.

Suggested command: `$impeccable adapt`

### [P1] The catalog creates a nested-scroll trap

The viewport is always 520px tall while its desktop content is 2,154px tall. On mobile only about three of 21 cards appear before the footer. Remove the height cap below desktop and let cards extend the page naturally.

Suggested command: `$impeccable layout`

### [P2] Orchestration dominates the mobile journey

At 390px, orchestration is 1,226px tall, about 29% of the 4,261px page. Use compact mobile role tiles and a segmented mode control, or a smaller two-column grid.

Suggested command: `$impeccable adapt`

### [P2] The 1440px rail is shared only at the section boundary

At 1440px, workflow and hero proof content end at x=1361 while orchestration and catalog cards stop at x=1216, leaving a 145px right-side void. Let wide orchestration and catalog columns consume remaining grid width rather than preserving fixed 1280px-canvas card endpoints.

Suggested command: `$impeccable layout`

### [P2] The benchmark becomes too small to function as proof on mobile

At 390px, the chart, totals, and 11px method line compress into 342px. Use a mobile-specific proof layout with larger totals, a simplified tick strip, and readable wrapped methodology.

Suggested command: `$impeccable adapt`

## Cognitive Load

The three workflows reduce initial complexity. Load increases with six unexplained orchestration choices, 21 extension cards, 44 visible focus stops, implicit package relationships, and two overlapping search surfaces.

## Emotional Journey

The hero creates confidence, workflows create orientation, and orchestration creates curiosity. Mobile users then face a long non-navigating proof section and nested catalog scrolling before direct documentation links restore utility.

## Persona Red Flags

**Jordan — first-time Pi user:** Encounters “Main,” “Pi Roles,” and task modes without a plain-language bridge; may mistake support libraries for installable extensions.

**Maya — mobile or zoom user:** Hits the 1024px benchmark collision, traverses 1,226px of orchestration, and must operate nested catalog scrolling.

**Alex — power user:** Benefits from search and direct links, but still faces 44 focus stops and cannot immediately distinguish installable extensions from infrastructure packages.

## Minor Observations

- `Explore extension docs ↗` is an internal anchor, so the external-link arrow is misleading.
- The catalog contradicts the documented 2-column-at-640px and 3-column-at-1024px behavior.
- Benchmark methodology uses the smallest text in the hero.
- Beyond 1440px, header and footer content stay pinned 64px from the viewport while sections center inward.
- Dark mode retains contrast but loses some of the light theme’s strong band rhythm.
- `DESIGN.md` and its generated sidecar should eventually be refreshed to match approved Figma.

## Questions to Consider

- Should extension discovery outrank the orchestration demonstration on mobile?
- Is the nested catalog viewport solving a real desktop need, or preserving a Figma frame constraint?
- Should the 1440px layout expand its cards, or should the whole page return to a tighter 1280px content cap?
- What benchmark detail is essential on a 390px screen?

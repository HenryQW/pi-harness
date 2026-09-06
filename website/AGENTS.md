# Agent instructions

## Repository Markdown

README image paths must start with `./` or `../`.

The website inlines relative SVGs and rewrites other relative images only when paths use one of those prefixes. Bare paths such as `docs/diagram.svg` bypass both transforms and resolve against the generated page route.

Use `./docs/diagram.svg` for an image stored beside a README's `docs/` directory. Update `repository-markdown.test.ts` when changing this behavior.

Every SVG root must set `width` and `height` to its `viewBox` canvas dimensions. A `viewBox` alone gives an `<img>` the wrong intrinsic size, which prevents Blume's image zoom from enlarging it.

## Website design

Read `DESIGN.md` before planning or coding any user-facing website or website diagram change. It owns the design system, approval workflow, and diagram profile.

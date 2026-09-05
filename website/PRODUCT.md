# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pi users who want to discover, evaluate, and install focused extensions for agent workflows. They use the site when configuring or improving a local Pi environment.

## Product Purpose

Henry Pi Harness is a documentation site and installer for a curated set of Pi extensions and their support libraries. It helps users find the right extensions, understand how they fit together, and install all or a selected subset.

## Positioning

The site derives extension documentation from the packages' canonical READMEs and derives its installer list from public Pi package manifests. It favors explicit package relationships and user selection over bundles or recommendation logic.

## Operating Context

Users browse static documentation at `pi.henry.wang` and install extensions from a shell. The installer sets up Pi and Herdr only when their commands are unavailable, then installs selected Pi extensions. The default selection is every installable extension.

## Capabilities and Constraints

- The website uses Blume, Astro, and TypeScript with static output.
- Root and extension READMEs remain the documentation source of truth.
- Public extension manifests with Pi metadata define the installer package list. Deprecated packages and non-extension support libraries are excluded.
- Package names, descriptions, and relationship language must remain canonical and traceable to repository sources.
- Discovery focuses on end-user extensions. Author infrastructure remains outside the primary discovery flow.

## Brand Commitments

- Product name: Henry Pi Harness.
- Preserve the Pi, Herdr, and Henry identity where it has product meaning.
- Use concise, engineering-oriented language.
- Do not invent performance claims, product capabilities, or customer proof.

## Evidence on Hand

- Root repository README and extension READMEs.
- Package manifests under `extensions/`.
- Website implementation in `website/pages/`, `website/components/`, and `website/blume.config.ts`.
- No independent user research, testimonials, or measured outcome claims are available for publication.

## Product Principles

1. Keep documentation and installation behavior traceable to package sources.
2. Make extension relationships understandable without recommender logic.
3. Let users start with all extensions and choose a narrower set when needed.
4. Keep setup behavior explicit, observable, and failure-aware.

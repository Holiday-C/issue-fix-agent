# ADR-0002: Use a TypeScript single-package CLI

- Status: accepted
- Date: 2026-08-12
- Deciders: project maintainers

## Context

The first release is a local CLI with one deployable artifact. Splitting it into services or packages would add versioning and build overhead without an independent consumer.

## Decision

Use Node.js 22, strict TypeScript, native ESM, npm, and one package. Build with `tsc`. Use Node.js standard-library functionality before adding dependencies. Keep replaceable runtime boundaries as TypeScript interfaces rather than separate packages.

## Consequences

- Contributors use one install, build, and verification path.
- The CLI and runtime can share contracts without publishing internal packages.
- Relative imports include `.js` extensions for Node.js ESM output.
- A package split is postponed until an actual second consumer exists.

## Alternatives Considered

- **Python:** excellent AI ecosystem, but weaker fit for the intended distributable CLI and chosen learning goals.
- **Monorepo:** useful for multiple independently released components, which do not yet exist.
- **Bundler-first build:** can produce a smaller artifact, but hides module boundaries and is unnecessary before distribution.

## Validation

Revisit if the model runtime becomes a separately consumed library, startup/distribution requirements demand bundling, or Node.js prevents a required sandbox integration.

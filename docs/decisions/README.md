# Architecture Decision Records

ADRs preserve why a significant technical choice was made so future agents do not repeatedly reopen settled decisions without new evidence.

## Lifecycle

- `proposed`: under discussion;
- `accepted`: current decision;
- `superseded`: replaced by another ADR;
- `rejected`: considered but not adopted.

Create a new numbered Markdown file from `0000-template.md`. Never rewrite the reasoning of an accepted ADR. To change a decision, add a new ADR and mark the old one as superseded.

## Index

- [ADR-0001: Use a simple model-tool loop](./0001-simple-model-tool-loop.md)
- [ADR-0002: Use a TypeScript single-package CLI](./0002-typescript-single-package-cli.md)
- [ADR-0003: Use a native OS command sandbox](./0003-use-native-command-sandbox.md)
- [ADR-0004: Use the Anthropic Messages API](./0004-use-anthropic-messages-api.md)

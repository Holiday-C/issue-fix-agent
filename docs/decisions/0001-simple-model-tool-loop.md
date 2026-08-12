# ADR-0001: Use a simple model-tool loop

- Status: accepted
- Date: 2026-08-12
- Deciders: project maintainers

## Context

Issue repair is open-ended: the number and order of searches, reads, edits, and test runs cannot be reliably encoded in advance. A graph framework would add runtime concepts before the project has observed failures that require them.

## Decision

Implement a direct loop in which the model chooses tools from environmental feedback. Keep deterministic control in explicit budget, permission, tool, verification, and tracing components. Do not depend on LangChain or LangGraph in the first release.

## Consequences

- The core execution path stays readable and debuggable.
- Framework-specific message and state types do not enter project contracts.
- The project must implement its own stopping, tracing, recovery, and context handling.
- A workflow framework can be reconsidered if measured failures demonstrate a need for durable graph execution.

## Alternatives Considered

- **LangGraph:** strong checkpoint and workflow primitives, but premature for a single dynamic loop.
- **Provider Agent SDK:** faster initial capability, but would hide the mechanics this learning project intends to study.
- **Fixed workflow:** predictable but poorly matched to open-ended repository investigation.

## Validation

The loop is successful if it remains understandable, testable with a fake model, and sufficient for the first 20 evaluation tasks. Revisit if recovery, branching, or durable execution logic begins dominating the agent core.

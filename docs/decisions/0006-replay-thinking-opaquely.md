# ADR-0006: Replay opt-in thinking opaquely

- Status: accepted
- Date: 2026-08-20
- Deciders: project maintainer

## Context

Some Anthropic-compatible gateways enable thinking by default. When a thinking
response also contains tool calls, the gateway may require the signed thinking
blocks to be replayed with the assistant tool-call message. Exposing those
blocks through provider-neutral Agent messages would leak hidden reasoning into
outcomes, traces, artifacts, or UI surfaces.

## Decision

Thinking remains disabled by default. Users may explicitly set
`ANTHROPIC_THINKING=enabled`.

When enabled, the Anthropic adapter validates and retains thinking and
redacted-thinking blocks in a bounded in-memory map keyed by tool-call ID. It
removes those blocks from the provider-neutral response and replays them only
inside later Anthropic API requests associated with the matching assistant
tool call.

Opaque thinking:

- never becomes a provider-neutral message block;
- never enters Agent outcomes, trace events, artifacts, reports, or progress;
- is bounded to one MiB per adapter lifetime; and
- disappears when the adapter instance is released.

Unexpected thinking blocks remain invalid when thinking is disabled.

## Consequences

- Thinking-capable gateways can complete multi-turn tool use correctly.
- The Agent core remains provider-neutral and cannot inspect hidden reasoning.
- Adapter instances are stateful and must remain scoped to one run.
- Cross-run thinking persistence and resumability are intentionally unsupported.

## Validation

Fake-client tests must prove that enabled thinking is requested, removed from
the visible response, replayed before the matching tool call, bounded, and
still rejected in disabled mode. Tests must not make network or paid calls.

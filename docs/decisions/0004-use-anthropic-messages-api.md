# ADR-0004: Use the Anthropic Messages API

- Status: accepted
- Date: 2026-08-19
- Deciders: project maintainer

## Context

The deterministic harness uses a provider-neutral `ModelPort`, but the first
usable release needs one real model implementation. Provider types,
credentials, failures, and usage accounting must not leak into the Agent core.

## Decision

Implement the first provider adapter with the exactly pinned Anthropic
TypeScript SDK and the non-streaming Messages API.

The adapter:

- receives the API key, model ID, output-token limit, and timeout through
  explicit constructor configuration;
- translates only provider-neutral text, tool-use, and tool-result blocks;
- rejects unsupported or malformed provider response blocks;
- returns normalized stop reasons and token usage;
- supports host cancellation and a bounded request timeout;
- maps provider failures to stable error codes without exposing raw error
  bodies; and
- keeps SDK types inside `src/model/`.

Extended thinking, Anthropic-hosted tools, and streaming are disabled for the
first release. They require separate review because they change observable
content, trace behavior, or tool authority.

## Consequences

- The Agent loop and its tests remain independent of Anthropic SDK types.
- API credentials remain a CLI/configuration concern and never enter model
  messages or artifacts intentionally.
- Live runs incur user-controlled API cost, while normal tests inject a fake
  client and make no network calls.
- The initial CLI cannot show token-by-token streaming output.

## Alternatives Considered

- **Direct HTTP requests:** avoid an SDK dependency but duplicate error,
  timeout, and API compatibility handling.
- **Provider Agent SDK:** faster orchestration but conflicts with the accepted
  direct model-tool loop and would hide the project boundaries under study.
- **Multiple providers in M3:** adds configuration and test surface before one
  real adapter is validated end to end.

## Validation

Unit tests must verify request/response translation, malformed response
rejection, usage reporting, cancellation, timeout, and normalized provider
errors without an API key or network request. M3 completes only after a
separately triggered paid fixture evaluation succeeds three consecutive times.

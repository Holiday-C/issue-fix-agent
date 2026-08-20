# ADR-0007: Use a native OpenAI-compatible chat adapter

- Status: accepted
- Date: 2026-08-20
- Deciders: project maintainer

## Context

Some gateways expose both Anthropic Messages and OpenAI Chat Completions wire
formats. Their message, tool, finish-reason, usage, and thinking-continuation
shapes differ, so conditionals inside the Anthropic adapter would weaken the
provider boundary and encourage unsafe URL-based protocol guessing.

## Decision

Add a separate OpenAI-compatible Chat Completions adapter behind the existing
provider-neutral `ModelPort`. Select it only with
`ISSUE_FIX_MODEL_PROTOCOL=openai` and explicit `OPENAI_BASE_URL`,
`OPENAI_AUTH_TOKEN`, and model configuration.

Use Node.js native `fetch` rather than adding another SDK dependency. The
adapter:

- posts non-streaming requests to `<baseURL>/chat/completions`;
- translates system, user, assistant, tool-call, and tool-result messages;
- validates and bounds JSON requests and streamed response bytes;
- normalizes finish reasons and cached token usage;
- supports timeout, cancellation, authentication, rate-limit, and provider
  errors; and
- retains optional `reasoning_content` only as bounded in-memory state for
  matching tool-call replay.

The runtime never infers protocol from a URL.

## Consequences

- Messages and Chat Completions compatibility can evolve independently.
- No OpenAI SDK dependency is required.
- Gateway-specific extensions remain unsupported unless explicitly validated.
- The caller must provide a base URL at the API root expected to contain
  `/chat/completions`.

## Validation

Fake-client tests must cover translation, malformed function arguments,
finish reasons, cached usage, opaque reasoning replay, timeout, cancellation,
configuration rejection, and CLI protocol selection without network or paid
calls.

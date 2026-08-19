# ADR-0005: Require explicit custom provider endpoints

- Status: accepted
- Date: 2026-08-19
- Deciders: project maintainer

## Context

Some users access an Anthropic Messages-compatible gateway through a custom
base URL and bearer token. A URL does not reliably identify its API protocol,
and credentials for one gateway must never be sent to another endpoint by
guessing or fallback behavior.

## Decision

Support custom Anthropic-compatible gateways only through explicit runtime
configuration:

- `ANTHROPIC_BASE_URL` selects the network endpoint;
- `ANTHROPIC_AUTH_TOKEN` supplies bearer authentication;
- `ANTHROPIC_MODEL` selects the model understood by that gateway.

The base URL must be HTTP(S), bounded, and contain no embedded credentials,
query, or fragment. When an auth token is present, it takes precedence over a
stale `ANTHROPIC_API_KEY`; the adapter passes only the selected credential to
the SDK. Official API-key mode remains supported.

Protocol selection is explicit. The Anthropic adapter always speaks the
Messages wire format. OpenAI-compatible gateways require a separate adapter
and configuration path; the runtime never guesses a protocol from the URL.

## Consequences

- Users can route Messages-compatible requests through a trusted gateway.
- Gateway URLs may be recorded for reproducibility, but credentials are never
  added to prompts, traces, artifacts, progress, or evaluation reports.
- Plain HTTP is allowed only because local gateways may require it; choosing
  such an endpoint is an explicit user security decision.
- Supporting another protocol adds an adapter instead of conditionals inside
  the Anthropic translation layer.

## Validation

Tests must cover official API-key mode, custom base URL plus auth token, token
precedence, invalid or credential-bearing URLs, CLI redaction, and guarded live
evaluation configuration without making network requests.

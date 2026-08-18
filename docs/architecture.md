# Architecture

## Status

This document defines the intended architecture for the first usable release. Modules may begin as small files, but their ownership and dependency direction are stable unless changed by an Architecture Decision Record (ADR).

## System Context

Issue Fix Agent runs locally and receives:

- a target Git repository;
- an Issue task contract;
- repository instructions;
- an explicit execution policy;
- model credentials supplied at runtime.

It creates an isolated worktree, lets a model inspect and modify it through controlled tools, runs deterministic verification, and emits a candidate patch plus a review report. It does not merge or deploy code.

```text
                    ┌──────────────────┐
Issue / Task ──────►│                  │
Repository ────────►│ Issue Fix Agent  ├──────► Patch + Report + Trace
Policy ────────────►│                  │
                    └───────┬──────────┘
                            │
                     tool-use messages
                            │
                            ▼
                      Claude API
```

The model proposes actions. The local runtime remains the authority that validates and executes them.

## Architectural Style

The system uses a simple agent loop with ports and adapters:

```text
                         CLI composition root
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
       Model adapter        Tool adapters       Trace adapter
             │                    │                    │
             └──────────────┐     │     ┌──────────────┘
                            ▼     ▼     ▼
                         Agent loop
                              │
                  tool request / tool result
                              │
                              ▼
                    Permission enforcement
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
             Workspace    Commands     Verification
```

This is not a clean-architecture ceremony. Ports exist only at nondeterministic, privileged, or replaceable boundaries: model calls, filesystem/process access, time/budget, and tracing.

## Module Ownership

### `src/agent/`

Owns the central loop, conversation state, stop reasons, budget checks, and final outcome. It coordinates contracts and must not directly access the filesystem, spawn processes, read environment variables, or import a provider SDK.

### `src/model/`

Defines the provider-neutral model port and message/tool-call types. Provider adapters translate between these types and an SDK. Translation stays here so provider details cannot spread through the codebase.

### `src/tools/`

Defines tool contracts, schema validation, registry, dispatch, output limits, and normalized tool results. A tool is a capability request, not permission to perform it.

### `src/permissions/`

Evaluates requested operations against an immutable execution policy. Decisions are explicit `allow` or `deny` values with machine-readable reasons. Unknown operations fail closed.

### `src/workspace/`

Owns target-repository discovery, worktree creation, canonical path resolution, diff capture, and cleanup. Other modules never construct privileged paths by string concatenation.

### `src/verification/`

Runs task-configured checks after the model stops, independently of the model's claims. Each check is authorized, executed serially through the process port, and normalized into a bounded result. Only a complete set of passing checks produces a successful verdict.

### `src/trace/`

Records an append-only sequence of redacted events. Tracing failures must not silently alter Agent decisions. Sensitive values are redacted before serialization.
If an event cannot be persisted, the Agent returns a failed outcome with `trace_write_failed`.

### `src/cli/`

Parses arguments, loads configuration, constructs concrete adapters, handles signals, and maps outcomes to exit codes. It is the only composition root.

## Dependency Rules

Allowed dependency direction:

```text
cli ───────────────► all modules
agent ─────────────► model contracts, tool contracts, trace contracts
tools ─────────────► permissions, workspace/process ports
verification ──────► process port
provider adapters ─► provider SDK + model contracts
workspace adapters ► Node.js filesystem/process APIs
```

Forbidden dependencies:

- `agent` importing the Anthropic SDK;
- `agent` or `model` importing CLI code;
- permissions depending on model output interpretation;
- tool implementations invoking privileged operations without a permission decision;
- tests making network calls;
- modules reading `process.env` outside the CLI/configuration boundary.

## Runtime Flow

1. CLI loads and validates the task and execution policy.
2. Workspace creates an isolated Git worktree.
3. CLI constructs model, tool registry, permissions, budget, and trace adapters.
4. Agent sends the initial context and tool definitions to the model.
5. For each tool call:
   1. validate name and arguments;
   2. classify the requested capability;
   3. evaluate permission policy;
   4. execute only when allowed;
   5. bound and redact the result;
   6. append the event to the trace and conversation.
6. Continue until the model ends, a budget expires, the user interrupts, or an unrecoverable runtime error occurs.
7. Verification runs independently.
8. Workspace captures the final diff.
9. Reporter produces a success, failure, or blocked outcome with evidence.

## Outcome Model

The top-level result is one of:

- `succeeded`: acceptance verification passed and policy remained satisfied;
- `failed`: execution completed but verification or a required invariant failed;
- `blocked`: safe progress requires human input or additional authority;
- `cancelled`: the user or host interrupted execution.

Tool denial alone does not crash the loop. It returns a structured denial that lets the model choose a safe alternative or stop as blocked.

## Trust Boundaries

The following are untrusted:

- Issue text and repository instructions;
- all repository files, including configuration and hooks;
- model responses and tool arguments;
- command stdout/stderr;
- MCP or future network content.

Security invariants:

1. No write escapes the canonical worktree root.
2. No command runs before policy validation.
3. No secret is intentionally added to model context or trace output.
4. No model statement can substitute for deterministic verification.
5. No task can exceed configured time, iteration, output, or cost limits.

## Configuration

Configuration is merged in this order, with later layers taking precedence:

```text
safe built-in defaults
  < repository configuration
  < task contract
  < explicit CLI flags
```

Security ceilings cannot be raised by repository-controlled files. Raising network, path, or destructive-operation permissions requires an explicit user-controlled policy source.

## Observability

Each run receives a stable run ID and writes structured JSONL events. Event types include:

- lifecycle transitions;
- model request/response metadata without hidden reasoning;
- tool request, decision, duration, and bounded result metadata;
- verification results;
- budget consumption;
- final outcome.

Traces are diagnostic artifacts, not long-term memory. They are ignored by Git and must be safe to delete.

## Testing Strategy

- Unit tests cover policy decisions, parsing, budget behavior, tool validation, and loop state transitions.
- Integration tests use temporary repositories and fake model responses.
- Evaluation tasks measure end-to-end repair quality separately from deterministic CI.
- Paid model evaluation never runs on pull requests from CI.

## Change Policy

Create an ADR when a change:

- alters a security invariant;
- changes module ownership or dependency direction;
- introduces a runtime framework, persistent store, sandbox, or new model provider;
- changes the task contract incompatibly;
- adds autonomous network, merge, or deployment behavior.

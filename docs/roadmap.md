# Product Roadmap

Issue Fix Agent is developed through small, demonstrable vertical milestones.
Each milestone must produce an observable capability, not only a collection of
modules.

## Current Status

Milestone 0, **Agent Kernel**, is complete. The project currently has a
provider-neutral model/tool loop, a tool registry, an iteration budget, trace
contracts, a CLI shell, and deterministic unit tests.

The current milestone is Milestone 1, **Safe Workspace**.

The project is not yet able to repair an Issue. There are no repository tools,
worktree isolation, permission enforcement, model adapter, verification runner,
or run artifacts.

## Milestone Rules

Every milestone must satisfy these rules:

- deliver the smallest coherent user-visible or operator-visible capability;
- keep safety boundaries fail-closed;
- include deterministic tests that make paid model calls impossible;
- pass `npm run verify` locally;
- record changes and verification evidence in a pull request;
- keep paid model evaluations manual and explicitly authorized;
- avoid adding deferred capabilities without an observed failure that requires
  them.

GitHub milestones and Issues track execution. This document records product
intent and exit criteria.

## M0 — Agent Kernel

**Status:** Complete

### Goal

Establish a provider-neutral, deterministic core that can be tested without a
repository or paid model.

### Delivered

- strict TypeScript and native ESM project;
- provider-neutral model and message contracts;
- direct single-agent model/tool loop;
- tool registry and normalized tool errors;
- iteration budget;
- trace sink contract;
- CLI help and version shell;
- deterministic fake-model unit tests.

### Exit criteria

- The model can end a turn or request a fake tool.
- Tool results are returned to the next model iteration.
- Invalid model states and budget exhaustion stop explicitly.
- Tests make no network or paid API calls.
- `npm run verify` passes.

## M1 — Safe Workspace

**Status:** In progress

**GitHub milestone:** [M1 — Safe Workspace](https://github.com/Holiday-C/issue-fix-agent/milestone/1)

### Goal

Turn a local repository and YAML task contract into a validated, isolated
execution context before any model call or task-configured command can occur.

### Scope

- [#8: manage isolated Git worktrees](https://github.com/Holiday-C/issue-fix-agent/issues/8)
- [#9: validate YAML task contracts](https://github.com/Holiday-C/issue-fix-agent/issues/9)
- [#10: enforce canonical allowed paths](https://github.com/Holiday-C/issue-fix-agent/issues/10)
- [#11: compose safe run preparation](https://github.com/Holiday-C/issue-fix-agent/issues/11)

### Non-goals

- repository read or write tools;
- task-configured command execution;
- Anthropic or other model calls;
- Markdown Issue parsing;
- patches, reports, branches, or pull requests in the target repository.

### Exit criteria

- YAML task input is validated as untrusted data.
- A target Git repository is validated without modifying its checkout.
- A temporary worktree is created and cleaned after success or failure.
- Canonical path decisions deny traversal, absolute paths, and symlink escape.
- The CLI can prepare or validate a run without invoking a model or project
  command.
- Deterministic temporary-repository integration tests pass.
- `npm run verify` passes.

## M2 — Deterministic Repair

**Status:** Planned

### Goal

Use a scripted model to complete one verified fixture repair end to end without
a paid model call.

### Scope

- bounded `list_files`, `search_code`, and segmented `read_file` tools;
- worktree-only `apply_patch` and `git_diff` tools;
- policy-controlled `run_command` using executable and argument arrays;
- Zod validation for every tool boundary;
- deterministic verification runner;
- append-only redacted JSONL trace;
- `changes.patch`, `verification.json`, and `result.md` artifacts;
- one deterministic fixture repository and Issue.

### Exit criteria

- A scripted model produces a patch that resolves the fixture Issue.
- Verification runs independently of the model's completion claim.
- The source checkout and `main` remain unchanged.
- All writes stay inside the isolated worktree and allowed paths.
- Denied operations are structured tool results, not bypassed exceptions.
- No API key or network access is required.
- `npm run verify` passes.

## M3 — Real Model MVP

**Status:** Planned

### Goal

Run the deterministic repair harness with Anthropic Messages API and produce
the first usable local candidate repair.

### Scope

- Anthropic adapter contained in `src/model/`;
- repository instructions and task prompt assembly;
- iteration, elapsed-time, token, and cost budgets;
- API timeout, interruption, and provider-error handling;
- secret and trace redaction;
- `succeeded`, `failed`, `blocked`, and `cancelled` outcomes;
- the complete `issue-fix run --repo <path> --issue <path>` CLI path.

### Exit criteria

- The same small fixture succeeds three consecutive times.
- Every successful run passes deterministic verification.
- No run violates path or command policy.
- API credentials never enter model context, artifacts, or trace output.
- Each run reports elapsed time, tokens, and estimated cost.
- Paid runs are manual and never part of `npm run verify`.

M3 is the first usable MVP.

## M4 — Evaluation and Reliability

**Status:** Planned

### Goal

Measure whether changes improve repair quality instead of relying on isolated
demos.

### Scope

- 10 fixed, deterministic Issue tasks;
- resolved, regression-free, scope-compliant, iteration, error, time, token,
  and cost metrics;
- large-file segmentation and tool-output truncation;
- failure taxonomy and regression reports;
- prompt and tool comparisons against a recorded baseline.

### Exit criteria

- At least 7 of 10 baseline tasks are resolved.
- Scope compliance is 100 percent.
- Resolved tasks introduce no verification regression.
- No credential disclosure or worktree escape occurs.
- Every failure has a recorded category and reproducible task.
- Paid evaluation is explicitly triggered, never scheduled.

## M5 — Dogfooding

**Status:** Planned

### Goal

Prove that candidate repairs save human review time on real repositories,
including Issue Fix Agent itself.

### Scope

- GitHub Issue task ingestion with explicit network authorization;
- candidate branch and pull-request description generation;
- three small repairs in a real repository;
- at least one `agent-ready` Issue in this repository;
- human-edit and review-time tracking.

### Exit criteria

- Three consecutive real repairs are accepted after human review.
- No accepted repair violates scope or safety policy.
- Review and follow-up work is recorded for each repair.
- The agent never merges or deploys autonomously.
- Each failure creates a reusable test, instruction, tool improvement,
  permission rule, or evaluation task.

## Deferred Capabilities

The following remain deferred until evaluation evidence identifies a failure
that needs them:

- subagents;
- long-term memory;
- semantic indexing or repository-wide RAG;
- multi-model routing;
- workflow graph frameworks;
- cloud scheduling;
- browser tools;
- autonomous review, merge, or deployment.

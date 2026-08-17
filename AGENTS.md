# Repository Instructions for Coding Agents

This repository is intentionally developed through coding agents. A human defines product intent, approves risky choices, and reviews outcomes; agents perform repository investigation, implementation, verification, and documentation.

These instructions apply to the entire repository.

## Read First

Before changing code, always read:

1. `README.md` for product scope and principles.
2. `docs/architecture.md` for module boundaries and runtime flow.

Then load only the guidance relevant to the task:

| When the task involves                         | Read                                    |
| ---------------------------------------------- | --------------------------------------- |
| Architecture or a cross-module design choice   | Relevant ADRs in `docs/decisions/`      |
| Branches, commits, PRs, or repository workflow | `docs/development/git-workflow.md`      |
| Finding other development procedures           | `docs/development/README.md`            |
| Security-sensitive behavior                    | `SECURITY.md` and relevant architecture |

Do not load every repository document by default. Follow references when the
current task needs them, and keep new repeatable engineering procedures under
`docs/development/`.

If documents disagree on architecture, prefer the most specific ADR, then
`docs/architecture.md`, then `README.md`. For operational workflow, prefer the
most specific guide in `docs/development/`. Report conflicts instead of silently
choosing when they affect behavior or safety.

## Required Workflow

1. Restate the acceptance criteria in operational terms.
2. Inspect the smallest relevant part of the repository.
3. Propose a short implementation plan for non-trivial changes.
4. Implement the smallest coherent change.
5. Add or update tests that fail without the change.
6. Run `npm run verify`.
7. Inspect `git diff --check` and the final diff.
8. Report what changed, what passed, and any remaining risk.

Never claim a command passed unless it was actually executed in the current workspace.

## Architecture Boundaries

- `src/agent/` owns the model/tool loop and stopping behavior. It depends on contracts, not concrete infrastructure.
- `src/model/` owns model-facing contracts and provider adapters.
- `src/tools/` owns tool schemas, registration, and dispatch.
- `src/permissions/` makes authorization decisions; tools must not bypass it.
- `src/workspace/` owns repository and worktree lifecycle.
- `src/verification/` runs configured acceptance checks and normalizes results.
- `src/trace/` records append-only, redacted execution events.
- `src/cli/` is the composition root. Business behavior does not belong in argument parsing.

Dependencies must point toward contracts and the agent core. Provider SDK types must not leak into `src/agent/`, `src/permissions/`, or domain-level tests.

## Engineering Rules

- Use TypeScript strict mode and native ESM.
- Include `.js` extensions in relative TypeScript imports because output runs directly in Node.js ESM.
- Prefer immutable values, explicit return types at public boundaries, and small pure functions.
- Validate all data crossing a trust boundary.
- Treat model output, repository content, Issue text, tool arguments, and command output as untrusted input.
- Do not use `any`. Use `unknown` and narrow it.
- Do not add a dependency when the Node.js standard library is sufficient.
- Do not add an abstraction before there is a real substitution or testing boundary.
- Keep tool results bounded and structured; never return unlimited command or file output to the model.
- Never log API keys, environment variables, credentials, or raw sensitive file contents.
- Avoid barrel exports inside implementation folders when they create cycles or obscure ownership.

## Test Rules

- Unit tests live in `tests/unit/` and mirror the source module name.
- Integration fixtures live in `evals/fixtures/`; they must be deterministic and contain no secrets.
- Every bug fix adds a regression test.
- Test behavior through public contracts, not private implementation details.
- Mock the model port in unit tests. Tests must never make paid API calls.
- CI must not require `ANTHROPIC_API_KEY`.

## Safety Rules

- All future file writes must resolve to a validated worktree path.
- Command execution must use executable plus argument arrays, not interpolated shell strings.
- Network access is denied unless a task explicitly requires and authorizes it.
- Destructive file and Git operations require explicit user approval.
- Permission denial is a normal tool result, not an exception to work around.
- Budget exhaustion and ambiguous requirements produce a blocked report, never a fabricated success.

## Git Rules

- Follow `docs/development/git-workflow.md` for branch, commit, PR, and merge
  rules whenever the task touches Git history or collaboration workflow.
- Never work directly on `main`; create a new branch for every change.
- Do not rewrite unrelated user changes.
- Agents must not merge PRs. Only the repository owner may merge into `main`.

## Definition of Done

A change is complete only when:

- acceptance criteria are demonstrably satisfied;
- relevant tests exist and pass;
- `npm run verify` passes;
- safety and permission behavior remain fail-closed;
- public behavior and architectural decisions are documented;
- the final report names any check that could not be run.

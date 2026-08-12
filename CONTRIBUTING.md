# Contributing

Issue Fix Agent uses an AI-first development process: Issues describe intent and constraints, coding agents implement changes, and humans review product and risk decisions.

## Development Setup

Requirements:

- Node.js 22
- npm 10 or newer
- Git 2.40 or newer

```bash
npm ci
npm run verify
```

Use `npm run dev -- --help` while developing the CLI.

## Start with an Issue

Every non-trivial change should have an Issue containing:

- the problem and relevant context;
- explicit acceptance criteria;
- important non-goals;
- allowed or sensitive areas of the repository;
- a verification strategy.

Use the **Agent task** Issue template for work intended to be completed autonomously.

## Branches

Use short, lowercase branch names:

```text
feat/42-command-policy
fix/81-output-truncation
docs/architecture-boundaries
chore/update-tooling
```

Create branches from an up-to-date `main`. Do not mix unrelated changes in one branch.

## Commits

Use Conventional Commits:

```text
<type>(<optional-scope>): <imperative summary>
```

Supported types:

| Type       | Use                              |
| ---------- | -------------------------------- |
| `feat`     | User-visible capability          |
| `fix`      | Defect correction                |
| `docs`     | Documentation only               |
| `test`     | Tests and fixtures only          |
| `refactor` | Behavior-preserving code change  |
| `perf`     | Measured performance improvement |
| `build`    | Build system or dependencies     |
| `ci`       | Continuous integration           |
| `chore`    | Repository maintenance           |
| `revert`   | Revert of an earlier commit      |

Examples:

```text
feat(tools): add bounded file reader
fix(permissions): reject paths outside worktree
test(agent): cover budget exhaustion
docs: record command execution decision
```

The summary is lowercase, imperative, has no trailing period, and should fit within 72 characters where practical. Use the body to explain motivation, trade-offs, and migration notes. Use `BREAKING CHANGE:` in the footer for incompatible behavior.

## Pull Requests

- Keep the diff focused and reviewable.
- Use a Conventional Commit formatted PR title.
- Link the Issue with `Closes #<number>` when applicable.
- Complete the verification and risk sections in the PR template.
- Include tests for behavioral changes.
- Add or update an ADR when changing an architectural invariant.
- Never include API keys, repository secrets, model transcripts containing secrets, or generated run data.

The preferred merge method is **squash merge**. The PR title becomes the commit subject on `main`.

## Review Priorities

Review in this order:

1. safety and permission boundaries;
2. acceptance criteria and observable behavior;
3. tests and failure handling;
4. module dependencies and maintainability;
5. naming and formatting.

AI authorship does not reduce the review requirement. Generated code is held to the same standard as human-written code.

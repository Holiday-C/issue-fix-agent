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

The canonical branch, commit, pull-request, and merge rules are in
[`docs/development/git-workflow.md`](./docs/development/git-workflow.md). Read
that guide before starting a change.

## Start with an Issue

Every non-trivial change should have an Issue containing:

- the problem and relevant context;
- explicit acceptance criteria;
- important non-goals;
- allowed or sensitive areas of the repository;
- a verification strategy.

Use the **Agent task** Issue template for work intended to be completed autonomously.

## Branches, Commits, and Pull Requests

- Never work directly on `main`; create a new branch for every change.
- Use Conventional Commits for commit messages and PR titles.
- Keep each branch and PR focused on one independently reviewable purpose.
- Complete the verification and risk sections in the PR template.
- Include tests for behavioral changes and an ADR for architectural changes.
- Never include API keys, repository secrets, sensitive model transcripts, or
  generated run data.
- Only the repository owner, `Holiday-C`, may merge into `main`.

The detailed rules, examples, and protected-branch policy live in the
[Git and Pull Request Workflow](./docs/development/git-workflow.md).

## Review Priorities

Review in this order:

1. safety and permission boundaries;
2. acceptance criteria and observable behavior;
3. tests and failure handling;
4. module dependencies and maintainability;
5. naming and formatting.

AI authorship does not reduce the review requirement. Generated code is held to the same standard as human-written code.

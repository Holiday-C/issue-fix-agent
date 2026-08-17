# Git and Pull Request Workflow

This document is the canonical Git workflow for Issue Fix Agent. In this GitHub
repository, "pull request" (PR) is the equivalent of "merge request" (MR).

## Protected `main`

`main` is a protected integration branch:

- Never commit or push directly to `main`.
- Every change, including documentation and CI changes, goes through a PR.
- Only the repository owner, `Holiday-C`, merges PRs into `main`.
- Force pushes and deletion of `main` are forbidden.
- Unresolved review conversations block merging.

Verification runs locally and its evidence is recorded in the PR. The repository
does not currently run GitHub Actions.

Repository ownership is the human approval boundary. Agents may prepare a
branch, commits, verification evidence, and a PR description, but must not merge
the PR.

## Start Every Change on a Branch

Create a new branch from the latest `main` before editing files:

```bash
git switch main
git pull --ff-only origin main
git switch -c <type>/<short-description>
```

Use one independently reviewable purpose per branch. Do not reuse a merged
branch for a later feature or fix.

Branch names are lowercase and use one of these prefixes:

| Prefix      | Purpose                           |
| ----------- | --------------------------------- |
| `feat/`     | New user-visible behavior         |
| `fix/`      | Bug fixes                         |
| `docs/`     | Documentation-only changes        |
| `test/`     | Tests or deterministic fixtures   |
| `refactor/` | Behavior-preserving restructuring |
| `ci/`       | CI or automation changes          |
| `chore/`    | Repository maintenance            |

Include the Issue number when one exists, for example
`feat/42-command-policy`. Otherwise use a short descriptive name such as
`docs/repository-workflow`.

## Commits

Use Conventional Commits:

```text
<type>(<optional-scope>): <imperative summary>
```

Supported types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`ci`, `chore`, `revert`.

Examples:

```text
feat(tools): add bounded file reader
fix(permissions): reject paths outside worktree
test(agent): cover budget exhaustion
docs: document protected branch workflow
```

The summary must be lowercase, imperative, have no trailing period, and stay
within 72 characters where practical. Use the body to explain motivation and
trade-offs. Add `BREAKING CHANGE:` in the footer for incompatible behavior.

Keep commits single-purpose and independently verifiable. Do not amend, rebase,
or force-push shared work without explicit approval. Do not add AI co-author
trailers automatically.

## Pull Requests

Before opening or updating a PR:

1. Recheck the Issue acceptance criteria and the branch diff.
2. Add tests for behavioral changes and regression tests for bug fixes.
3. Run `npm run verify`.
4. Run `git diff --check` and inspect the final diff.
5. Complete `.github/pull_request_template.md` with actual evidence and risks.

PR titles use the same Conventional Commit format because the repository uses
squash merges and the PR title becomes the commit subject on `main`.

Link the Issue with `Closes #<number>` when applicable. Keep the PR focused;
unrelated work belongs on another branch and in another PR.

Only `Holiday-C` may merge. Other contributors and agents stop after preparing
the PR and requesting owner review. After a squash merge, delete the source
branch unless it is still needed for an explicitly documented follow-up.

## Required GitHub Ruleset

The repository must keep an active branch ruleset targeting the default branch
with these controls:

- restrict updates and deletion;
- require a pull request before merging;
- require all review conversations to be resolved;
- require linear history;
- block force pushes;
- give only the GitHub user `Holiday-C` bypass permission, set to **For pull
  requests only**.

The PR-only bypass mode makes `Holiday-C` the only merge authority without
allowing a direct push to `main`. The owner should not bypass failed checks
except for an explicitly documented recovery action.

Do not enable GitHub's **Lock branch** option: it makes the branch read-only and
would prevent normal PR merges as well.

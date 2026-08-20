# Evaluation Manifest

`evals/manifest.yaml` is the ordered, versioned source of truth for fixed
evaluation tasks. Evaluation tooling loads it through
`evals/evaluation-manifest.ts`; normal CLI execution does not depend on it.

Each entry contains:

- `id`: a stable lowercase identifier used across baseline reports;
- `fixture`: a repository fixture below `evals/`;
- `task`: a valid task contract below `evals/`;
- `expected_changed_paths`: the exact files a successful candidate should
  change.
- `expected_failure_checks`: zero-based verification indices that intentionally
  fail in a negative fixture (omitted for repairable tasks).

Paths use portable forward-slash syntax. Absolute paths, parent traversal,
missing files, wrong file types, and symbolic links escaping `evals/` are
rejected. Every expected changed path must also match the task contract's
`allowed_paths` policy. Task order is preserved so reports remain stable.
Expected failure indices must be unique and refer to configured verification
commands; all undeclared check failures count as regressions.

The manifest is intentionally limited to 20 entries and 256 KiB. M4 fixes the
checked-in suite at ten deterministic tasks; fixture purpose and expected
outcomes are documented in [`fixtures.md`](./fixtures.md).

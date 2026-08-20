# Evaluation Results

`evals/evaluation-results.ts` converts a repair run into one normalized result
per manifest task. A task is accepted only when the run succeeds, verification
resolves the task, and the candidate is independently regression-free and
scope-compliant. Resolution remains separate from scope: a verified but
out-of-scope patch is resolved but not accepted.

Each result records:

- resolution, regression, scope, and acceptance booleans;
- iterations, tool errors, changed files, and elapsed milliseconds;
- input, cache, and output token counts plus estimated cost;
- exactly one primary failure for every unaccepted result.

The finite failure taxonomy separates task, regression, scope, configuration,
permission, budget, model, sandbox, infrastructure, and cancellation failures.
Unrecognized future reasons use `unknown` instead of being silently dropped.
Evidence contains only bounded status and reason codes, never command output or
model content.

The aggregate validates every record at runtime, rejects duplicate task IDs and
inconsistent success fields, then emits order-independent counts, rates, and
resource totals. The evaluator must determine `regressionFree` independently;
it is not inferred from the model's claim or from task resolution.

Deterministic serialization, redaction, and baseline comparison are documented
in [`reporting.md`](./reporting.md).

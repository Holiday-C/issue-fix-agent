# M3 Live Model Evaluation

This is the only paid evaluation in M3. It is manual, guarded, and never part
of `npm run verify` or GitHub Actions.

## Before running

Choose an Anthropic model available to your account and obtain its current
per-million-token prices from Anthropic. Set all four rates in this order:

```text
input,output,cache-write,cache-read
```

The default estimated cost ceiling is USD 5 per run. The evaluation stops on
the first failure, so it performs at most three paid runs.

## Run

```bash
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_MODEL=your-model-id
export ANTHROPIC_PRICING=input,output,cache-write,cache-read
export ISSUE_FIX_LIVE_EVAL=1

npm run eval:m3
```

Optional controls:

- `ISSUE_FIX_MAX_COST_USD`: per-run estimated cost ceiling;
- `ISSUE_FIX_EVAL_OUTPUT_ROOT`: parent directory for retained evidence
  (default `.tmp`).

The command creates a fresh committed fixture repository for each attempt. It
requires three consecutive `succeeded` outcomes, passing independent
verification, a clean source checkout, and no API-key occurrence in console or
artifact files. Evidence is retained under the printed report directory.

## Review

Inspect `report.json` and every reported artifact directory. Confirm:

- all three outcomes are `succeeded`;
- every verification report passed;
- `changes.patch` changes only `src/greeting.js`;
- source checkouts remain clean and at their original commit;
- token, elapsed-time, and estimated-cost fields are present;
- no credential appears in console captures or artifacts.

After review, record the report path and results on Issue #35. Do not commit
the generated `.tmp` evidence.

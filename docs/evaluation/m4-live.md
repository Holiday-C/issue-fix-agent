# M4 Baseline Evaluation

The M4 baseline is a manual paid run over the ten fixed tasks in
`evals/manifest.yaml`. It is never part of `npm run verify`, GitHub Actions, or
another scheduled command.

## Authorization and cost

The runner requires the M4-specific `ISSUE_FIX_M4_LIVE_EVAL=1` switch. The M3
switch does not authorize this run. It enforces both a per-task ceiling and a
suite-wide ceiling:

```bash
export ISSUE_FIX_M4_LIVE_EVAL=1
export ISSUE_FIX_MAX_COST_USD=1
export ISSUE_FIX_M4_MAX_TOTAL_COST_USD=5
```

Configure either the Anthropic Messages protocol:

```bash
export ANTHROPIC_AUTH_TOKEN=your-token
export ANTHROPIC_BASE_URL=https://your-gateway.example/anthropic
export ANTHROPIC_MODEL=your-model
export ANTHROPIC_PRICING=input,output,cache-write,cache-read
export ANTHROPIC_THINKING=disabled
```

or OpenAI Chat Completions:

```bash
export ISSUE_FIX_MODEL_PROTOCOL=openai
export OPENAI_AUTH_TOKEN=your-token
export OPENAI_BASE_URL=https://your-gateway.example/v1
export OPENAI_MODEL=your-model
export OPENAI_PRICING=input,output,cache-write,cache-read
export OPENAI_THINKING=disabled
```

Then run:

```bash
npm run eval:m4
```

## Evidence and exit criteria

Each task receives a fresh committed copy of its fixture. The source checkout
must remain unchanged because repairs occur in isolated worktrees. The runner
checks credential absence, changed paths, tool errors, declared negative-check
behavior, total cost, and normalized metrics before writing:

- `evaluation.json` — bounded redacted machine-readable results;
- `evaluation.md` — concise review report;
- `metadata.json` — configuration and per-task safety evidence.

Completion requires all ten tasks to run, at least seven to resolve, all ten to
be regression-free and scope-compliant, no source checkout or credential
escape, and total cost within the configured ceiling. The three documented
negative fixtures remain unresolved by design; their declared verification
failures must be reproduced rather than bypassed.

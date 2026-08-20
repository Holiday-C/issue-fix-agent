# Evaluation Reporting

Evaluation reports are versioned, deterministic artifacts created from
validated normalized results. Results are sorted by task ID, so the same input
produces byte-identical JSON regardless of collection order. Markdown provides
a compact review surface without including raw model or command output.

A comparison names both baseline and candidate and reports:

- tasks that changed from accepted to unaccepted;
- new verification regressions and scope violations;
- missing and newly added tasks;
- deltas for quality rates, iterations, tool errors, elapsed time, tokens, and
  estimated cost.

Known credential shapes and caller-provided secret values are redacted before a
report is created. JSON is limited to 512 KiB and Markdown to 256 KiB; oversized
artifacts fail instead of being written partially. Parsed reports recompute and
verify their summary, preventing edited aggregate numbers from being trusted.

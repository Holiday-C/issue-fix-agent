import { describe, expect, it } from "vitest";

import {
  compareEvaluationReports,
  createEvaluationReport,
  EvaluationReportError,
  parseEvaluationReport,
  renderEvaluationComparisonMarkdown,
  renderEvaluationReportMarkdown,
  serializeEvaluationComparison,
  serializeEvaluationReport,
} from "../../evals/evaluation-report.js";
import type {
  EvaluationFailureCategory,
  EvaluationResult,
} from "../../evals/evaluation-results.js";

describe("evaluation reports", () => {
  it("emits stable JSON and concise Markdown independent of input order", () => {
    const alpha = successfulResult("alpha-task");
    const beta = failedResult("beta-task", "task_failure");
    const first = createEvaluationReport("baseline-v1", [beta, alpha]);
    const second = createEvaluationReport("baseline-v1", [alpha, beta]);

    expect(serializeEvaluationReport(first)).toBe(serializeEvaluationReport(second));
    expect(first.results.map((result) => result.taskId)).toEqual(["alpha-task", "beta-task"]);
    expect(parseEvaluationReport(JSON.parse(serializeEvaluationReport(first)))).toEqual(first);

    const markdown = renderEvaluationReportMarkdown(first);
    expect(markdown).toContain("# Evaluation report: baseline-v1");
    expect(markdown).toContain("- Accepted: 1/2");
    expect(markdown).toContain("| beta-task | no | no | yes | yes | task_failure");
  });

  it("redacts built-in and caller-provided secrets before serialization", () => {
    const failure = failedResult("secret-task", "model_failure", {
      models: ["sk-ant-sensitive-token"],
      failure: {
        category: "model_failure",
        reason: "provider_failed",
        evidence: ["Bearer gateway-token", "custom-secret"],
      },
    });
    const report = createEvaluationReport("run custom-secret", [failure], {
      secretPatterns: ["custom-secret"],
    });

    const json = serializeEvaluationReport(report);
    const markdown = renderEvaluationReportMarkdown(report);

    expect(`${json}${markdown}`).not.toMatch(/sensitive-token|gateway-token|custom-secret/u);
    expect(json).toContain("[REDACTED]");
  });

  it("highlights newly failed, regressed, out-of-scope, missing, and added tasks", () => {
    const baseline = createEvaluationReport("baseline", [
      successfulResult("alpha-task"),
      successfulResult("beta-task"),
      successfulResult("delta-task"),
    ]);
    const candidate = createEvaluationReport("candidate", [
      failedResult("alpha-task", "verification_regression", { regressionFree: false }),
      failedResult("beta-task", "scope_violation", {
        resolved: true,
        scopeCompliant: false,
      }),
      successfulResult("gamma-task"),
    ]);

    const comparison = compareEvaluationReports(baseline, candidate);

    expect(comparison).toMatchObject({
      baseline: "baseline",
      candidate: "candidate",
      hasRegression: true,
      newlyFailed: ["alpha-task", "beta-task"],
      verificationRegressions: ["alpha-task"],
      scopeViolations: ["beta-task"],
      missingTasks: ["delta-task"],
      addedTasks: ["gamma-task"],
      metrics: {
        acceptedTasks: { baseline: 3, candidate: 1, delta: -2 },
        resolvedTasks: { baseline: 3, candidate: 2, delta: -1 },
      },
    });
    const markdown = renderEvaluationComparisonMarkdown(comparison);
    expect(markdown).toContain("Regression detected: yes");
    expect(markdown).toContain("Newly failed: alpha-task, beta-task");
    expect(markdown).toContain("| acceptedTasks | 3 | 1 | -2 |");
    expect(JSON.parse(serializeEvaluationComparison(comparison))).toMatchObject({
      baseline: "baseline",
      candidate: "candidate",
      hasRegression: true,
    });
  });

  it("reports a clean comparison when quality dimensions do not regress", () => {
    const baseline = createEvaluationReport("baseline", [successfulResult("alpha-task")]);
    const candidate = createEvaluationReport("candidate", [
      successfulResult("alpha-task", { iterations: 2 }),
    ]);

    const comparison = compareEvaluationReports(baseline, candidate);

    expect(comparison.hasRegression).toBe(false);
    expect(comparison.newlyFailed).toEqual([]);
    expect(comparison.metrics.iterations.delta).toBe(1);
  });

  it("rejects malformed envelopes and inconsistent summaries", () => {
    const report = createEvaluationReport("baseline", [successfulResult("alpha-task")]);

    expect(() => parseEvaluationReport({ ...report, extra: true })).toThrow(EvaluationReportError);
    expect(() =>
      parseEvaluationReport({
        ...report,
        summary: { ...report.summary, acceptedTasks: 0 },
      }),
    ).toThrow("summary is inconsistent");
  });

  it("rejects serialized reports beyond the byte ceiling", () => {
    const results = Array.from({ length: 20 }, (_, index) =>
      failedResult(`task-${String(index + 1).padStart(2, "0")}`, "unknown", {
        failure: {
          category: "unknown",
          reason: "future_reason",
          evidence: Array.from({ length: 25 }, () => "界".repeat(500)),
        },
      }),
    );
    const report = createEvaluationReport("oversized", results);

    expect(() => serializeEvaluationReport(report)).toThrow(
      expect.objectContaining({ code: "report_too_large" }),
    );
  });
});

function successfulResult(
  taskId: string,
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    taskId,
    status: "succeeded",
    resolved: true,
    regressionFree: true,
    scopeCompliant: true,
    accepted: true,
    iterations: 1,
    toolErrors: 0,
    changedFiles: 1,
    elapsedMilliseconds: 100,
    tokenUsage: {
      input: 10,
      cacheCreationInput: 0,
      cacheReadInput: 0,
      totalInput: 10,
      output: 5,
    },
    estimatedCostUsd: 0.001,
    models: ["model-a"],
    failure: null,
    ...overrides,
  };
}

function failedResult(
  taskId: string,
  category: EvaluationFailureCategory,
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    ...successfulResult(taskId),
    status: "failed",
    resolved: false,
    accepted: false,
    failure: {
      category,
      reason: category,
      evidence: [`reason:${category}`],
    },
    ...overrides,
  };
}

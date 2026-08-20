import { describe, expect, it } from "vitest";

import {
  aggregateEvaluationResults,
  classifyEvaluationFailure,
  createEvaluationResult,
  type EvaluationFailureCategory,
} from "../../evals/evaluation-results.js";
import type { ResourceUsageSummary } from "../../src/agent/budget.js";
import type {
  RepairRunReason,
  RepairRunResult,
  RepairRunStatus,
} from "../../src/cli/run-repair.js";

describe("evaluation results", () => {
  it("normalizes a successful repair and all requested metrics", () => {
    const result = createEvaluationResult(
      "greeting-typo",
      repairRun("succeeded", "verified", {
        changedFiles: 1,
        scopeCompliant: true,
        usage: {
          iterations: 3,
          elapsedMilliseconds: 1_234,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 20,
          cacheReadInputTokens: 30,
          totalInputTokens: 150,
          estimatedCostUsd: 0.00125,
          models: ["model-a"],
        },
      }),
      { regressionFree: true, toolErrors: 2 },
    );

    expect(result).toEqual({
      taskId: "greeting-typo",
      status: "succeeded",
      resolved: true,
      regressionFree: true,
      scopeCompliant: true,
      accepted: true,
      iterations: 3,
      toolErrors: 2,
      changedFiles: 1,
      elapsedMilliseconds: 1_234,
      tokenUsage: {
        input: 100,
        cacheCreationInput: 20,
        cacheReadInput: 30,
        totalInput: 150,
        output: 50,
      },
      estimatedCostUsd: 0.00125,
      models: ["model-a"],
      failure: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tokenUsage)).toBe(true);
    expect(Object.isFrozen(result.models)).toBe(true);
  });

  it("attaches exactly one categorized failure with bounded structural evidence", () => {
    const result = createEvaluationResult(
      "failed-task",
      repairRun("failed", "verification_failed", { scopeCompliant: true }),
      { regressionFree: true, toolErrors: 1 },
    );

    expect(result.accepted).toBe(false);
    expect(result.failure).toEqual({
      category: "task_failure",
      reason: "verification_failed",
      evidence: [
        "run:failed",
        "reason:verification_failed",
        "verification:not_run",
        "scope:compliant",
      ],
    });
    expect(Object.isFrozen(result.failure?.evidence)).toBe(true);
  });

  it("keeps resolution separate from scope compliance", () => {
    const result = createEvaluationResult(
      "scope-task",
      repairRun("failed", "scope_violation", {
        verification: passedVerification,
        scopeCompliant: false,
      }),
      { regressionFree: true, toolErrors: 0 },
    );

    expect(result).toMatchObject({
      resolved: true,
      scopeCompliant: false,
      accepted: false,
      failure: { category: "scope_violation" },
    });
  });

  it.each<readonly [string, boolean, boolean, boolean, EvaluationFailureCategory]>([
    ["verification_failed", false, true, true, "task_failure"],
    ["verification_failed", false, false, true, "verification_regression"],
    ["scope_violation", false, true, false, "scope_violation"],
    ["invalid_contract", false, true, false, "configuration_error"],
    ["verification_blocked", false, true, true, "permission_blocked"],
    ["iteration_budget_exhausted", false, true, true, "budget_exhausted"],
    ["invalid_response", false, true, true, "model_failure"],
    ["sandbox_unavailable", false, true, true, "sandbox_failure"],
    ["runtime_failed", false, true, true, "infrastructure_failure"],
    ["cancelled", false, true, true, "cancelled"],
    ["future_reason", false, true, true, "unknown"],
  ])("classifies %s as %s", (reason, resolved, regressionFree, scopeCompliant, expected) => {
    expect(classifyEvaluationFailure(reason, resolved, regressionFree, scopeCompliant)).toBe(
      expected,
    );
  });

  it("aggregates stable rates, totals, and failure counts", () => {
    const success = createEvaluationResult(
      "alpha-task",
      repairRun("succeeded", "verified", {
        changedFiles: 1,
        scopeCompliant: true,
        usage: { ...usage, iterations: 2, inputTokens: 10, totalInputTokens: 10 },
      }),
      { regressionFree: true, toolErrors: 0 },
    );
    const failure = createEvaluationResult(
      "beta-task",
      repairRun("failed", "verification_failed", {
        changedFiles: 2,
        scopeCompliant: true,
        usage: {
          ...usage,
          iterations: 3,
          elapsedMilliseconds: 250,
          outputTokens: 5,
          estimatedCostUsd: 0.02,
        },
      }),
      { regressionFree: true, toolErrors: 1 },
    );

    const summary = aggregateEvaluationResults([failure, success]);

    expect(summary).toMatchObject({
      totalTasks: 2,
      acceptedTasks: 1,
      resolvedTasks: 1,
      regressionFreeTasks: 2,
      scopeCompliantTasks: 2,
      acceptanceRate: 0.5,
      resolutionRate: 0.5,
      regressionFreeRate: 1,
      scopeComplianceRate: 1,
      iterations: 5,
      toolErrors: 1,
      changedFiles: 3,
      elapsedMilliseconds: 250,
      tokenUsage: { input: 10, totalInput: 10, output: 5 },
      estimatedCostUsd: 0.02,
      taskIds: ["alpha-task", "beta-task"],
      failures: { task_failure: 1, unknown: 0 },
    });
    expect(aggregateEvaluationResults([success, failure])).toEqual(summary);
    expect(Object.isFrozen(summary.failures)).toBe(true);
  });

  it("rejects malformed, contradictory, and duplicate records", () => {
    const success = createEvaluationResult(
      "same-task",
      repairRun("succeeded", "verified", { scopeCompliant: true }),
      { regressionFree: true, toolErrors: 0 },
    );
    const failure = createEvaluationResult(
      "other-task",
      repairRun("failed", "verification_failed", { scopeCompliant: true }),
      { regressionFree: true, toolErrors: 0 },
    );

    expect(() => aggregateEvaluationResults([{ ...success, iterations: -1 }])).toThrow();
    expect(() => aggregateEvaluationResults([{ ...failure, failure: null }])).toThrow();
    expect(() => aggregateEvaluationResults([success, { ...success }])).toThrow(
      "task IDs must be unique",
    );
  });

  it("rejects invalid observations before they enter a baseline", () => {
    expect(() =>
      createEvaluationResult(
        "greeting-typo",
        repairRun("succeeded", "verified", { scopeCompliant: true }),
        { regressionFree: true, toolErrors: -1 },
      ),
    ).toThrow();
  });
});

const usage: ResourceUsageSummary = Object.freeze({
  iterations: 0,
  elapsedMilliseconds: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalInputTokens: 0,
  estimatedCostUsd: 0,
  models: Object.freeze([]),
});

function repairRun(
  status: RepairRunStatus,
  reason: RepairRunReason,
  overrides: Partial<
    Pick<RepairRunResult, "changedFiles" | "scopeCompliant" | "usage" | "verification">
  > = {},
): RepairRunResult {
  return Object.freeze({
    status,
    reason,
    runId: "run-1",
    artifactDirectory: "/artifacts/run-1",
    agent: null,
    verification: null,
    usage,
    changedFiles: 0,
    scopeCompliant: false,
    ...overrides,
  });
}

const passedVerification: NonNullable<RepairRunResult["verification"]> = Object.freeze({
  verdict: "passed",
  completedAllChecks: true,
  durationMilliseconds: 1,
  checks: Object.freeze([]),
});

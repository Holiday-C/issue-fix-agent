import { z } from "zod";

import { RESOURCE_BUDGET_CEILINGS } from "../src/agent/budget.js";
import type { ResourceUsageSummary } from "../src/agent/budget.js";
import type { RepairRunResult } from "../src/cli/run-repair.js";
import type { VerificationCheckStatus } from "../src/verification/verification-runner.js";

export const EVALUATION_FAILURE_CATEGORIES = [
  "task_failure",
  "verification_regression",
  "scope_violation",
  "configuration_error",
  "permission_blocked",
  "budget_exhausted",
  "model_failure",
  "sandbox_failure",
  "infrastructure_failure",
  "cancelled",
  "unknown",
] as const;

export type EvaluationFailureCategory = (typeof EVALUATION_FAILURE_CATEGORIES)[number];

export type EvaluationFailure = Readonly<{
  category: EvaluationFailureCategory;
  reason: string;
  evidence: readonly string[];
}>;

export type EvaluationTokenUsage = Readonly<{
  input: number;
  cacheCreationInput: number;
  cacheReadInput: number;
  totalInput: number;
  output: number;
}>;

export type EvaluationResult = Readonly<{
  taskId: string;
  status: RepairRunResult["status"];
  resolved: boolean;
  regressionFree: boolean;
  scopeCompliant: boolean;
  accepted: boolean;
  iterations: number;
  toolErrors: number;
  changedFiles: number;
  elapsedMilliseconds: number;
  tokenUsage: EvaluationTokenUsage;
  estimatedCostUsd: number;
  models: readonly string[];
  failure: EvaluationFailure | null;
}>;

export type EvaluationSummary = Readonly<{
  totalTasks: number;
  acceptedTasks: number;
  resolvedTasks: number;
  regressionFreeTasks: number;
  scopeCompliantTasks: number;
  acceptanceRate: number;
  resolutionRate: number;
  regressionFreeRate: number;
  scopeComplianceRate: number;
  iterations: number;
  toolErrors: number;
  changedFiles: number;
  elapsedMilliseconds: number;
  tokenUsage: EvaluationTokenUsage;
  estimatedCostUsd: number;
  taskIds: readonly string[];
  failures: Readonly<Record<EvaluationFailureCategory, number>>;
}>;

export type EvaluationObservation = Readonly<{
  regressionFree: boolean;
  toolErrors: number;
}>;

export type EvaluationRun = Readonly<{
  status: RepairRunResult["status"];
  reason: string;
  verification: Readonly<{
    verdict: "passed" | "failed";
    checks: readonly Readonly<{ index: number; status: VerificationCheckStatus }>[];
  }> | null;
  usage: ResourceUsageSummary;
  changedFiles: number;
  scopeCompliant: boolean;
}>;

const boundedText = (maximum: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\0"), "Must not contain a null byte");

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenUsageSchema = z.strictObject({
  input: count,
  cacheCreationInput: count,
  cacheReadInput: count,
  totalInput: count,
  output: count,
});
const failureSchema = z.strictObject({
  category: z.enum(EVALUATION_FAILURE_CATEGORIES),
  reason: boundedText(200),
  evidence: z.array(boundedText(500)).min(1).max(25),
});
const resultSchema = z
  .strictObject({
    taskId: boundedText(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    resolved: z.boolean(),
    regressionFree: z.boolean(),
    scopeCompliant: z.boolean(),
    accepted: z.boolean(),
    iterations: count.max(RESOURCE_BUDGET_CEILINGS.maxIterations),
    toolErrors: count,
    changedFiles: count,
    elapsedMilliseconds: count.max(RESOURCE_BUDGET_CEILINGS.maxElapsedMilliseconds),
    tokenUsage: tokenUsageSchema,
    estimatedCostUsd: z.number().finite().min(0).max(RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd),
    models: z.array(boundedText(200)).max(20),
    failure: failureSchema.nullable(),
  })
  .superRefine((result, context) => {
    if (result.status === "succeeded" && !result.resolved) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "A succeeded repair run must be resolved",
      });
    }

    const accepted =
      result.status === "succeeded" &&
      result.resolved &&
      result.regressionFree &&
      result.scopeCompliant;
    if (result.accepted !== accepted) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "Accepted must require resolution, regression safety, and scope compliance",
      });
    }
    if ((result.failure === null) !== result.accepted) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Exactly one failure is required for every unaccepted result",
      });
    }

    const expectedTotalInput =
      result.tokenUsage.input +
      result.tokenUsage.cacheCreationInput +
      result.tokenUsage.cacheReadInput;
    if (
      !Number.isSafeInteger(expectedTotalInput) ||
      result.tokenUsage.totalInput !== expectedTotalInput
    ) {
      context.addIssue({
        code: "custom",
        path: ["tokenUsage", "totalInput"],
        message: "Total input tokens must equal all input token classes",
      });
    }
  });

const resultListSchema = z.array(resultSchema).min(1).max(20);

export function createEvaluationResult(
  taskId: string,
  run: EvaluationRun,
  observation: EvaluationObservation,
): EvaluationResult {
  const resolved = run.status === "succeeded" || run.verification?.verdict === "passed";
  const accepted =
    run.status === "succeeded" && resolved && observation.regressionFree && run.scopeCompliant;
  const failure = accepted
    ? null
    : {
        category: classifyEvaluationFailure(
          run.reason,
          resolved,
          observation.regressionFree,
          run.scopeCompliant,
        ),
        reason: run.reason,
        evidence: failureEvidence(run),
      };

  return freezeResult(
    resultSchema.parse({
      taskId,
      status: run.status,
      resolved,
      regressionFree: observation.regressionFree,
      scopeCompliant: run.scopeCompliant,
      accepted,
      iterations: run.usage.iterations,
      toolErrors: observation.toolErrors,
      changedFiles: run.changedFiles,
      elapsedMilliseconds: run.usage.elapsedMilliseconds,
      tokenUsage: {
        input: run.usage.inputTokens,
        cacheCreationInput: run.usage.cacheCreationInputTokens,
        cacheReadInput: run.usage.cacheReadInputTokens,
        totalInput: run.usage.totalInputTokens,
        output: run.usage.outputTokens,
      },
      estimatedCostUsd: run.usage.estimatedCostUsd,
      models: run.usage.models,
      failure,
    }),
  );
}

export function classifyEvaluationFailure(
  reason: string,
  resolved: boolean,
  regressionFree: boolean,
  scopeCompliant: boolean,
): EvaluationFailureCategory {
  if (reason === "scope_violation" || (resolved && !scopeCompliant)) return "scope_violation";
  if (resolved && !regressionFree) return "verification_regression";

  switch (reason) {
    case "verification_failed":
      return regressionFree ? "task_failure" : "verification_regression";
    case "invalid_yaml":
    case "invalid_contract":
    case "invalid_path":
    case "not_git_repository":
    case "invalid_repository":
    case "invalid_task_path":
    case "invalid_task_file":
    case "invalid_configuration":
    case "invalid_path_policy":
      return "configuration_error";
    case "verification_blocked":
    case "unsupported_verification_command":
    case "repair_context_failed":
      return "permission_blocked";
    case "iteration_budget_exhausted":
    case "elapsed_time_budget_exhausted":
    case "input_token_budget_exhausted":
    case "output_token_budget_exhausted":
    case "cost_budget_exhausted":
      return "budget_exhausted";
    case "invalid_request":
    case "invalid_response":
    case "authentication_failed":
    case "rate_limited":
    case "timed_out":
    case "provider_failed":
    case "max_tokens":
    case "invalid_model_response":
      return "model_failure";
    case "sandbox_unavailable":
      return "sandbox_failure";
    case "worktree_creation_failed":
    case "worktree_cleanup_failed":
    case "cleanup_failed":
    case "artifact_write_failed":
    case "trace_write_failed":
    case "runtime_failed":
      return "infrastructure_failure";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

export function aggregateEvaluationResults(source: unknown): EvaluationSummary {
  const parsed = validateEvaluationResults(source);
  const taskIds = parsed.map((result) => result.taskId);

  const failures = emptyFailureCounts();
  let acceptedTasks = 0;
  let resolvedTasks = 0;
  let regressionFreeTasks = 0;
  let scopeCompliantTasks = 0;
  let iterations = 0;
  let toolErrors = 0;
  let changedFiles = 0;
  let elapsedMilliseconds = 0;
  let input = 0;
  let cacheCreationInput = 0;
  let cacheReadInput = 0;
  let totalInput = 0;
  let output = 0;
  let estimatedCostUsd = 0;

  for (const result of parsed) {
    acceptedTasks += Number(result.accepted);
    resolvedTasks += Number(result.resolved);
    regressionFreeTasks += Number(result.regressionFree);
    scopeCompliantTasks += Number(result.scopeCompliant);
    iterations = safeAdd(iterations, result.iterations);
    toolErrors = safeAdd(toolErrors, result.toolErrors);
    changedFiles = safeAdd(changedFiles, result.changedFiles);
    elapsedMilliseconds = safeAdd(elapsedMilliseconds, result.elapsedMilliseconds);
    input = safeAdd(input, result.tokenUsage.input);
    cacheCreationInput = safeAdd(cacheCreationInput, result.tokenUsage.cacheCreationInput);
    cacheReadInput = safeAdd(cacheReadInput, result.tokenUsage.cacheReadInput);
    totalInput = safeAdd(totalInput, result.tokenUsage.totalInput);
    output = safeAdd(output, result.tokenUsage.output);
    estimatedCostUsd += result.estimatedCostUsd;
    if (result.failure !== null) failures[result.failure.category] += 1;
  }

  const totalTasks = parsed.length;
  return Object.freeze({
    totalTasks,
    acceptedTasks,
    resolvedTasks,
    regressionFreeTasks,
    scopeCompliantTasks,
    acceptanceRate: acceptedTasks / totalTasks,
    resolutionRate: resolvedTasks / totalTasks,
    regressionFreeRate: regressionFreeTasks / totalTasks,
    scopeComplianceRate: scopeCompliantTasks / totalTasks,
    iterations,
    toolErrors,
    changedFiles,
    elapsedMilliseconds,
    tokenUsage: Object.freeze({ input, cacheCreationInput, cacheReadInput, totalInput, output }),
    estimatedCostUsd: roundCost(estimatedCostUsd),
    taskIds: Object.freeze(taskIds),
    failures: Object.freeze(failures),
  });
}

export function validateEvaluationResults(source: unknown): readonly EvaluationResult[] {
  const parsed = resultListSchema
    .parse(source)
    .map(freezeResult)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const taskIds = parsed.map((result) => result.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("Evaluation result task IDs must be unique");
  }
  return Object.freeze(parsed);
}

function failureEvidence(run: EvaluationRun): readonly string[] {
  const checks =
    run.verification?.checks.map(
      (check) => `verification-check:${String(check.index)}:${check.status}`,
    ) ?? [];
  return Object.freeze([
    `run:${run.status}`,
    `reason:${run.reason}`,
    `verification:${run.verification?.verdict ?? "not_run"}`,
    `scope:${run.scopeCompliant ? "compliant" : "not_compliant"}`,
    ...checks,
  ]);
}

function freezeResult(input: z.infer<typeof resultSchema>): EvaluationResult {
  return Object.freeze({
    ...input,
    tokenUsage: Object.freeze({ ...input.tokenUsage }),
    models: Object.freeze([...input.models]),
    failure:
      input.failure === null
        ? null
        : Object.freeze({
            ...input.failure,
            evidence: Object.freeze([...input.failure.evidence]),
          }),
  });
}

function emptyFailureCounts(): Record<EvaluationFailureCategory, number> {
  return {
    task_failure: 0,
    verification_regression: 0,
    scope_violation: 0,
    configuration_error: 0,
    permission_blocked: 0,
    budget_exhausted: 0,
    model_failure: 0,
    sandbox_failure: 0,
    infrastructure_failure: 0,
    cancelled: 0,
    unknown: 0,
  };
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new TypeError("Evaluation metric total is too large");
  return total;
}

function roundCost(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Evaluation cost total is invalid");
  return Number(value.toFixed(8));
}

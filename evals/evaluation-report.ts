import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  aggregateEvaluationResults,
  validateEvaluationResults,
  type EvaluationResult,
  type EvaluationSummary,
} from "./evaluation-results.js";

export const EVALUATION_REPORT_LIMITS = Object.freeze({
  jsonBytes: 512 * 1024,
  markdownBytes: 256 * 1024,
  secretPatterns: 100,
  secretPatternCharacters: 1_000,
});

export type EvaluationReport = Readonly<{
  version: 1;
  name: string;
  results: readonly EvaluationResult[];
  summary: EvaluationSummary;
}>;

export type EvaluationMetricChange = Readonly<{
  baseline: number;
  candidate: number;
  delta: number;
}>;

export type EvaluationComparison = Readonly<{
  version: 1;
  baseline: string;
  candidate: string;
  hasRegression: boolean;
  newlyFailed: readonly string[];
  verificationRegressions: readonly string[];
  scopeViolations: readonly string[];
  missingTasks: readonly string[];
  addedTasks: readonly string[];
  metrics: Readonly<{
    acceptedTasks: EvaluationMetricChange;
    resolvedTasks: EvaluationMetricChange;
    resolutionRate: EvaluationMetricChange;
    regressionFreeTasks: EvaluationMetricChange;
    scopeCompliantTasks: EvaluationMetricChange;
    scopeComplianceRate: EvaluationMetricChange;
    iterations: EvaluationMetricChange;
    toolErrors: EvaluationMetricChange;
    elapsedMilliseconds: EvaluationMetricChange;
    totalInputTokens: EvaluationMetricChange;
    outputTokens: EvaluationMetricChange;
    estimatedCostUsd: EvaluationMetricChange;
  }>;
}>;

export type EvaluationReportOptions = Readonly<{
  secretPatterns?: readonly string[];
}>;

export type EvaluationReportErrorCode = "invalid_report" | "report_too_large";

export class EvaluationReportError extends Error {
  public readonly code: EvaluationReportErrorCode;

  public constructor(code: EvaluationReportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationReportError";
    this.code = code;
  }
}

const boundedText = (maximum: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\0"), "Must not contain a null byte");

const reportNameSchema = boundedText(200);
const secretPatternsSchema = z
  .array(boundedText(EVALUATION_REPORT_LIMITS.secretPatternCharacters))
  .max(EVALUATION_REPORT_LIMITS.secretPatterns);
const reportEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  name: reportNameSchema,
  results: z.unknown(),
  summary: z.unknown(),
});

export function createEvaluationReport(
  name: string,
  source: unknown,
  options: EvaluationReportOptions = {},
): EvaluationReport {
  const patterns = secretPatternsSchema.parse(options.secretPatterns ?? []);
  const redactedName = reportNameSchema.parse(redact(name, patterns));
  const results = validateEvaluationResults(source).map((result) => redactResult(result, patterns));
  const validatedResults = validateEvaluationResults(results);
  return Object.freeze({
    version: 1,
    name: redactedName,
    results: validatedResults,
    summary: aggregateEvaluationResults(validatedResults),
  });
}

export function parseEvaluationReport(source: unknown): EvaluationReport {
  let envelope: z.infer<typeof reportEnvelopeSchema>;
  try {
    envelope = reportEnvelopeSchema.parse(source);
  } catch (error: unknown) {
    throw new EvaluationReportError("invalid_report", "Evaluation report is malformed", {
      cause: error,
    });
  }

  let report: EvaluationReport;
  try {
    report = createEvaluationReport(envelope.name, envelope.results);
  } catch (error: unknown) {
    throw new EvaluationReportError("invalid_report", "Evaluation report is malformed", {
      cause: error,
    });
  }
  if (!isDeepStrictEqual(envelope.summary, report.summary)) {
    throw new EvaluationReportError("invalid_report", "Evaluation report summary is inconsistent");
  }
  return report;
}

export function compareEvaluationReports(
  baselineSource: unknown,
  candidateSource: unknown,
): EvaluationComparison {
  const baseline = parseEvaluationReport(baselineSource);
  const candidate = parseEvaluationReport(candidateSource);
  const baselineByTask = new Map(baseline.results.map((result) => [result.taskId, result]));
  const candidateByTask = new Map(candidate.results.map((result) => [result.taskId, result]));

  const newlyFailed: string[] = [];
  const verificationRegressions: string[] = [];
  const scopeViolations: string[] = [];
  for (const baselineResult of baseline.results) {
    const candidateResult = candidateByTask.get(baselineResult.taskId);
    if (candidateResult === undefined) continue;
    if (baselineResult.accepted && !candidateResult.accepted) {
      newlyFailed.push(baselineResult.taskId);
    }
    if (baselineResult.regressionFree && !candidateResult.regressionFree) {
      verificationRegressions.push(baselineResult.taskId);
    }
    if (baselineResult.scopeCompliant && !candidateResult.scopeCompliant) {
      scopeViolations.push(baselineResult.taskId);
    }
  }

  const missingTasks = baseline.results
    .filter((result) => !candidateByTask.has(result.taskId))
    .map((result) => result.taskId);
  const addedTasks = candidate.results
    .filter((result) => !baselineByTask.has(result.taskId))
    .map((result) => result.taskId);
  const metrics = Object.freeze({
    acceptedTasks: change(baseline.summary.acceptedTasks, candidate.summary.acceptedTasks),
    resolvedTasks: change(baseline.summary.resolvedTasks, candidate.summary.resolvedTasks),
    resolutionRate: change(baseline.summary.resolutionRate, candidate.summary.resolutionRate),
    regressionFreeTasks: change(
      baseline.summary.regressionFreeTasks,
      candidate.summary.regressionFreeTasks,
    ),
    scopeCompliantTasks: change(
      baseline.summary.scopeCompliantTasks,
      candidate.summary.scopeCompliantTasks,
    ),
    scopeComplianceRate: change(
      baseline.summary.scopeComplianceRate,
      candidate.summary.scopeComplianceRate,
    ),
    iterations: change(baseline.summary.iterations, candidate.summary.iterations),
    toolErrors: change(baseline.summary.toolErrors, candidate.summary.toolErrors),
    elapsedMilliseconds: change(
      baseline.summary.elapsedMilliseconds,
      candidate.summary.elapsedMilliseconds,
    ),
    totalInputTokens: change(
      baseline.summary.tokenUsage.totalInput,
      candidate.summary.tokenUsage.totalInput,
    ),
    outputTokens: change(baseline.summary.tokenUsage.output, candidate.summary.tokenUsage.output),
    estimatedCostUsd: change(baseline.summary.estimatedCostUsd, candidate.summary.estimatedCostUsd),
  });

  return Object.freeze({
    version: 1,
    baseline: baseline.name,
    candidate: candidate.name,
    hasRegression:
      newlyFailed.length > 0 ||
      verificationRegressions.length > 0 ||
      scopeViolations.length > 0 ||
      missingTasks.length > 0,
    newlyFailed: Object.freeze(newlyFailed),
    verificationRegressions: Object.freeze(verificationRegressions),
    scopeViolations: Object.freeze(scopeViolations),
    missingTasks: Object.freeze(missingTasks),
    addedTasks: Object.freeze(addedTasks),
    metrics,
  });
}

export function serializeEvaluationReport(source: unknown): string {
  const report = parseEvaluationReport(source);
  return bounded(`${JSON.stringify(report, null, 2)}\n`, EVALUATION_REPORT_LIMITS.jsonBytes);
}

export function serializeEvaluationComparison(comparison: EvaluationComparison): string {
  return bounded(`${JSON.stringify(comparison, null, 2)}\n`, EVALUATION_REPORT_LIMITS.jsonBytes);
}

export function renderEvaluationReportMarkdown(source: unknown): string {
  const report = parseEvaluationReport(source);
  const lines = [
    `# Evaluation report: ${escapeMarkdown(report.name)}`,
    "",
    `- Accepted: ${String(report.summary.acceptedTasks)}/${String(report.summary.totalTasks)}`,
    `- Resolved: ${String(report.summary.resolvedTasks)}/${String(report.summary.totalTasks)}`,
    `- Regression-free: ${String(report.summary.regressionFreeTasks)}/${String(report.summary.totalTasks)}`,
    `- Scope-compliant: ${String(report.summary.scopeCompliantTasks)}/${String(report.summary.totalTasks)}`,
    `- Iterations: ${String(report.summary.iterations)}`,
    `- Tool errors: ${String(report.summary.toolErrors)}`,
    `- Total input tokens: ${String(report.summary.tokenUsage.totalInput)}`,
    `- Output tokens: ${String(report.summary.tokenUsage.output)}`,
    `- Estimated cost (USD): ${report.summary.estimatedCostUsd.toFixed(8)}`,
    "",
    "| Task | Accepted | Resolved | Regression-free | Scope-compliant | Failure |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map((result) =>
      [
        result.taskId,
        yesNo(result.accepted),
        yesNo(result.resolved),
        yesNo(result.regressionFree),
        yesNo(result.scopeCompliant),
        result.failure === null ? "—" : `${result.failure.category} (${result.failure.reason})`,
      ]
        .map(escapeMarkdown)
        .join(" | ")
        .replace(/^/u, "| ")
        .replace(/$/u, " |"),
    ),
    "",
  ];
  return bounded(lines.join("\n"), EVALUATION_REPORT_LIMITS.markdownBytes);
}

export function renderEvaluationComparisonMarkdown(comparison: EvaluationComparison): string {
  const lines = [
    `# Evaluation comparison: ${escapeMarkdown(comparison.candidate)} vs ${escapeMarkdown(comparison.baseline)}`,
    "",
    `Regression detected: ${yesNo(comparison.hasRegression)}`,
    `Newly failed: ${taskList(comparison.newlyFailed)}`,
    `Verification regressions: ${taskList(comparison.verificationRegressions)}`,
    `Scope violations: ${taskList(comparison.scopeViolations)}`,
    `Missing tasks: ${taskList(comparison.missingTasks)}`,
    `Added tasks: ${taskList(comparison.addedTasks)}`,
    "",
    "| Metric | Baseline | Candidate | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(comparison.metrics).map(
      ([name, metric]) =>
        `| ${escapeMarkdown(name)} | ${String(metric.baseline)} | ${String(metric.candidate)} | ${signed(metric.delta)} |`,
    ),
    "",
  ];
  return bounded(lines.join("\n"), EVALUATION_REPORT_LIMITS.markdownBytes);
}

function redactResult(result: EvaluationResult, patterns: readonly string[]): EvaluationResult {
  return Object.freeze({
    ...result,
    models: Object.freeze(result.models.map((model) => redact(model, patterns))),
    failure:
      result.failure === null
        ? null
        : Object.freeze({
            ...result.failure,
            reason: redact(result.failure.reason, patterns),
            evidence: Object.freeze(
              result.failure.evidence.map((evidence) => redact(evidence, patterns)),
            ),
          }),
  });
}

function redact(source: string, patterns: readonly string[]): string {
  let value = source
    .replace(/sk-ant-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]");
  for (const pattern of patterns) value = value.replaceAll(pattern, "[REDACTED]");
  return value;
}

function change(baseline: number, candidate: number): EvaluationMetricChange {
  return Object.freeze({ baseline, candidate, delta: round(candidate - baseline) });
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function bounded(source: string, maximumBytes: number): string {
  if (Buffer.byteLength(source, "utf8") > maximumBytes) {
    throw new EvaluationReportError("report_too_large", "Evaluation report exceeds its size limit");
  }
  return source;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function taskList(tasks: readonly string[]): string {
  return tasks.length === 0 ? "none" : tasks.map(escapeMarkdown).join(", ");
}

function signed(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value);
}

function escapeMarkdown(source: string): string {
  return source.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
}

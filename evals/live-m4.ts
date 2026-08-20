import { resolve } from "node:path";

import { z } from "zod";

import { RESOURCE_BUDGET_CEILINGS } from "../src/agent/budget.js";
import type { EvaluationRun } from "./evaluation-results.js";

export type LiveM4Config = Readonly<{
  protocol: "anthropic" | "openai";
  model: string;
  pricing: string;
  maxCostUsdPerRun: number;
  maxTotalCostUsd: number;
  outputRoot: string;
  baseURL?: string;
  thinkingMode: "enabled" | "disabled" | "provider_default";
}>;

export type LiveM4CliResult = EvaluationRun &
  Readonly<{
    artifactDirectory: string | null;
  }>;

export class LiveM4ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LiveM4ConfigurationError";
  }
}

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.strictObject({
  iterations: count,
  elapsedMilliseconds: count,
  inputTokens: count,
  outputTokens: count,
  cacheCreationInputTokens: count,
  cacheReadInputTokens: count,
  totalInputTokens: count,
  estimatedCostUsd: z.number().finite().min(0),
  models: z.array(z.string().min(1).max(200)).max(20),
});
const cliResultSchema = z.strictObject({
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  reason: z.string().min(1).max(200),
  runId: z.string().nullable(),
  artifactDirectory: z.string().min(1).nullable(),
  changedFiles: count,
  scopeCompliant: z.boolean(),
  usage: usageSchema,
});
const checkSchema = z.object({
  index: count.max(19),
  status: z.enum([
    "passed",
    "denied",
    "timed_out",
    "cancelled",
    "spawn_failed",
    "sandbox_unavailable",
    "sandbox_violation",
    "non_zero_exit",
  ]),
});
const verificationSchema = z.object({
  verdict: z.enum(["passed", "failed"]),
  checks: z.array(checkSchema).max(20),
});
const verificationNotRunSchema = z.object({ verdict: z.literal("not_run") });

export function loadLiveM4Config(
  environment: Readonly<Record<string, string | undefined>>,
  currentDirectory: string,
): LiveM4Config {
  if (environment["ISSUE_FIX_M4_LIVE_EVAL"] !== "1") {
    throw new LiveM4ConfigurationError(
      "Set ISSUE_FIX_M4_LIVE_EVAL=1 to authorize the paid M4 evaluation",
    );
  }

  const protocolValue = environment["ISSUE_FIX_MODEL_PROTOCOL"]?.trim().toLocaleLowerCase("en-US");
  const protocol =
    protocolValue === undefined || protocolValue.length === 0 ? "anthropic" : protocolValue;
  if (protocol !== "anthropic" && protocol !== "openai") {
    throw new LiveM4ConfigurationError("ISSUE_FIX_MODEL_PROTOCOL must be anthropic or openai");
  }

  if (protocol === "anthropic") {
    requireOneCredential(environment, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  } else {
    requireOneCredential(environment, ["OPENAI_AUTH_TOKEN"]);
  }

  const prefix = protocol === "anthropic" ? "ANTHROPIC" : "OPENAI";
  const model = required(environment, `${prefix}_MODEL`);
  if (model.length > 200 || model.includes("\0")) {
    throw new LiveM4ConfigurationError(`${prefix}_MODEL is invalid`);
  }
  const pricing = required(environment, `${prefix}_PRICING`);
  validatePricing(pricing, `${prefix}_PRICING`);
  const maxCostUsdPerRun = optionalPositive(
    environment["ISSUE_FIX_MAX_COST_USD"],
    1,
    RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd,
    "ISSUE_FIX_MAX_COST_USD",
  );
  const maxTotalCostUsd = optionalPositive(
    environment["ISSUE_FIX_M4_MAX_TOTAL_COST_USD"],
    5,
    RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd,
    "ISSUE_FIX_M4_MAX_TOTAL_COST_USD",
  );
  if (maxCostUsdPerRun > maxTotalCostUsd) {
    throw new LiveM4ConfigurationError(
      "ISSUE_FIX_MAX_COST_USD must not exceed ISSUE_FIX_M4_MAX_TOTAL_COST_USD",
    );
  }

  const baseURL = environment[`${prefix}_BASE_URL`]?.trim();
  if (protocol === "openai" && (baseURL === undefined || baseURL.length === 0)) {
    throw new LiveM4ConfigurationError("OPENAI_BASE_URL is required");
  }
  if (baseURL !== undefined && baseURL.length > 0 && !validBaseURL(baseURL)) {
    throw new LiveM4ConfigurationError(`${prefix}_BASE_URL is invalid`);
  }

  const thinkingMode = thinkingModeValue(environment[`${prefix}_THINKING`], protocol);
  const outputRoot = resolve(
    currentDirectory,
    environment["ISSUE_FIX_EVAL_OUTPUT_ROOT"]?.trim() || ".tmp",
  );
  return Object.freeze({
    protocol,
    model,
    pricing,
    maxCostUsdPerRun,
    maxTotalCostUsd,
    outputRoot,
    thinkingMode,
    ...(baseURL === undefined || baseURL.length === 0 ? {} : { baseURL }),
  });
}

export function parseLiveM4CliResult(source: string): LiveM4CliResult {
  const parsed: unknown = JSON.parse(source);
  const result = cliResultSchema.parse(parsed);
  return Object.freeze({
    status: result.status,
    reason: result.reason,
    artifactDirectory: result.artifactDirectory,
    verification: null,
    usage: Object.freeze({ ...result.usage, models: Object.freeze([...result.usage.models]) }),
    changedFiles: result.changedFiles,
    scopeCompliant: result.scopeCompliant,
  });
}

export function parseLiveM4Verification(source: string): EvaluationRun["verification"] {
  const parsed: unknown = JSON.parse(source);
  if (verificationNotRunSchema.safeParse(parsed).success) return null;
  const report = verificationSchema.parse(parsed);
  return Object.freeze({
    verdict: report.verdict,
    checks: Object.freeze(report.checks.map((check) => Object.freeze({ ...check }))),
  });
}

export function isRegressionFree(
  verification: EvaluationRun["verification"],
  totalChecks: number,
  expectedFailureChecks: readonly number[],
): boolean {
  if (verification === null || verification.checks.length !== totalChecks) return false;
  const expected = new Set(expectedFailureChecks);
  const observed = new Set(verification.checks.map((check) => check.index));
  if (observed.size !== totalChecks) return false;
  for (let index = 0; index < totalChecks; index += 1) {
    const check = verification.checks.find((candidate) => candidate.index === index);
    if (check === undefined) return false;
    if (expected.has(index) === (check.status === "passed")) return false;
  }
  return true;
}

export function countToolErrors(trace: string): number {
  let errors = 0;
  for (const line of trace.split("\n")) {
    if (line.trim().length === 0) continue;
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new TypeError("Trace event is malformed");
    if (value["type"] === "tool_completed") {
      const metadata = value["metadata"];
      if (!isRecord(metadata) || typeof metadata["isError"] !== "boolean") {
        throw new TypeError("Tool trace event is malformed");
      }
      if (metadata["isError"]) errors += 1;
    }
  }
  return errors;
}

export function extractPatchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (match === null || match[1] !== match[2]) continue;
    const path = match[1];
    if (
      path !== undefined &&
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.split("/").includes("..")
    ) {
      paths.add(path);
    }
  }
  return Object.freeze([...paths].sort((left, right) => left.localeCompare(right)));
}

export function credentialValues(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.freeze(
    [
      environment["ANTHROPIC_AUTH_TOKEN"],
      environment["ANTHROPIC_API_KEY"],
      environment["OPENAI_AUTH_TOKEN"],
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

function requireOneCredential(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): void {
  if (!names.some((name) => (environment[name]?.trim().length ?? 0) > 0)) {
    throw new LiveM4ConfigurationError(`${names.join(" or ")} is required`);
  }
}

function thinkingModeValue(
  source: string | undefined,
  protocol: "anthropic" | "openai",
): "enabled" | "disabled" | "provider_default" {
  const value = source?.trim().toLocaleLowerCase("en-US");
  if (value === undefined || value.length === 0) {
    return protocol === "anthropic" ? "disabled" : "provider_default";
  }
  if (value === "enabled" || value === "disabled") return value;
  throw new LiveM4ConfigurationError(`${protocol} thinking mode must be enabled or disabled`);
}

function validBaseURL(source: string): boolean {
  try {
    const value = new URL(source);
    return (
      (value.protocol === "https:" || value.protocol === "http:") &&
      value.username.length === 0 &&
      value.password.length === 0 &&
      value.search.length === 0 &&
      value.hash.length === 0
    );
  } catch {
    return false;
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new LiveM4ConfigurationError(`${name} is required`);
  }
  return value;
}

function validatePricing(source: string, name: string): void {
  const parts = source.split(",").map((value) => value.trim());
  const values = parts.map(Number);
  if (
    parts.length !== 4 ||
    parts.some((value) => value.length === 0) ||
    values.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value > RESOURCE_BUDGET_CEILINGS.maxUsdPerMillionTokens,
    )
  ) {
    throw new LiveM4ConfigurationError(`${name} must contain four non-negative rates`);
  }
}

function optionalPositive(
  source: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (source === undefined) return fallback;
  const value = Number(source);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new LiveM4ConfigurationError(`${name} must be positive and bounded`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

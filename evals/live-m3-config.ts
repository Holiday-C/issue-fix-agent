import { resolve } from "node:path";

import { RESOURCE_BUDGET_CEILINGS } from "../src/agent/budget.js";

export type LiveM3Config = Readonly<{
  model: string;
  pricing: string;
  maxCostUsd: number;
  outputRoot: string;
  baseURL?: string;
  thinkingMode: "enabled" | "disabled";
}>;

export class LiveM3ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LiveM3ConfigurationError";
  }
}

export function loadLiveM3Config(
  environment: Readonly<Record<string, string | undefined>>,
  currentDirectory: string,
): LiveM3Config {
  if (environment["ISSUE_FIX_LIVE_EVAL"] !== "1") {
    throw new LiveM3ConfigurationError("Set ISSUE_FIX_LIVE_EVAL=1 to authorize paid evaluation");
  }
  const apiKey = environment["ANTHROPIC_API_KEY"]?.trim();
  const authToken = environment["ANTHROPIC_AUTH_TOKEN"]?.trim();
  if (
    (apiKey === undefined || apiKey.length === 0) &&
    (authToken === undefined || authToken.length === 0)
  ) {
    throw new LiveM3ConfigurationError("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required");
  }
  const model = required(environment, "ANTHROPIC_MODEL");
  if (model.length > 200 || model.includes("\0")) {
    throw new LiveM3ConfigurationError("ANTHROPIC_MODEL is invalid");
  }
  const pricing = required(environment, "ANTHROPIC_PRICING");
  validatePricing(pricing);
  const maxCostUsd = optionalPositive(
    environment["ISSUE_FIX_MAX_COST_USD"],
    5,
    RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd,
    "ISSUE_FIX_MAX_COST_USD",
  );
  const outputRoot = resolve(
    currentDirectory,
    environment["ISSUE_FIX_EVAL_OUTPUT_ROOT"]?.trim() || ".tmp",
  );
  const baseURL = environment["ANTHROPIC_BASE_URL"]?.trim();
  if (baseURL !== undefined && baseURL.length > 0 && !validBaseURL(baseURL)) {
    throw new LiveM3ConfigurationError("ANTHROPIC_BASE_URL is invalid");
  }
  const thinkingMode = thinkingModeValue(environment["ANTHROPIC_THINKING"]);

  return Object.freeze({
    model,
    pricing,
    maxCostUsd,
    outputRoot,
    thinkingMode,
    ...(baseURL === undefined || baseURL.length === 0 ? {} : { baseURL }),
  });
}

function thinkingModeValue(source: string | undefined): "enabled" | "disabled" {
  const value = source?.trim().toLocaleLowerCase("en-US");
  if (value === undefined || value.length === 0) return "disabled";
  if (value === "enabled" || value === "disabled") return value;
  throw new LiveM3ConfigurationError("ANTHROPIC_THINKING must be enabled or disabled");
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
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LiveM3ConfigurationError(`${name} is required`);
  }
  return value.trim();
}

function validatePricing(source: string): void {
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
    throw new LiveM3ConfigurationError("ANTHROPIC_PRICING must contain four non-negative rates");
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
    throw new LiveM3ConfigurationError(`${name} must be positive and bounded`);
  }
  return value;
}

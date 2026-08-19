import { resolve } from "node:path";

import { RESOURCE_BUDGET_CEILINGS } from "../src/agent/budget.js";

export type LiveM3Config = Readonly<{
  model: string;
  pricing: string;
  maxCostUsd: number;
  outputRoot: string;
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
  required(environment, "ANTHROPIC_API_KEY");
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

  return Object.freeze({ model, pricing, maxCostUsd, outputRoot });
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

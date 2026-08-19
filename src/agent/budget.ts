import type { ModelUsage } from "../model/types.js";

export const RESOURCE_BUDGET_CEILINGS = Object.freeze({
  maxIterations: 1_000,
  maxElapsedMilliseconds: 24 * 60 * 60_000,
  maxInputTokens: 1_000_000_000,
  maxOutputTokens: 1_000_000_000,
  maxEstimatedCostUsd: 1_000_000,
  maxUsdPerMillionTokens: 1_000_000,
});

export type BudgetExhaustionReason =
  | "iteration_budget_exhausted"
  | "elapsed_time_budget_exhausted"
  | "input_token_budget_exhausted"
  | "output_token_budget_exhausted"
  | "cost_budget_exhausted";

export type ResourceBudgetLimits = Readonly<{
  maxIterations: number;
  maxElapsedMilliseconds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxEstimatedCostUsd: number;
}>;

export type ModelPricing = Readonly<{
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cacheCreationUsdPerMillionTokens: number;
  cacheReadUsdPerMillionTokens: number;
}>;

export type ResourceUsageSummary = Readonly<{
  iterations: number;
  elapsedMilliseconds: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalInputTokens: number;
  estimatedCostUsd: number;
  models: readonly string[];
}>;

export interface BudgetPort {
  canStartIteration(): boolean;
  exhaustionReason(): BudgetExhaustionReason | undefined;
  recordIteration(): void;
  recordUsage(model: string, usage: ModelUsage): void;
  iterationsUsed(): number;
  summary(): ResourceUsageSummary;
}

export class ResourceBudget implements BudgetPort {
  readonly #limits: ResourceBudgetLimits;
  readonly #pricing: ModelPricing;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #models = new Set<string>();
  #iterations = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #cacheCreationInputTokens = 0;
  #cacheReadInputTokens = 0;

  public constructor(
    limits: ResourceBudgetLimits,
    pricing: ModelPricing,
    now: () => number = () => performance.now(),
  ) {
    validateLimits(limits);
    validatePricing(pricing);
    this.#limits = Object.freeze({ ...limits });
    this.#pricing = Object.freeze({ ...pricing });
    this.#now = now;
    this.#startedAt = validTimestamp(now());
  }

  public canStartIteration(): boolean {
    return this.exhaustionReason() === undefined;
  }

  public exhaustionReason(): BudgetExhaustionReason | undefined {
    if (this.#elapsedMilliseconds() >= this.#limits.maxElapsedMilliseconds) {
      return "elapsed_time_budget_exhausted";
    }
    if (this.#iterations >= this.#limits.maxIterations) {
      return "iteration_budget_exhausted";
    }
    if (this.#totalInputTokens() >= this.#limits.maxInputTokens) {
      return "input_token_budget_exhausted";
    }
    if (this.#outputTokens >= this.#limits.maxOutputTokens) {
      return "output_token_budget_exhausted";
    }
    if (this.#estimatedCostUsd() >= this.#limits.maxEstimatedCostUsd) {
      return "cost_budget_exhausted";
    }
    return undefined;
  }

  public recordIteration(): void {
    if (!this.canStartIteration()) throw new Error("Resource budget is exhausted");
    this.#iterations += 1;
  }

  public recordUsage(model: string, usage: ModelUsage): void {
    if (typeof model !== "string" || model.length === 0 || model.length > 200) {
      throw new Error("Model usage identity is invalid");
    }
    validateUsage(usage);
    this.#inputTokens = safeAdd(this.#inputTokens, usage.inputTokens);
    this.#outputTokens = safeAdd(this.#outputTokens, usage.outputTokens);
    this.#cacheCreationInputTokens = safeAdd(
      this.#cacheCreationInputTokens,
      usage.cacheCreationInputTokens,
    );
    this.#cacheReadInputTokens = safeAdd(this.#cacheReadInputTokens, usage.cacheReadInputTokens);
    this.#totalInputTokens();
    this.#models.add(model);
  }

  public iterationsUsed(): number {
    return this.#iterations;
  }

  public summary(): ResourceUsageSummary {
    return Object.freeze({
      iterations: this.#iterations,
      elapsedMilliseconds: this.#elapsedMilliseconds(),
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      cacheCreationInputTokens: this.#cacheCreationInputTokens,
      cacheReadInputTokens: this.#cacheReadInputTokens,
      totalInputTokens: this.#totalInputTokens(),
      estimatedCostUsd: roundedCost(this.#estimatedCostUsd()),
      models: Object.freeze([...this.#models]),
    });
  }

  #elapsedMilliseconds(): number {
    return Math.max(0, Math.round(validTimestamp(this.#now()) - this.#startedAt));
  }

  #totalInputTokens(): number {
    return safeAdd(
      safeAdd(this.#inputTokens, this.#cacheCreationInputTokens),
      this.#cacheReadInputTokens,
    );
  }

  #estimatedCostUsd(): number {
    return (
      (this.#inputTokens * this.#pricing.inputUsdPerMillionTokens +
        this.#outputTokens * this.#pricing.outputUsdPerMillionTokens +
        this.#cacheCreationInputTokens * this.#pricing.cacheCreationUsdPerMillionTokens +
        this.#cacheReadInputTokens * this.#pricing.cacheReadUsdPerMillionTokens) /
      1_000_000
    );
  }
}

function validateLimits(limits: ResourceBudgetLimits): void {
  positiveInteger(
    limits.maxIterations,
    RESOURCE_BUDGET_CEILINGS.maxIterations,
    "Maximum iterations",
  );
  positiveInteger(
    limits.maxElapsedMilliseconds,
    RESOURCE_BUDGET_CEILINGS.maxElapsedMilliseconds,
    "Maximum elapsed milliseconds",
  );
  positiveInteger(
    limits.maxInputTokens,
    RESOURCE_BUDGET_CEILINGS.maxInputTokens,
    "Maximum input tokens",
  );
  positiveInteger(
    limits.maxOutputTokens,
    RESOURCE_BUDGET_CEILINGS.maxOutputTokens,
    "Maximum output tokens",
  );
  positiveFinite(
    limits.maxEstimatedCostUsd,
    RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd,
    "Maximum estimated cost",
  );
}

function validatePricing(pricing: ModelPricing): void {
  nonNegativeFinite(pricing.inputUsdPerMillionTokens, "Input token price");
  nonNegativeFinite(pricing.outputUsdPerMillionTokens, "Output token price");
  nonNegativeFinite(pricing.cacheCreationUsdPerMillionTokens, "Cache creation token price");
  nonNegativeFinite(pricing.cacheReadUsdPerMillionTokens, "Cache read token price");
}

function validateUsage(usage: ModelUsage): void {
  nonNegativeInteger(usage.inputTokens, "Input token usage");
  nonNegativeInteger(usage.outputTokens, "Output token usage");
  nonNegativeInteger(usage.cacheCreationInputTokens, "Cache creation token usage");
  nonNegativeInteger(usage.cacheReadInputTokens, "Cache read token usage");
}

function positiveInteger(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be between one and ${maximum}`);
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function positiveFinite(value: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be greater than zero and at most ${maximum}`);
  }
}

function nonNegativeFinite(value: number, label: string): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > RESOURCE_BUDGET_CEILINGS.maxUsdPerMillionTokens
  ) {
    throw new Error(`${label} must be between zero and one million`);
  }
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Budget clock returned an invalid timestamp");
  return value;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("Token usage exceeds the safe integer range");
  return value;
}

function roundedCost(value: number): number {
  return Number(value.toFixed(8));
}

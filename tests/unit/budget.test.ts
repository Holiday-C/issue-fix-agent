import { describe, expect, it } from "vitest";

import { ResourceBudget, type ResourceBudgetLimits } from "../../src/agent/budget.js";

describe("ResourceBudget", () => {
  it("tracks elapsed time, official token usage, models, and estimated cost", () => {
    let now = 1_000;
    const budget = new ResourceBudget(generousLimits, pricing, () => now);

    budget.recordIteration();
    budget.recordUsage("model-a", {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
    });
    budget.recordIteration();
    budget.recordUsage("model-a", emptyUsage);
    now = 1_123;

    expect(budget.summary()).toEqual({
      iterations: 2,
      elapsedMilliseconds: 123,
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
      totalInputTokens: 800,
      estimatedCostUsd: 0.003,
      models: ["model-a"],
    });
  });

  it("reports each exhausted ceiling before another iteration starts", () => {
    const iteration = new ResourceBudget({ ...generousLimits, maxIterations: 1 }, zeroPricing);
    iteration.recordIteration();

    let now = 0;
    const elapsed = new ResourceBudget(
      { ...generousLimits, maxElapsedMilliseconds: 10 },
      zeroPricing,
      () => now,
    );
    now = 10;

    const input = new ResourceBudget({ ...generousLimits, maxInputTokens: 10 }, zeroPricing);
    input.recordUsage("model", { ...emptyUsage, inputTokens: 10 });

    const output = new ResourceBudget({ ...generousLimits, maxOutputTokens: 10 }, zeroPricing);
    output.recordUsage("model", { ...emptyUsage, outputTokens: 10 });

    const cost = new ResourceBudget(
      { ...generousLimits, maxEstimatedCostUsd: 1 },
      { ...zeroPricing, inputUsdPerMillionTokens: 1 },
    );
    cost.recordUsage("model", { ...emptyUsage, inputTokens: 1_000_000 });

    expect(iteration.exhaustionReason()).toBe("iteration_budget_exhausted");
    expect(elapsed.exhaustionReason()).toBe("elapsed_time_budget_exhausted");
    expect(input.exhaustionReason()).toBe("input_token_budget_exhausted");
    expect(output.exhaustionReason()).toBe("output_token_budget_exhausted");
    expect(cost.exhaustionReason()).toBe("cost_budget_exhausted");
    expect(
      [iteration, elapsed, input, output, cost].every((value) => !value.canStartIteration()),
    ).toBe(true);
  });

  it("rejects invalid limits, pricing, clocks, and provider usage", () => {
    expect(() => new ResourceBudget({ ...generousLimits, maxIterations: 0 }, zeroPricing)).toThrow(
      "Maximum iterations must be between one and 1000",
    );
    expect(
      () =>
        new ResourceBudget(generousLimits, {
          ...zeroPricing,
          outputUsdPerMillionTokens: Number.NaN,
        }),
    ).toThrow("Output token price must be between zero and one million");
    expect(() => new ResourceBudget(generousLimits, zeroPricing, () => Number.NaN)).toThrow(
      "Budget clock returned an invalid timestamp",
    );
    const budget = new ResourceBudget(generousLimits, zeroPricing);
    expect(() => budget.recordUsage("model", { ...emptyUsage, inputTokens: -1 })).toThrow(
      "Input token usage must be non-negative",
    );
  });
});

const generousLimits: ResourceBudgetLimits = Object.freeze({
  maxIterations: 10,
  maxElapsedMilliseconds: 60_000,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 2_000_000,
  maxEstimatedCostUsd: 100,
});

const pricing = Object.freeze({
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 2,
  cacheCreationUsdPerMillionTokens: 3,
  cacheReadUsdPerMillionTokens: 4,
});

const zeroPricing = Object.freeze({
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  cacheCreationUsdPerMillionTokens: 0,
  cacheReadUsdPerMillionTokens: 0,
});

const emptyUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

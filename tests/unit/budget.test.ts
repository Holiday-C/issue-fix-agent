import { describe, expect, it } from "vitest";

import { IterationBudget } from "../../src/agent/budget.js";

describe("IterationBudget", () => {
  it("allows only the configured number of iterations", () => {
    const budget = new IterationBudget(2);

    expect(budget.canStartIteration()).toBe(true);
    budget.recordIteration();
    expect(budget.canStartIteration()).toBe(true);
    budget.recordIteration();
    expect(budget.canStartIteration()).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid maximum %s", (maximum) => {
    expect(() => new IterationBudget(maximum)).toThrow(
      "Maximum iterations must be a positive safe integer",
    );
  });
});

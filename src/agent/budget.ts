export interface BudgetPort {
  canStartIteration(): boolean;
  recordIteration(): void;
  iterationsUsed(): number;
}

export class IterationBudget implements BudgetPort {
  readonly #maximum: number;
  #used = 0;

  public constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Maximum iterations must be a positive safe integer");
    }

    this.#maximum = maximum;
  }

  public canStartIteration(): boolean {
    return this.#used < this.#maximum;
  }

  public recordIteration(): void {
    if (!this.canStartIteration()) {
      throw new Error("Iteration budget exhausted");
    }

    this.#used += 1;
  }

  public iterationsUsed(): number {
    return this.#used;
  }
}

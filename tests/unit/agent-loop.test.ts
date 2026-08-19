import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import { ResourceBudget, type ResourceBudgetLimits } from "../../src/agent/budget.js";
import type { ModelPort, ModelResponse, ModelUsage } from "../../src/model/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { NoopTraceSink, type TraceEvent, type TraceSink } from "../../src/trace/types.js";

class SequenceModel implements ModelPort {
  public calls = 0;
  readonly #responses: ModelResponse[];

  public constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  public async complete(): Promise<ModelResponse> {
    this.calls += 1;
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("No fake model response available");
    }
    return Promise.resolve(response);
  }
}

class RecordingTrace implements TraceSink {
  public readonly events: TraceEvent[] = [];

  public record(event: TraceEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

describe("runAgentLoop", () => {
  it("returns when the model ends its turn", async () => {
    const model = new SequenceModel([
      {
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        stopReason: "end_turn",
        toolCalls: [],
        model: "test-model",
        usage: usage(5, 2),
      },
    ]);
    const trace = new RecordingTrace();

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model,
        tools: new ToolRegistry([]),
        budget: createBudget(2),
        trace,
      },
    );

    expect(outcome).toMatchObject({
      status: "completed",
      reason: "end_turn",
      iterations: 1,
      usage: { inputTokens: 5, outputTokens: 2, models: ["test-model"] },
    });
    expect(trace.events).toContainEqual({
      type: "model_responded",
      iteration: 1,
      metadata: {
        stopReason: "end_turn",
        toolCalls: 0,
        model: "test-model",
        inputTokens: 5,
        outputTokens: 2,
        estimatedCostUsd: 0,
      },
    });
  });

  it("feeds a tool result back to the model", async () => {
    const model = new SequenceModel([
      {
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "hello" } }],
        },
        stopReason: "tool_use",
        toolCalls: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "hello" } }],
        model: "test-model",
        usage: emptyUsage,
      },
      {
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        stopReason: "end_turn",
        toolCalls: [],
        model: "test-model",
        usage: emptyUsage,
      },
    ]);
    const tools = new ToolRegistry([
      {
        definition: {
          name: "echo",
          description: "Echo test input",
          inputSchema: { type: "object" },
        },
        execute: async () => Promise.resolve({ content: "hello", isError: false }),
      },
    ]);

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Echo" }] }] },
      {
        model,
        tools,
        budget: createBudget(3),
        trace: new NoopTraceSink(),
      },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.messages.at(-2)).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call-1", content: "hello", isError: false }],
    });
  });

  it("stops when the iteration budget is exhausted", async () => {
    const toolCall = { type: "tool_use" as const, id: "call-1", name: "missing", input: {} };
    const model = new SequenceModel([
      {
        message: { role: "assistant", content: [toolCall] },
        stopReason: "tool_use",
        toolCalls: [toolCall],
        model: "test-model",
        usage: emptyUsage,
      },
    ]);

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model,
        tools: new ToolRegistry([]),
        budget: createBudget(1),
        trace: new NoopTraceSink(),
      },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "iteration_budget_exhausted",
      iterations: 1,
    });
  });

  it("returns an explicit failed outcome when trace persistence fails", async () => {
    const trace: TraceSink = {
      record: async () => Promise.reject(new Error("disk full")),
    };

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model: new SequenceModel([]),
        tools: new ToolRegistry([]),
        budget: createBudget(1),
        trace,
      },
    );

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "trace_write_failed",
      iterations: 1,
    });
  });

  it("stops before another model request when the input-token ceiling is reached", async () => {
    const toolCall = { type: "tool_use" as const, id: "call-1", name: "missing", input: {} };
    const model = new SequenceModel([
      {
        message: { role: "assistant", content: [toolCall] },
        stopReason: "tool_use",
        toolCalls: [toolCall],
        model: "test-model",
        usage: usage(10, 1),
      },
    ]);
    const budget = createBudget(3, { maxInputTokens: 10 });

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      { model, tools: new ToolRegistry([]), budget, trace: new NoopTraceSink() },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "input_token_budget_exhausted",
      usage: { totalInputTokens: 10 },
    });
    expect(model.calls).toBe(1);
  });

  it("returns cancelled without calling the model when the host is already aborted", async () => {
    const model = new SequenceModel([]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model,
        tools: new ToolRegistry([]),
        budget: createBudget(2),
        trace: new NoopTraceSink(),
      },
      controller.signal,
    );

    expect(outcome).toMatchObject({ status: "cancelled", reason: "cancelled", iterations: 0 });
    expect(model.calls).toBe(0);
  });
});

const emptyUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

const zeroPricing = Object.freeze({
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  cacheCreationUsdPerMillionTokens: 0,
  cacheReadUsdPerMillionTokens: 0,
});

function createBudget(
  maxIterations: number,
  overrides: Partial<ResourceBudgetLimits> = {},
): ResourceBudget {
  return new ResourceBudget(
    {
      maxIterations,
      maxElapsedMilliseconds: 60_000,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxEstimatedCostUsd: 10,
      ...overrides,
    },
    zeroPricing,
  );
}

function usage(inputTokens: number, outputTokens: number): ModelUsage {
  return Object.freeze({ ...emptyUsage, inputTokens, outputTokens });
}

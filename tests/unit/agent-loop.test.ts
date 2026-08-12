import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import { IterationBudget } from "../../src/agent/budget.js";
import type { ModelPort, ModelResponse } from "../../src/model/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { NoopTraceSink } from "../../src/trace/types.js";

class SequenceModel implements ModelPort {
  readonly #responses: ModelResponse[];

  public constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  public async complete(): Promise<ModelResponse> {
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("No fake model response available");
    }
    return Promise.resolve(response);
  }
}

describe("runAgentLoop", () => {
  it("returns when the model ends its turn", async () => {
    const model = new SequenceModel([
      {
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        stopReason: "end_turn",
        toolCalls: [],
      },
    ]);

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model,
        tools: new ToolRegistry([]),
        budget: new IterationBudget(2),
        trace: new NoopTraceSink(),
      },
    );

    expect(outcome).toMatchObject({ status: "completed", reason: "end_turn", iterations: 1 });
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
      },
      {
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        stopReason: "end_turn",
        toolCalls: [],
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
        budget: new IterationBudget(3),
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
      },
    ]);

    const outcome = await runAgentLoop(
      { system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "Fix" }] }] },
      {
        model,
        tools: new ToolRegistry([]),
        budget: new IterationBudget(1),
        trace: new NoopTraceSink(),
      },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "budget_exhausted",
      iterations: 1,
    });
  });
});

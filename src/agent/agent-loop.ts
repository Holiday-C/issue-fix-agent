import type { ModelPort, ToolResultBlock } from "../model/types.js";
import type { ToolRegistryPort } from "../tools/types.js";
import type { TraceSink } from "../trace/types.js";
import type { BudgetPort } from "./budget.js";
import type { AgentInput, AgentOutcome } from "./types.js";

export type AgentLoopDependencies = Readonly<{
  model: ModelPort;
  tools: ToolRegistryPort;
  budget: BudgetPort;
  trace: TraceSink;
}>;

export async function runAgentLoop(
  input: AgentInput,
  dependencies: AgentLoopDependencies,
): Promise<AgentOutcome> {
  const messages = [...input.messages];

  while (dependencies.budget.canStartIteration()) {
    dependencies.budget.recordIteration();
    const iteration = dependencies.budget.iterationsUsed();
    await dependencies.trace.record({ type: "iteration_started", iteration });

    const response = await dependencies.model.complete({
      system: input.system,
      messages,
      tools: dependencies.tools.definitions(),
    });

    messages.push(response.message);
    await dependencies.trace.record({
      type: "model_responded",
      iteration,
      metadata: { stopReason: response.stopReason, toolCalls: response.toolCalls.length },
    });

    if (response.stopReason === "end_turn") {
      return stop("completed", "end_turn", messages, dependencies, iteration);
    }

    if (response.stopReason === "max_tokens") {
      return stop("blocked", "max_tokens", messages, dependencies, iteration);
    }

    if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
      return stop("failed", "invalid_model_response", messages, dependencies, iteration);
    }

    const results: ToolResultBlock[] = [];

    for (const call of response.toolCalls) {
      const result = await dependencies.tools.execute(call);
      results.push({
        type: "tool_result",
        toolUseId: result.toolUseId,
        content: result.content,
        isError: result.isError,
      });
      await dependencies.trace.record({
        type: "tool_completed",
        iteration,
        metadata: { tool: call.name, isError: result.isError },
      });
    }

    messages.push({ role: "user", content: results });
  }

  const iteration = dependencies.budget.iterationsUsed();
  return stop("blocked", "budget_exhausted", messages, dependencies, iteration);
}

async function stop(
  status: AgentOutcome["status"],
  reason: AgentOutcome["reason"],
  messages: AgentOutcome["messages"],
  dependencies: AgentLoopDependencies,
  iteration: number,
): Promise<AgentOutcome> {
  await dependencies.trace.record({
    type: "agent_stopped",
    iteration,
    metadata: { status, reason },
  });

  return { status, reason, iterations: iteration, messages };
}

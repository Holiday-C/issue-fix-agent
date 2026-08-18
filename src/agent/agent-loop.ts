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
    if (!(await recordTrace(dependencies.trace, { type: "iteration_started", iteration }))) {
      return traceFailure(messages, iteration);
    }

    const response = await dependencies.model.complete({
      system: input.system,
      messages,
      tools: dependencies.tools.definitions(),
    });

    messages.push(response.message);
    if (
      !(await recordTrace(dependencies.trace, {
        type: "model_responded",
        iteration,
        metadata: { stopReason: response.stopReason, toolCalls: response.toolCalls.length },
      }))
    ) {
      return traceFailure(messages, iteration);
    }

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
      if (
        !(await recordTrace(dependencies.trace, {
          type: "tool_completed",
          iteration,
          metadata: { tool: call.name, isError: result.isError },
        }))
      ) {
        return traceFailure(messages, iteration);
      }
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
  if (
    !(await recordTrace(dependencies.trace, {
      type: "agent_stopped",
      iteration,
      metadata: { status, reason },
    }))
  ) {
    return traceFailure(messages, iteration);
  }

  return { status, reason, iterations: iteration, messages };
}

async function recordTrace(
  trace: TraceSink,
  event: Parameters<TraceSink["record"]>[0],
): Promise<boolean> {
  try {
    await trace.record(event);
    return true;
  } catch {
    return false;
  }
}

function traceFailure(messages: AgentOutcome["messages"], iteration: number): AgentOutcome {
  return { status: "failed", reason: "trace_write_failed", iterations: iteration, messages };
}

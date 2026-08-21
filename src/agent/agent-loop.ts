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
  signal?: AbortSignal,
): Promise<AgentOutcome> {
  const messages = [...input.messages];

  if (signalIsAborted(signal)) {
    return stop("cancelled", "cancelled", messages, dependencies, 0);
  }

  while (dependencies.budget.canStartIteration()) {
    try {
      dependencies.budget.recordIteration();
    } catch {
      break;
    }
    const iteration = dependencies.budget.iterationsUsed();
    if (!(await recordTrace(dependencies.trace, { type: "iteration_started", iteration }))) {
      return traceFailure(messages, iteration, dependencies.budget.summary());
    }

    let response: Awaited<ReturnType<ModelPort["complete"]>>;
    try {
      response = await dependencies.model.complete(
        {
          system: input.system,
          messages,
          tools: dependencies.tools.definitions(),
        },
        signal,
      );
    } catch (error: unknown) {
      if (signalIsAborted(signal)) {
        return stop("cancelled", "cancelled", messages, dependencies, iteration);
      }
      throw error;
    }
    if (signalIsAborted(signal)) {
      return stop("cancelled", "cancelled", messages, dependencies, iteration);
    }

    messages.push(response.message);
    try {
      dependencies.budget.recordUsage(response.model, response.usage);
    } catch {
      return stop("failed", "invalid_model_response", messages, dependencies, iteration);
    }
    const usage = dependencies.budget.summary();
    if (
      !(await recordTrace(dependencies.trace, {
        type: "model_responded",
        iteration,
        metadata: {
          stopReason: response.stopReason,
          toolCalls: response.toolCalls.length,
          model: response.model,
          inputTokens: usage.totalInputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostUsd: usage.estimatedCostUsd,
        },
      }))
    ) {
      return traceFailure(messages, iteration, dependencies.budget.summary());
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
          metadata: {
            tool: call.name,
            isError: result.isError,
            ...(result.isError ? { errorCode: toolErrorCode(result.content) } : {}),
          },
        }))
      ) {
        return traceFailure(messages, iteration, dependencies.budget.summary());
      }
    }

    messages.push({ role: "user", content: results });
  }

  const iteration = dependencies.budget.iterationsUsed();
  return stop(
    "blocked",
    dependencies.budget.exhaustionReason() ?? "iteration_budget_exhausted",
    messages,
    dependencies,
    iteration,
  );
}

function toolErrorCode(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
    const error = (value as Readonly<Record<string, unknown>>)["error"];
    if (typeof error !== "object" || error === null || Array.isArray(error)) return "unknown";
    const code = (error as Readonly<Record<string, unknown>>)["code"];
    return typeof code === "string" && /^[a-z0-9_]{1,100}$/u.test(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
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
    return traceFailure(messages, iteration, dependencies.budget.summary());
  }

  return {
    status,
    reason,
    iterations: iteration,
    messages,
    usage: dependencies.budget.summary(),
  };
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

function traceFailure(
  messages: AgentOutcome["messages"],
  iteration: number,
  usage: AgentOutcome["usage"],
): AgentOutcome {
  return { status: "failed", reason: "trace_write_failed", iterations: iteration, messages, usage };
}

function signalIsAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

import type { ConversationMessage } from "../model/types.js";
import type { BudgetExhaustionReason, ResourceUsageSummary } from "./budget.js";

export type AgentOutcome = Readonly<{
  status: "completed" | "blocked" | "failed" | "cancelled";
  reason:
    | "end_turn"
    | BudgetExhaustionReason
    | "max_tokens"
    | "cancelled"
    | "invalid_model_response"
    | "trace_write_failed";
  iterations: number;
  messages: readonly ConversationMessage[];
  usage: ResourceUsageSummary;
}>;

export type AgentInput = Readonly<{
  system: string;
  messages: readonly ConversationMessage[];
}>;

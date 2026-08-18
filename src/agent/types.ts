import type { ConversationMessage } from "../model/types.js";

export type AgentOutcome = Readonly<{
  status: "completed" | "blocked" | "failed";
  reason:
    | "end_turn"
    | "budget_exhausted"
    | "max_tokens"
    | "invalid_model_response"
    | "trace_write_failed";
  iterations: number;
  messages: readonly ConversationMessage[];
}>;

export type AgentInput = Readonly<{
  system: string;
  messages: readonly ConversationMessage[];
}>;

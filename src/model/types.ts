export type TextBlock = Readonly<{
  type: "text";
  text: string;
}>;

export type ToolUseBlock = Readonly<{
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}>;

export type ToolResultBlock = Readonly<{
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
}>;

export type MessageBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: readonly MessageBlock[];
}>;

export type ToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export type ModelRequest = Readonly<{
  system: string;
  messages: readonly ConversationMessage[];
  tools: readonly ToolDefinition[];
}>;

export type ModelStopReason = "end_turn" | "tool_use" | "max_tokens" | "unknown";

export type ModelResponse = Readonly<{
  message: ConversationMessage;
  stopReason: ModelStopReason;
  toolCalls: readonly ToolUseBlock[];
}>;

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

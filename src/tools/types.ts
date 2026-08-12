import type { ToolDefinition, ToolUseBlock } from "../model/types.js";

export type ToolResult = Readonly<{
  toolUseId: string;
  content: string;
  isError: boolean;
}>;

export interface ToolExecutor {
  readonly definition: ToolDefinition;
  execute(input: unknown): Promise<Omit<ToolResult, "toolUseId">>;
}

export interface ToolRegistryPort {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolUseBlock): Promise<ToolResult>;
}

import type { ToolDefinition, ToolUseBlock } from "../model/types.js";
import type { ToolExecutor, ToolRegistryPort, ToolResult } from "./types.js";

export class ToolRegistry implements ToolRegistryPort {
  readonly #executors: ReadonlyMap<string, ToolExecutor>;

  public constructor(executors: readonly ToolExecutor[]) {
    this.#executors = new Map(executors.map((executor) => [executor.definition.name, executor]));

    if (this.#executors.size !== executors.length) {
      throw new Error("Tool names must be unique");
    }
  }

  public definitions(): readonly ToolDefinition[] {
    return [...this.#executors.values()].map((executor) => executor.definition);
  }

  public async execute(call: ToolUseBlock): Promise<ToolResult> {
    const executor = this.#executors.get(call.name);

    if (executor === undefined) {
      return {
        toolUseId: call.id,
        content: `Unknown tool: ${call.name}`,
        isError: true,
      };
    }

    try {
      return {
        toolUseId: call.id,
        ...(await executor.execute(call.input)),
      };
    } catch (error: unknown) {
      return {
        toolUseId: call.id,
        content: error instanceof Error ? error.message : "Tool execution failed",
        isError: true,
      };
    }
  }
}

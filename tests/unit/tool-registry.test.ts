import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/tool-registry.js";

const definition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object" },
} as const;

describe("ToolRegistry", () => {
  it("rejects duplicate names", () => {
    const executor = {
      definition,
      execute: async () => Promise.resolve({ content: "ok", isError: false }),
    };

    expect(() => new ToolRegistry([executor, executor])).toThrow("Tool names must be unique");
  });

  it("returns an error result for an unknown tool", async () => {
    const registry = new ToolRegistry([]);

    await expect(
      registry.execute({ type: "tool_use", id: "call-1", name: "unknown", input: {} }),
    ).resolves.toEqual({
      toolUseId: "call-1",
      content: "Unknown tool: unknown",
      isError: true,
    });
  });
});

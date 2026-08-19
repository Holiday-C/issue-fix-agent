import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandPolicy } from "../../src/permissions/command-policy.js";
import { PathPolicy } from "../../src/permissions/path-policy.js";
import type { ProcessInvocation, ProcessPort, ProcessResult } from "../../src/process/types.js";
import { createCommandTool } from "../../src/tools/command-tool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("createCommandTool", () => {
  it("executes an authorized command and exposes only bounded output metadata", async () => {
    const { tool, process } = await setup();

    const result = await tool.execute({
      executable: "node",
      args: ["check.mjs"],
      cwd: ".",
      timeoutMilliseconds: 5_000,
      maxOutputBytes: 1_000,
    });

    expect(parseJsonObject(result.content)).toMatchObject({
      ok: true,
      outcome: "completed",
      exitCode: 0,
      stdout: { bytes: 14, truncated: false },
    });
    expect(result.content).not.toContain("private output");
    expect(result.isError).toBe(false);
    expect(process.invocations).toHaveLength(1);
  });

  it("returns a structured denial without invoking the process boundary", async () => {
    const { tool, process } = await setup();

    const result = await tool.execute({
      executable: "node",
      args: ["untrusted.mjs"],
      cwd: ".",
    });

    expect(parseJsonObject(result.content)).toMatchObject({
      ok: false,
      error: { code: "command_denied", reason: "command_not_allowed" },
    });
    expect(result.isError).toBe(true);
    expect(process.invocations).toEqual([]);
  });
});

class RecordingProcess implements ProcessPort {
  public readonly invocations: ProcessInvocation[] = [];

  public async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    return Promise.resolve({
      outcome: "completed",
      exitCode: 0,
      durationMilliseconds: 4,
      stdout: "private output",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sandboxViolation: false,
    });
  }

  public async close(): Promise<void> {}
}

async function setup(): Promise<
  Readonly<{
    tool: ReturnType<typeof createCommandTool>;
    process: RecordingProcess;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-command-tool-"));
  temporaryDirectories.push(root);
  const pathPolicy = await PathPolicy.create(root, ["**"]);
  const commandPolicy = new CommandPolicy(pathPolicy, [
    { executable: "node", args: ["check.mjs"] },
  ]);
  const process = new RecordingProcess();
  return Object.freeze({ tool: createCommandTool(commandPolicy, process), process });
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

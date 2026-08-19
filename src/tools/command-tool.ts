import { z } from "zod";

import { COMMAND_CEILINGS, type CommandPolicy } from "../permissions/command-policy.js";
import type { ProcessPort, ProcessResult } from "../process/types.js";
import type { ToolExecutor } from "./types.js";

const commandInput = z.strictObject({
  executable: z.string().min(1).max(300),
  args: z
    .array(
      z
        .string()
        .max(COMMAND_CEILINGS.maxArgumentCharacters)
        .refine((value) => !value.includes("\0")),
    )
    .max(COMMAND_CEILINGS.maxArguments),
  cwd: z.string().min(1).max(500).default("."),
  timeoutMilliseconds: z.int().min(1).max(COMMAND_CEILINGS.timeoutMilliseconds).default(30_000),
  maxOutputBytes: z
    .int()
    .min(1)
    .max(COMMAND_CEILINGS.maxOutputBytes)
    .default(32 * 1024),
});

export function createCommandTool(policy: CommandPolicy, process: ProcessPort): ToolExecutor {
  return Object.freeze({
    definition: Object.freeze({
      name: "run_command",
      description:
        "Run one exactly authorized command in the native sandbox and return bounded metadata.",
      inputSchema: jsonSchema(commandInput),
    }),
    execute: async (input: unknown) => {
      const parsed = commandInput.safeParse(input);
      if (!parsed.success) {
        return toolError("invalid_arguments");
      }

      let decision: Awaited<ReturnType<CommandPolicy["authorize"]>>;
      try {
        decision = await policy.authorize(parsed.data);
      } catch {
        return toolError("authorization_failed");
      }
      if (!decision.allowed) {
        return toolError("command_denied", { reason: decision.reason });
      }

      let result: ProcessResult;
      try {
        result = await process.run(decision.invocation);
      } catch {
        result = emptyProcessResult("spawn_failed");
      }

      const ok =
        result.outcome === "completed" && result.exitCode === 0 && !result.sandboxViolation;
      return Object.freeze({
        content: JSON.stringify({
          ok,
          outcome: result.outcome,
          exitCode: result.exitCode,
          durationMilliseconds: result.durationMilliseconds,
          stdout: {
            bytes: Buffer.byteLength(result.stdout, "utf8"),
            truncated: result.stdoutTruncated,
          },
          stderr: {
            bytes: Buffer.byteLength(result.stderr, "utf8"),
            truncated: result.stderrTruncated,
          },
          sandboxViolation: result.sandboxViolation,
        }),
        isError: !ok,
      });
    },
  });
}

function emptyProcessResult(outcome: ProcessResult["outcome"]): ProcessResult {
  return Object.freeze({
    outcome,
    exitCode: null,
    durationMilliseconds: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sandboxViolation: false,
  });
}

function jsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const value: unknown = z.toJSONSchema(schema);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Zod did not produce an object JSON schema");
  }
  return Object.freeze({ ...value });
}

function toolError(
  code: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Readonly<{ content: string; isError: true }> {
  return Object.freeze({
    content: JSON.stringify({ ok: false, error: { code, ...metadata } }),
    isError: true,
  });
}

import { stat } from "node:fs/promises";

import { z } from "zod";

import type { ProcessInvocation } from "../process/types.js";
import type { PathPolicy } from "./path-policy.js";

export const COMMAND_CEILINGS = Object.freeze({
  timeoutMilliseconds: 120_000,
  maxOutputBytes: 64 * 1024,
  maxArguments: 100,
  maxArgumentCharacters: 2_000,
});

export type AllowedCommand = Readonly<{
  executable: "node";
  args: readonly string[];
}>;

export type CommandDenialReason =
  | "invalid_request"
  | "unsupported_executable"
  | "command_not_allowed"
  | "cwd_denied"
  | "cwd_not_directory";

export type CommandDecision =
  | Readonly<{ allowed: true; invocation: ProcessInvocation }>
  | Readonly<{ allowed: false; reason: CommandDenialReason }>;

const commandRequestSchema = z.strictObject({
  executable: z.string().min(1).max(300),
  args: z
    .array(z.string().max(COMMAND_CEILINGS.maxArgumentCharacters).refine(noNullByte))
    .max(COMMAND_CEILINGS.maxArguments),
  cwd: z.string().min(1).max(500).default("."),
  timeoutMilliseconds: z.int().min(1).max(COMMAND_CEILINGS.timeoutMilliseconds).default(30_000),
  maxOutputBytes: z
    .int()
    .min(1)
    .max(COMMAND_CEILINGS.maxOutputBytes)
    .default(32 * 1024),
});

export class CommandPolicy {
  readonly #pathPolicy: PathPolicy;
  readonly #allowedCommands: readonly AllowedCommand[];

  public constructor(pathPolicy: PathPolicy, allowedCommands: readonly AllowedCommand[]) {
    if (allowedCommands.length === 0) {
      throw new Error("At least one trusted command must be configured");
    }
    this.#pathPolicy = pathPolicy;
    this.#allowedCommands = Object.freeze(
      allowedCommands.map((command) =>
        Object.freeze({ executable: command.executable, args: Object.freeze([...command.args]) }),
      ),
    );
    Object.freeze(this);
  }

  public async authorize(request: unknown): Promise<CommandDecision> {
    const parsed = commandRequestSchema.safeParse(request);
    if (!parsed.success) {
      return deny("invalid_request");
    }
    if (parsed.data.executable !== "node") {
      return deny("unsupported_executable");
    }
    if (
      !this.#allowedCommands.some(
        (allowed) =>
          allowed.executable === parsed.data.executable &&
          sameArguments(allowed.args, parsed.data.args),
      )
    ) {
      return deny("command_not_allowed");
    }

    const canonicalCwd =
      parsed.data.cwd === "."
        ? this.#pathPolicy.worktreeRoot
        : await resolveCommandDirectory(this.#pathPolicy, parsed.data.cwd);
    if (canonicalCwd === undefined) {
      return deny("cwd_denied");
    }
    if (!(await stat(canonicalCwd)).isDirectory()) {
      return deny("cwd_not_directory");
    }

    return Object.freeze({
      allowed: true,
      invocation: Object.freeze({
        executable: process.execPath,
        args: Object.freeze([...parsed.data.args]),
        cwd: canonicalCwd,
        timeoutMilliseconds: parsed.data.timeoutMilliseconds,
        maxOutputBytes: parsed.data.maxOutputBytes,
      }),
    });
  }
}

async function resolveCommandDirectory(
  pathPolicy: PathPolicy,
  path: string,
): Promise<string | undefined> {
  const decision = await pathPolicy.authorize({ operation: "read", path });
  return decision.allowed ? decision.canonicalPath : undefined;
}

function noNullByte(value: string): boolean {
  return !value.includes("\0");
}

function sameArguments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deny(reason: CommandDenialReason): CommandDecision {
  return Object.freeze({ allowed: false, reason });
}

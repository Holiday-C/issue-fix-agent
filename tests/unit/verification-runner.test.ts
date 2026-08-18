import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandDecision } from "../../src/permissions/command-policy.js";
import type { ProcessInvocation, ProcessPort, ProcessResult } from "../../src/process/types.js";
import type { TaskContract, VerificationCommand } from "../../src/task/task-contract.js";
import {
  type CommandAuthorizer,
  runVerification,
} from "../../src/verification/verification-runner.js";

afterEach(() => vi.useRealTimers());

describe("runVerification", () => {
  it("authorizes and runs every check in deterministic order", async () => {
    const commands = [command("first.mjs"), command("second.mjs")];
    const authorizer = new RecordingAuthorizer("/worktree");
    const process = new SequenceProcess([
      processResult({ stdout: "first\n", durationMilliseconds: 12 }),
      processResult({ stderr: "second warning\n", durationMilliseconds: 8 }),
    ]);

    const report = await runVerification({
      task: task(commands),
      worktreeRoot: "/worktree",
      commands: authorizer,
      process,
    });

    expect(report).toMatchObject({
      verdict: "passed",
      completedAllChecks: true,
      checks: [
        {
          index: 0,
          command: commands[0],
          status: "passed",
          exitCode: 0,
          durationMilliseconds: 12,
          stdout: { text: "first\n", bytes: 6, truncated: false },
        },
        {
          index: 1,
          command: commands[1],
          status: "passed",
          durationMilliseconds: 8,
        },
      ],
    });
    expect(authorizer.requests.map((request) => request.args)).toEqual([
      ["first.mjs"],
      ["second.mjs"],
    ]);
    expect(process.invocations.map((invocation) => invocation.args)).toEqual([
      ["first.mjs"],
      ["second.mjs"],
    ]);
  });

  it.each([
    [processResult({ outcome: "timed_out" }), "timed_out"],
    [processResult({ outcome: "cancelled" }), "cancelled"],
    [processResult({ outcome: "spawn_failed" }), "spawn_failed"],
    [processResult({ outcome: "sandbox_unavailable" }), "sandbox_unavailable"],
    [processResult({ exitCode: 2 }), "non_zero_exit"],
    [processResult({ sandboxViolation: true }), "sandbox_violation"],
  ] as const)("normalizes process result %j as %s", async (result, status) => {
    const report = await runVerification({
      task: task([command("check.mjs")]),
      worktreeRoot: "/worktree",
      commands: new RecordingAuthorizer("/worktree"),
      process: new SequenceProcess([result]),
    });

    expect(report).toMatchObject({
      verdict: "failed",
      completedAllChecks: true,
      checks: [{ status }],
    });
  });

  it("records denial without crossing the process boundary", async () => {
    const authorizer: CommandAuthorizer = {
      authorize: async () => Promise.resolve({ allowed: false, reason: "command_not_allowed" }),
    };
    const process = new SequenceProcess([]);

    const report = await runVerification({
      task: task([command("denied.mjs")]),
      worktreeRoot: "/worktree",
      commands: authorizer,
      process,
    });

    expect(report.checks).toMatchObject([
      { status: "denied", denialReason: "command_not_allowed" },
    ]);
    expect(process.invocations).toEqual([]);
  });

  it("converts authorization and process exceptions into structured failures", async () => {
    const authorizationFailure = await runVerification({
      task: task([command("authorization.mjs")]),
      worktreeRoot: "/worktree",
      commands: { authorize: async () => Promise.reject(new Error("policy failure")) },
      process: new SequenceProcess([]),
    });
    const processFailure = await runVerification({
      task: task([command("spawn.mjs")]),
      worktreeRoot: "/worktree",
      commands: new RecordingAuthorizer("/worktree"),
      process: {
        run: async () => Promise.reject(new Error("spawn failure")),
        close: async () => {},
      },
    });

    expect(authorizationFailure.checks).toMatchObject([
      { status: "denied", denialReason: "authorization_failed" },
    ]);
    expect(processFailure.checks).toMatchObject([{ status: "spawn_failed" }]);
  });

  it("bounds output again when a process adapter violates its contract", async () => {
    const report = await runVerification({
      task: task([command("output.mjs")]),
      worktreeRoot: "/worktree",
      commands: new RecordingAuthorizer("/worktree"),
      process: new SequenceProcess([processResult({ stdout: "x".repeat(40_000) })]),
    });

    expect(report.checks[0]?.stdout).toMatchObject({ bytes: 32 * 1024, truncated: true });
  });

  it("keeps verifier ceilings when an authorizer returns larger process limits", async () => {
    const runner = new SequenceProcess([processResult()]);
    const commands: CommandAuthorizer = {
      authorize: async () =>
        Promise.resolve({
          allowed: true,
          invocation: {
            executable: process.execPath,
            args: ["limits.mjs"],
            cwd: "/worktree",
            timeoutMilliseconds: 999_999,
            maxOutputBytes: 999_999,
          },
        }),
    };

    await runVerification({
      task: task([command("limits.mjs")]),
      worktreeRoot: "/worktree",
      commands,
      process: runner,
    });

    expect(runner.invocations[0]).toMatchObject({
      timeoutMilliseconds: 30_000,
      maxOutputBytes: 32 * 1024,
    });
  });

  it("enforces the task-wide timeout and stops scheduling checks", async () => {
    vi.useFakeTimers();
    const waitingProcess: ProcessPort = {
      run: async (_invocation, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => resolve(processResult({ outcome: "cancelled" })),
            { once: true },
          );
        }),
      close: async () => {},
    };
    const pending = runVerification({
      task: task([command("wait.mjs"), command("never.mjs")]),
      worktreeRoot: "/worktree",
      commands: new RecordingAuthorizer("/worktree"),
      process: waitingProcess,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({
      verdict: "failed",
      completedAllChecks: false,
      checks: [{ status: "timed_out" }],
    });
  });
});

class RecordingAuthorizer implements CommandAuthorizer {
  public readonly requests: Array<Readonly<{ executable: string; args: readonly string[] }>> = [];
  readonly #worktreeRoot: string;

  public constructor(worktreeRoot: string) {
    this.#worktreeRoot = worktreeRoot;
  }

  public async authorize(request: unknown): Promise<CommandDecision> {
    if (!isCommandRequest(request)) return { allowed: false, reason: "invalid_request" };
    this.requests.push({ executable: request.executable, args: request.args });
    return Promise.resolve({
      allowed: true,
      invocation: {
        executable: process.execPath,
        args: request.args,
        cwd: this.#worktreeRoot,
        timeoutMilliseconds: request.timeoutMilliseconds,
        maxOutputBytes: request.maxOutputBytes,
      },
    });
  }
}

class SequenceProcess implements ProcessPort {
  public readonly invocations: ProcessInvocation[] = [];
  readonly #results: ProcessResult[];

  public constructor(results: readonly ProcessResult[]) {
    this.#results = [...results];
  }

  public async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No process result available");
    return Promise.resolve(result);
  }

  public async close(): Promise<void> {}
}

function task(verification: readonly VerificationCommand[]): TaskContract {
  return Object.freeze({
    title: "Verification task",
    description: "Run deterministic checks.",
    acceptanceCriteria: Object.freeze(["Checks pass"]),
    allowedPaths: Object.freeze(["src/**"]),
    verification: Object.freeze([...verification]),
    limits: Object.freeze({ maxIterations: 2, maxChangedFiles: 2, timeoutMinutes: 1 }),
  });
}

function command(script: string): VerificationCommand {
  return Object.freeze({ executable: "node", args: Object.freeze([script]) });
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return Object.freeze({
    outcome: "completed",
    exitCode: 0,
    durationMilliseconds: 1,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sandboxViolation: false,
    ...overrides,
  });
}

function isCommandRequest(value: unknown): value is Readonly<{
  executable: string;
  args: readonly string[];
  timeoutMilliseconds: number;
  maxOutputBytes: number;
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "executable" in value &&
    typeof value.executable === "string" &&
    "args" in value &&
    Array.isArray(value.args) &&
    value.args.every((argument: unknown) => typeof argument === "string") &&
    "timeoutMilliseconds" in value &&
    typeof value.timeoutMilliseconds === "number" &&
    "maxOutputBytes" in value &&
    typeof value.maxOutputBytes === "number"
  );
}

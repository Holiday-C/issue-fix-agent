import type { CommandDecision, CommandDenialReason } from "../permissions/command-policy.js";
import type { ProcessPort, ProcessResult } from "../process/types.js";
import type { TaskContract, VerificationCommand } from "../task/task-contract.js";

export const VERIFICATION_LIMITS = Object.freeze({
  perCommandTimeoutMilliseconds: 30_000,
  maxOutputBytes: 32 * 1024,
});

export interface CommandAuthorizer {
  authorize(request: unknown): Promise<CommandDecision>;
}

export type VerificationContext = Readonly<{
  task: TaskContract;
  worktreeRoot: string;
  commands: CommandAuthorizer;
  process: ProcessPort;
}>;

export type VerificationCheckStatus =
  | "passed"
  | "denied"
  | "timed_out"
  | "cancelled"
  | "spawn_failed"
  | "sandbox_unavailable"
  | "sandbox_violation"
  | "non_zero_exit";

export type VerificationOutput = Readonly<{
  text: string;
  bytes: number;
  truncated: boolean;
}>;

export type VerificationCheckResult = Readonly<{
  index: number;
  command: VerificationCommand;
  status: VerificationCheckStatus;
  denialReason: CommandDenialReason | "authorization_failed" | "worktree_mismatch" | null;
  exitCode: number | null;
  durationMilliseconds: number;
  stdout: VerificationOutput;
  stderr: VerificationOutput;
  sandboxViolation: boolean;
}>;

export type VerificationReport = Readonly<{
  verdict: "passed" | "failed";
  completedAllChecks: boolean;
  durationMilliseconds: number;
  checks: readonly VerificationCheckResult[];
}>;

export async function runVerification(
  context: VerificationContext,
  signal?: AbortSignal,
): Promise<VerificationReport> {
  const startedAt = performance.now();
  const checks: VerificationCheckResult[] = [];
  const timeout = createOverallTimeout(context.task.limits.timeoutMinutes, signal);

  try {
    for (const [index, command] of context.task.verification.entries()) {
      if (timeout.signal.aborted) {
        checks.push(emptyCheck(index, command, timeout.timedOut() ? "timed_out" : "cancelled"));
        break;
      }

      const authorizationStartedAt = performance.now();
      let decision: CommandDecision;
      try {
        decision = await context.commands.authorize({
          executable: command.executable,
          args: command.args,
          cwd: ".",
          timeoutMilliseconds: VERIFICATION_LIMITS.perCommandTimeoutMilliseconds,
          maxOutputBytes: VERIFICATION_LIMITS.maxOutputBytes,
        });
      } catch {
        checks.push(
          deniedCheck(index, command, "authorization_failed", elapsed(authorizationStartedAt)),
        );
        continue;
      }

      if (!decision.allowed) {
        checks.push(deniedCheck(index, command, decision.reason, elapsed(authorizationStartedAt)));
        continue;
      }
      if (decision.invocation.cwd !== context.worktreeRoot) {
        checks.push(
          deniedCheck(index, command, "worktree_mismatch", elapsed(authorizationStartedAt)),
        );
        continue;
      }

      const invocation = Object.freeze({
        ...decision.invocation,
        timeoutMilliseconds: boundedPositive(
          decision.invocation.timeoutMilliseconds,
          VERIFICATION_LIMITS.perCommandTimeoutMilliseconds,
        ),
        maxOutputBytes: boundedPositive(
          decision.invocation.maxOutputBytes,
          VERIFICATION_LIMITS.maxOutputBytes,
        ),
      });
      let result: ProcessResult;
      try {
        result = await context.process.run(invocation, timeout.signal);
      } catch {
        checks.push(emptyCheck(index, command, "spawn_failed"));
        continue;
      }

      const check = normalizeCheck(index, command, result, timeout.timedOut());
      checks.push(check);
      if (
        check.status === "cancelled" ||
        (check.status === "timed_out" && timeout.signal.aborted)
      ) {
        break;
      }
    }
  } finally {
    timeout.dispose();
  }

  const completedAllChecks = checks.length === context.task.verification.length;
  return Object.freeze({
    verdict:
      completedAllChecks && checks.every((check) => check.status === "passed")
        ? "passed"
        : "failed",
    completedAllChecks,
    durationMilliseconds: elapsed(startedAt),
    checks: Object.freeze(checks),
  });
}

function normalizeCheck(
  index: number,
  command: VerificationCommand,
  result: ProcessResult,
  overallTimedOut: boolean,
): VerificationCheckResult {
  const status = checkStatus(result, overallTimedOut);
  return Object.freeze({
    index,
    command,
    status,
    denialReason: null,
    exitCode: result.exitCode,
    durationMilliseconds: normalizedDuration(result.durationMilliseconds),
    stdout: normalizeOutput(result.stdout, result.stdoutTruncated),
    stderr: normalizeOutput(result.stderr, result.stderrTruncated),
    sandboxViolation: result.sandboxViolation,
  });
}

function checkStatus(result: ProcessResult, overallTimedOut: boolean): VerificationCheckStatus {
  if (overallTimedOut && result.outcome === "cancelled") return "timed_out";
  if (result.outcome !== "completed") return result.outcome;
  if (result.sandboxViolation) return "sandbox_violation";
  if (result.exitCode === null) return "spawn_failed";
  return result.exitCode === 0 ? "passed" : "non_zero_exit";
}

function deniedCheck(
  index: number,
  command: VerificationCommand,
  reason: VerificationCheckResult["denialReason"],
  durationMilliseconds: number,
): VerificationCheckResult {
  return Object.freeze({
    ...emptyCheck(index, command, "denied"),
    denialReason: reason,
    durationMilliseconds,
  });
}

function emptyCheck(
  index: number,
  command: VerificationCommand,
  status: Exclude<VerificationCheckStatus, "passed" | "non_zero_exit" | "sandbox_violation">,
): VerificationCheckResult {
  return Object.freeze({
    index,
    command,
    status,
    denialReason: null,
    exitCode: null,
    durationMilliseconds: 0,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    sandboxViolation: false,
  });
}

function normalizeOutput(source: string, reportedTruncated: boolean): VerificationOutput {
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes <= VERIFICATION_LIMITS.maxOutputBytes) {
    return Object.freeze({ text: source, bytes: sourceBytes, truncated: reportedTruncated });
  }

  let text = Buffer.from(source, "utf8")
    .subarray(0, VERIFICATION_LIMITS.maxOutputBytes)
    .toString("utf8");
  while (Buffer.byteLength(text, "utf8") > VERIFICATION_LIMITS.maxOutputBytes) {
    text = text.slice(0, -1);
  }
  return Object.freeze({
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: true,
  });
}

function emptyOutput(): VerificationOutput {
  return Object.freeze({ text: "", bytes: 0, truncated: false });
}

function normalizedDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function boundedPositive(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(1, Math.round(value)), maximum) : maximum;
}

function elapsed(startedAt: number): number {
  return normalizedDuration(performance.now() - startedAt);
}

function createOverallTimeout(
  timeoutMinutes: number,
  externalSignal?: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}> {
  const controller = new AbortController();
  let didTimeOut = false;
  const cancel = (): void => controller.abort();
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMinutes * 60_000);

  if (externalSignal?.aborted === true) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });

  return Object.freeze({
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    },
  });
}

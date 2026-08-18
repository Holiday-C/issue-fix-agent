export type ProcessOutcome =
  | "completed"
  | "timed_out"
  | "cancelled"
  | "spawn_failed"
  | "sandbox_unavailable";

export type ProcessInvocation = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMilliseconds: number;
  maxOutputBytes: number;
}>;

export type ProcessResult = Readonly<{
  outcome: ProcessOutcome;
  exitCode: number | null;
  durationMilliseconds: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sandboxViolation: boolean;
}>;

export interface ProcessPort {
  run(invocation: ProcessInvocation, signal?: AbortSignal): Promise<ProcessResult>;
  close(): Promise<void>;
}

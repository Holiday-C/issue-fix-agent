import type { AgentOutcome } from "../agent/types.js";
import type { BudgetPort, ResourceUsageSummary } from "../agent/budget.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import {
  AnthropicModelError,
  type AnthropicModelErrorCode,
} from "../model/anthropic-messages-adapter.js";
import type { ModelPort } from "../model/types.js";
import { CommandPolicy } from "../permissions/command-policy.js";
import { PathPolicyConfigurationError } from "../permissions/path-policy.js";
import { SandboxRuntimeAdapter } from "../process/sandbox-runtime-adapter.js";
import type { ProcessPort } from "../process/types.js";
import {
  TaskContractError,
  type TaskContract,
  type TaskContractErrorCode,
} from "../task/task-contract.js";
import { createCommandTool } from "../tools/command-tool.js";
import { createRepositoryDiscoveryTools } from "../tools/repository-discovery.js";
import { createRepositoryMutationTools } from "../tools/repository-mutation.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolResult } from "../tools/types.js";
import { createRunArtifacts, type RunArtifacts } from "../trace/run-artifacts.js";
import type { TraceEvent } from "../trace/types.js";
import { runVerification, type VerificationReport } from "../verification/verification-runner.js";
import { WorkspaceError, type WorkspaceErrorCode } from "../workspace/git-worktree.js";
import { loadRepositoryInstructions } from "../workspace/repository-instructions.js";
import { buildRepairContext, RepairContextError } from "./repair-context.js";
import {
  prepareRun,
  RunPreparationError,
  type PreparedRun,
  type RunPreparationErrorCode,
} from "./prepare-run.js";

export type RepairRunStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export type RepairRunReason =
  | "verified"
  | AgentOutcome["reason"]
  | AnthropicModelErrorCode
  | TaskContractErrorCode
  | WorkspaceErrorCode
  | RunPreparationErrorCode
  | "invalid_path_policy"
  | "unsupported_verification_command"
  | "repair_context_failed"
  | "sandbox_unavailable"
  | "verification_failed"
  | "verification_blocked"
  | "scope_violation"
  | "cleanup_failed"
  | "artifact_write_failed"
  | "runtime_failed";

export type RepairRunInput = Readonly<{
  repositoryPath: string;
  taskPath: string;
  model: ModelPort;
  budget: BudgetPort;
  runId?: string;
  temporaryDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (event: TraceEvent) => void;
}>;

export type RepairRunResult = Readonly<{
  status: RepairRunStatus;
  reason: RepairRunReason;
  runId: string | null;
  artifactDirectory: string | null;
  agent: AgentOutcome | null;
  verification: VerificationReport | null;
  usage: ResourceUsageSummary;
  changedFiles: number;
  scopeCompliant: boolean;
}>;

export type RepairRunDependencies = Readonly<{
  createProcess(worktreeRoot: string): Promise<ProcessPort>;
}>;

const defaultDependencies: RepairRunDependencies = Object.freeze({
  createProcess: (worktreeRoot) => SandboxRuntimeAdapter.create(worktreeRoot),
});

export async function runRepair(
  input: RepairRunInput,
  dependencies: RepairRunDependencies = defaultDependencies,
): Promise<RepairRunResult> {
  const prepared = await prepare(input);
  if (!("task" in prepared)) return prepared;

  let artifacts: RunArtifacts;
  try {
    const options = {
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.onProgress === undefined ? {} : { onEvent: input.onProgress }),
    };
    artifacts = await createRunArtifacts(prepared.repositoryRoot, options);
    await artifacts.writeTask(prepared.task);
  } catch {
    await prepared.cleanup().catch(() => undefined);
    return outcome(input.budget, "failed", "artifact_write_failed");
  }

  let process: ProcessPort | undefined;
  let agent: AgentOutcome | null = null;
  let verification: VerificationReport | null = null;
  let patch = "";
  let changedFiles = 0;
  let scopeCompliant = false;
  let status: RepairRunStatus = "failed";
  let reason: RepairRunReason = "runtime_failed";

  try {
    const instructions = await loadRepositoryInstructions(prepared.task, prepared.pathPolicy);
    const context = buildRepairContext(prepared.task, instructions);
    const commandPolicy = new CommandPolicy(
      prepared.pathPolicy,
      allowedVerificationCommands(prepared.task),
    );
    try {
      process = await dependencies.createProcess(prepared.worktreeRoot);
    } catch {
      status = "blocked";
      reason = "sandbox_unavailable";
    }

    if (process !== undefined) {
      const tools = new ToolRegistry([
        ...createRepositoryDiscoveryTools(prepared.pathPolicy),
        ...createRepositoryMutationTools(prepared.pathPolicy),
        createCommandTool(commandPolicy, process),
      ]);
      try {
        agent = await runAgentLoop(
          context.input,
          { model: input.model, tools, budget: input.budget, trace: artifacts.trace },
          input.signal,
        );
      } catch (error: unknown) {
        ({ status, reason } = modelFailure(error));
      }

      if (agent !== null) {
        if (agent.status === "completed" || agent.status === "blocked") {
          verification = await runVerification(
            {
              task: prepared.task,
              worktreeRoot: prepared.worktreeRoot,
              commands: commandPolicy,
              process,
            },
            input.signal,
          );
          await artifacts.trace.record({
            type: "verification_completed",
            iteration: agent.iterations,
            metadata: { verdict: verification.verdict },
          });
        }

        const diffResult = await tools.execute({
          type: "tool_use",
          id: "final-diff",
          name: "git_diff",
          input: { maxBytes: 32 * 1024 },
        });
        const diff = normalizeDiff(diffResult, prepared.task.limits.maxChangedFiles);
        patch = diff.patch;
        changedFiles = diff.changedFiles;
        scopeCompliant = diff.scopeCompliant;
        ({ status, reason } = finalOutcome(
          agent,
          verification,
          scopeCompliant,
          input.signal?.aborted === true,
        ));
      }
    }
  } catch (error: unknown) {
    if (error instanceof UnsupportedVerificationCommandError) {
      status = "blocked";
      reason = "unsupported_verification_command";
    } else if (error instanceof RepairContextError) {
      status = "blocked";
      reason = "repair_context_failed";
    } else {
      status = "failed";
      reason = "runtime_failed";
    }
  }

  let cleanupFailed = false;
  if (process !== undefined) {
    try {
      await process.close();
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await prepared.cleanup();
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    status = "failed";
    reason = "cleanup_failed";
  }

  const verificationEvidence = verification ?? Object.freeze({ verdict: "not_run", reason });
  try {
    await artifacts.writeVerification(verificationEvidence);
    await artifacts.writePatch(patch);
  } catch {
    status = "failed";
    reason = "artifact_write_failed";
  }
  try {
    await artifacts.writeResult(
      resultMarkdown(
        status,
        reason,
        prepared.task,
        input.budget.summary(),
        changedFiles,
        scopeCompliant,
        agent,
        verification,
      ),
    );
  } catch {
    status = "failed";
    reason = "artifact_write_failed";
  }
  try {
    await artifacts.trace.record({
      type: "run_completed",
      iteration: agent?.iterations ?? input.budget.iterationsUsed(),
      metadata: { status, reason, changedFiles, scopeCompliant },
    });
  } catch {
    status = "failed";
    reason = "trace_write_failed";
    try {
      await artifacts.writeResult(
        resultMarkdown(
          status,
          reason,
          prepared.task,
          input.budget.summary(),
          changedFiles,
          scopeCompliant,
          agent,
          verification,
        ),
      );
    } catch {
      status = "failed";
      reason = "artifact_write_failed";
    }
  }

  return Object.freeze({
    status,
    reason,
    runId: artifacts.runId,
    artifactDirectory: artifacts.runDirectory,
    agent,
    verification,
    usage: input.budget.summary(),
    changedFiles,
    scopeCompliant,
  });
}

async function prepare(input: RepairRunInput): Promise<PreparedRun | RepairRunResult> {
  try {
    const options =
      input.temporaryDirectory === undefined
        ? { repositoryPath: input.repositoryPath, taskPath: input.taskPath }
        : {
            repositoryPath: input.repositoryPath,
            taskPath: input.taskPath,
            temporaryDirectory: input.temporaryDirectory,
          };
    return await prepareRun(options);
  } catch (error: unknown) {
    const reason = preparationReason(error);
    return outcome(input.budget, reason === "runtime_failed" ? "failed" : "blocked", reason);
  }
}

function preparationReason(error: unknown): RepairRunReason {
  if (
    error instanceof TaskContractError ||
    error instanceof WorkspaceError ||
    error instanceof RunPreparationError
  ) {
    return error.code;
  }
  if (error instanceof PathPolicyConfigurationError) return "invalid_path_policy";
  return "runtime_failed";
}

function allowedVerificationCommands(
  task: TaskContract,
): readonly Readonly<{ executable: "node"; args: readonly string[] }>[] {
  return task.verification.map((command) => {
    if (command.executable !== "node") throw new UnsupportedVerificationCommandError();
    return Object.freeze({ executable: "node" as const, args: command.args });
  });
}

class UnsupportedVerificationCommandError extends Error {}

function normalizeDiff(
  result: ToolResult,
  maximumChangedFiles: number,
): Readonly<{ patch: string; changedFiles: number; scopeCompliant: boolean }> {
  try {
    const value: unknown = JSON.parse(result.content);
    if (!isRecord(value)) throw new Error("invalid diff");
    const patch = value["diff"];
    const changedFiles = value["filesChanged"];
    const scopeCompliant =
      !result.isError &&
      value["ok"] === true &&
      value["truncated"] === false &&
      typeof patch === "string" &&
      Number.isSafeInteger(changedFiles) &&
      typeof changedFiles === "number" &&
      changedFiles >= 0 &&
      changedFiles <= maximumChangedFiles;
    return Object.freeze({
      patch: typeof patch === "string" ? patch : "",
      changedFiles:
        typeof changedFiles === "number" && Number.isSafeInteger(changedFiles) ? changedFiles : 0,
      scopeCompliant,
    });
  } catch {
    return Object.freeze({ patch: "", changedFiles: 0, scopeCompliant: false });
  }
}

function finalOutcome(
  agent: AgentOutcome,
  verification: VerificationReport | null,
  scopeCompliant: boolean,
  hostCancelled: boolean,
): Readonly<{ status: RepairRunStatus; reason: RepairRunReason }> {
  if (hostCancelled) return Object.freeze({ status: "cancelled", reason: "cancelled" });
  if (agent.status === "cancelled")
    return Object.freeze({ status: "cancelled", reason: "cancelled" });
  if (agent.status === "blocked") return Object.freeze({ status: "blocked", reason: agent.reason });
  if (agent.status === "failed") return Object.freeze({ status: "failed", reason: agent.reason });
  if (verification === null)
    return Object.freeze({ status: "failed", reason: "verification_failed" });
  if (verification.verdict !== "passed") {
    const blocked = verification.checks.some(
      (check) =>
        check.status === "denied" ||
        check.status === "sandbox_unavailable" ||
        check.status === "cancelled",
    );
    return Object.freeze({
      status: blocked ? "blocked" : "failed",
      reason: blocked ? "verification_blocked" : "verification_failed",
    });
  }
  if (!scopeCompliant) return Object.freeze({ status: "failed", reason: "scope_violation" });
  return Object.freeze({ status: "succeeded", reason: "verified" });
}

function modelFailure(
  error: unknown,
): Readonly<{ status: RepairRunStatus; reason: RepairRunReason }> {
  if (error instanceof AnthropicModelError) {
    if (error.code === "cancelled")
      return Object.freeze({ status: "cancelled", reason: error.code });
    if (error.code === "authentication_failed" || error.code === "rate_limited") {
      return Object.freeze({ status: "blocked", reason: error.code });
    }
    return Object.freeze({ status: "failed", reason: error.code });
  }
  return Object.freeze({ status: "failed", reason: "runtime_failed" });
}

function outcome(
  budget: BudgetPort,
  status: RepairRunStatus,
  reason: RepairRunReason,
): RepairRunResult {
  return Object.freeze({
    status,
    reason,
    runId: null,
    artifactDirectory: null,
    agent: null,
    verification: null,
    usage: budget.summary(),
    changedFiles: 0,
    scopeCompliant: false,
  });
}

function resultMarkdown(
  status: RepairRunStatus,
  reason: RepairRunReason,
  task: TaskContract,
  usage: ResourceUsageSummary,
  changedFiles: number,
  scopeCompliant: boolean,
  agent: AgentOutcome | null,
  verification: VerificationReport | null,
): string {
  return [
    "# Repair result",
    "",
    `Outcome: ${status}`,
    `Reason: ${reason}`,
    `Task: ${JSON.stringify(task.title)}`,
    `Agent: ${agent === null ? "not_run" : `${agent.status} (${agent.reason})`}`,
    `Verification: ${verification?.verdict ?? "not_run"}`,
    `Verification checks: ${String(verification?.checks.length ?? 0)}`,
    `Changed files: ${String(changedFiles)}`,
    `Scope compliant: ${String(scopeCompliant)}`,
    `Iterations: ${String(usage.iterations)}`,
    `Input tokens: ${String(usage.totalInputTokens)}`,
    `Output tokens: ${String(usage.outputTokens)}`,
    `Estimated cost (USD): ${usage.estimatedCostUsd.toFixed(8)}`,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${JSON.stringify(criterion)}`),
    "",
    "Review changes.patch and verification.json before applying the candidate repair.",
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

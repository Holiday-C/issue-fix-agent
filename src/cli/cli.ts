import { parseArgs } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResourceBudget, RESOURCE_BUDGET_CEILINGS, type ModelPricing } from "../agent/budget.js";
import {
  AnthropicMessagesAdapter,
  type AnthropicModelOptions,
} from "../model/anthropic-messages-adapter.js";
import type { ModelPort } from "../model/types.js";
import { PathPolicyConfigurationError } from "../permissions/path-policy.js";
import { TaskContractError } from "../task/task-contract.js";
import type { TraceEvent } from "../trace/types.js";
import { WorkspaceError } from "../workspace/git-worktree.js";
import { loadTaskFile, prepareRun, RunPreparationError } from "./prepare-run.js";
import { runRepair, type RepairRunResult } from "./run-repair.js";
import {
  collectWizardPlan,
  createReadlinePrompt,
  defaultWizardDiscovery,
  serializeWizardTask,
  WizardInputError,
  type PromptPort,
  type WizardDiscoveryPort,
} from "./wizard.js";

const VERSION = "0.1.0";
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 50_000;
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_MAX_MODEL_TOKENS = 8_192;

const HELP = `Issue Fix Agent

Usage:
  issue-fix [options]
  issue-fix prepare --repo <path> --issue <task.yaml>
  issue-fix run --repo <path> --issue <task.yaml> --model <id> --pricing <in,out,cache-write,cache-read>

Commands:
  (no command)       Start the interactive repair wizard
  prepare            Validate a task and repository in an isolated worktree
  run                Run a verified candidate repair with Anthropic

Options:
  -h, --help                    Show this help message
  -v, --version                 Show the installed version
      --repo <path>             Target local Git repository
      --issue <path>            YAML task contract
      --model <id>              Anthropic model ID
      --pricing <rates>         USD per million tokens: input,output,cache-write,cache-read
      --max-model-tokens <n>    Output ceiling for each model request (default: 8192)
      --max-input-tokens <n>    Run input-token ceiling (default: 200000)
      --max-output-tokens <n>   Run output-token ceiling (default: 50000)
      --max-cost-usd <n>        Estimated run-cost ceiling (default: 5)

Environment:
  ANTHROPIC_AUTH_TOKEN          Bearer token for an Anthropic-compatible gateway
  ANTHROPIC_BASE_URL            Optional Anthropic-compatible gateway URL
  ANTHROPIC_API_KEY             Official Anthropic API key fallback
  ANTHROPIC_MODEL               Optional interactive model default
  ANTHROPIC_PRICING             Optional interactive pricing default

Exit codes:
  0 succeeded, 1 failed, 2 usage error, 3 blocked, 130 cancelled

The prepare command does not call a model or run task-configured commands.
`;

export type CliIo = Readonly<{
  stdout: Readonly<{ write(text: string): void }>;
  stderr: Readonly<{ write(text: string): void }>;
}>;

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export type CliDependencies = Readonly<{
  prepare: typeof prepareRun;
  loadTask: typeof loadTaskFile;
  run: typeof runRepair;
  createModel(options: AnthropicModelOptions): ModelPort;
  environment: CliEnvironment;
  wizard?: Readonly<{
    isInteractive(): boolean;
    createPrompt(): PromptPort;
    currentDirectory(): string;
    discovery: WizardDiscoveryPort;
  }>;
}>;

const defaultDependencies: CliDependencies = Object.freeze({
  prepare: prepareRun,
  loadTask: loadTaskFile,
  run: runRepair,
  createModel: (options) => new AnthropicMessagesAdapter(options),
  environment: process.env,
  wizard: Object.freeze({
    isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
    createPrompt: () => createReadlinePrompt(process.stdin, process.stderr),
    currentDirectory: () => process.cwd(),
    discovery: defaultWizardDiscovery,
  }),
});

export async function runCli(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        repo: { type: "string" },
        issue: { type: "string" },
        model: { type: "string" },
        pricing: { type: "string" },
        "max-model-tokens": { type: "string" },
        "max-input-tokens": { type: "string" },
        "max-output-tokens": { type: "string" },
        "max-cost-usd": { type: "string" },
      },
      strict: true,
    });
  } catch {
    io.stderr.write("error: invalid command-line arguments\n");
    return 2;
  }

  if (parsed.values["version"] === true) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values["help"] === true) {
    io.stdout.write(HELP);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    return runInteractiveRepair(io, dependencies, signal);
  }
  if (parsed.positionals.length !== 1) {
    io.stderr.write("error: unknown command\n");
    return 2;
  }

  if (parsed.positionals[0] === "prepare") {
    return runPrepare(parsed.values, io, dependencies);
  }
  if (parsed.positionals[0] === "run") {
    return runConfiguredRepair(parsed.values, io, dependencies, signal);
  }
  io.stderr.write("error: unknown command\n");
  return 2;
}

async function runPrepare(
  values: ReturnType<typeof parseArgs>["values"],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const repositoryPath = values["repo"];
  const taskPath = values["issue"];
  if (typeof repositoryPath !== "string" || typeof taskPath !== "string") {
    io.stderr.write("error: prepare requires --repo and --issue\n");
    return 2;
  }

  try {
    const prepared = await dependencies.prepare({ repositoryPath, taskPath });
    const report = Object.freeze({
      status: "prepared",
      taskTitle: prepared.task.title,
      taskPath: prepared.taskPath,
      repositoryRoot: prepared.repositoryRoot,
      worktreeRoot: prepared.worktreeRoot,
      allowedPaths: prepared.task.allowedPaths,
      verificationCommands: prepared.task.verification.length,
      limits: prepared.task.limits,
    });
    await prepared.cleanup();
    io.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    return 0;
  } catch (error: unknown) {
    io.stderr.write(
      `${JSON.stringify({ status: "blocked", reason: blockedReason(error) }, undefined, 2)}\n`,
    );
    return 1;
  }
}

async function runConfiguredRepair(
  values: ReturnType<typeof parseArgs>["values"],
  io: CliIo,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const repositoryPath = values["repo"];
  const taskPath = values["issue"];
  const modelId = values["model"];
  const pricing = parsePricing(values["pricing"]);
  if (
    typeof repositoryPath !== "string" ||
    typeof taskPath !== "string" ||
    typeof modelId !== "string" ||
    modelId.trim().length === 0 ||
    pricing === undefined
  ) {
    io.stderr.write("error: run requires --repo, --issue, --model, and four --pricing rates\n");
    return 2;
  }

  const maxModelTokens = positiveNumberOption(
    values["max-model-tokens"],
    DEFAULT_MAX_MODEL_TOKENS,
    64_000,
    true,
  );
  const maxInputTokens = positiveNumberOption(
    values["max-input-tokens"],
    DEFAULT_MAX_INPUT_TOKENS,
    RESOURCE_BUDGET_CEILINGS.maxInputTokens,
    true,
  );
  const maxOutputTokens = positiveNumberOption(
    values["max-output-tokens"],
    DEFAULT_MAX_OUTPUT_TOKENS,
    RESOURCE_BUDGET_CEILINGS.maxOutputTokens,
    true,
  );
  const maxCostUsd = positiveNumberOption(
    values["max-cost-usd"],
    DEFAULT_MAX_COST_USD,
    RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd,
    false,
  );
  if (
    maxModelTokens === undefined ||
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    maxCostUsd === undefined
  ) {
    io.stderr.write("error: invalid run budget option\n");
    return 2;
  }

  return executeRepair(
    {
      repositoryPath,
      taskPath,
      modelId,
      pricing,
      maxModelTokens,
      maxInputTokens,
      maxOutputTokens,
      maxCostUsd,
    },
    io,
    dependencies,
    signal,
  );
}

type RepairCommandConfiguration = Readonly<{
  repositoryPath: string;
  taskPath: string;
  modelId: string;
  pricing: ModelPricing;
  maxModelTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
}>;

async function runInteractiveRepair(
  io: CliIo,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const wizard = dependencies.wizard;
  if (wizard === undefined || !wizard.isInteractive()) {
    io.stderr.write("error: interactive terminal required; use `issue-fix run` for automation\n");
    return 2;
  }
  if (anthropicAuthentication(dependencies.environment) === undefined) {
    io.stderr.write("error: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required\n");
    return 3;
  }

  const prompt = wizard.createPrompt();
  let plan: Awaited<ReturnType<typeof collectWizardPlan>>;
  try {
    plan = await collectWizardPlan(prompt, wizard.discovery, {
      currentDirectory: wizard.currentDirectory(),
      ...(dependencies.environment["ANTHROPIC_MODEL"] === undefined
        ? {}
        : { model: dependencies.environment["ANTHROPIC_MODEL"] }),
      ...(dependencies.environment["ANTHROPIC_PRICING"] === undefined
        ? {}
        : { pricing: dependencies.environment["ANTHROPIC_PRICING"] }),
    });
  } catch (error: unknown) {
    if (error instanceof WizardInputError) {
      io.stderr.write(`error: ${error.message}\n`);
      return error.code === "cancelled" ? 130 : 2;
    }
    io.stderr.write("error: interactive setup failed\n");
    return 2;
  } finally {
    prompt.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "issue-fix-wizard-"));
  const taskPath = join(directory, "task.yaml");
  try {
    await writeFile(taskPath, serializeWizardTask(plan.task), { encoding: "utf8", flag: "wx" });
    return await executeRepair(
      {
        repositoryPath: plan.repositoryPath,
        taskPath,
        modelId: plan.model,
        pricing: plan.pricing,
        maxModelTokens: DEFAULT_MAX_MODEL_TOKENS,
        maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        maxCostUsd: plan.maxCostUsd,
      },
      io,
      dependencies,
      signal,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function executeRepair(
  configuration: RepairCommandConfiguration,
  io: CliIo,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const authentication = anthropicAuthentication(dependencies.environment);
  if (authentication === undefined) {
    io.stderr.write("error: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required\n");
    return 3;
  }

  try {
    const loaded = await dependencies.loadTask(configuration.taskPath);
    const maximumElapsed = loaded.task.limits.timeoutMinutes * 60_000;
    const budget = new ResourceBudget(
      {
        maxIterations: loaded.task.limits.maxIterations,
        maxElapsedMilliseconds: maximumElapsed,
        maxInputTokens: configuration.maxInputTokens,
        maxOutputTokens: configuration.maxOutputTokens,
        maxEstimatedCostUsd: configuration.maxCostUsd,
      },
      configuration.pricing,
    );
    const model = dependencies.createModel({
      ...authentication,
      model: configuration.modelId,
      maxTokens: configuration.maxModelTokens,
      timeoutMilliseconds: Math.min(maximumElapsed, 120_000),
    });
    const result = await dependencies.run({
      repositoryPath: configuration.repositoryPath,
      taskPath: loaded.taskPath,
      model,
      budget,
      ...(signal === undefined ? {} : { signal }),
      onProgress: (event) => renderProgress(event, io.stderr),
    });
    io.stdout.write(`${JSON.stringify(publicResult(result), undefined, 2)}\n`);
    return exitCode(result);
  } catch (error: unknown) {
    if (
      error instanceof TaskContractError ||
      error instanceof RunPreparationError ||
      error instanceof WorkspaceError
    ) {
      io.stderr.write(
        `${JSON.stringify({ status: "blocked", reason: error.code }, undefined, 2)}\n`,
      );
      return 3;
    }
    io.stderr.write("error: repair run failed unexpectedly\n");
    return 1;
  }
}

function anthropicAuthentication(
  environment: CliEnvironment,
): Readonly<{ apiKey?: string; authToken?: string; baseURL?: string }> | undefined {
  const authToken = environment["ANTHROPIC_AUTH_TOKEN"]?.trim();
  const apiKey = environment["ANTHROPIC_API_KEY"]?.trim();
  const baseURL = environment["ANTHROPIC_BASE_URL"]?.trim();
  const credential =
    authToken !== undefined && authToken.length > 0
      ? { authToken }
      : apiKey !== undefined && apiKey.length > 0
        ? { apiKey }
        : undefined;
  if (credential === undefined) return undefined;
  return Object.freeze({
    ...credential,
    ...(baseURL === undefined || baseURL.length === 0 ? {} : { baseURL }),
  });
}

function parsePricing(source: unknown): ModelPricing | undefined {
  if (typeof source !== "string") return undefined;
  const parts = source.split(",").map((value) => value.trim());
  if (parts.some((value) => value.length === 0)) return undefined;
  const values = parts.map(Number);
  if (
    values.length !== 4 ||
    values.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value > RESOURCE_BUDGET_CEILINGS.maxUsdPerMillionTokens,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    inputUsdPerMillionTokens: values[0]!,
    outputUsdPerMillionTokens: values[1]!,
    cacheCreationUsdPerMillionTokens: values[2]!,
    cacheReadUsdPerMillionTokens: values[3]!,
  });
}

function positiveNumberOption(
  source: unknown,
  fallback: number,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (source === undefined) return fallback;
  if (typeof source !== "string" || source.trim().length === 0) return undefined;
  const value = Number(source);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) return undefined;
  if (integer && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function renderProgress(event: TraceEvent, output: CliIo["stderr"]): void {
  if (event.type === "iteration_started") {
    output.write(`progress: iteration ${String(event.iteration)}\n`);
  } else if (event.type === "tool_completed") {
    output.write(
      `progress: tool ${safeProgressText(event.metadata?.["tool"])} ${event.metadata?.["isError"] === true ? "failed" : "completed"}\n`,
    );
  } else if (event.type === "verification_completed") {
    output.write(`progress: verification ${String(event.metadata?.["verdict"] ?? "unknown")}\n`);
  } else if (event.type === "run_completed") {
    output.write(`progress: run ${String(event.metadata?.["status"] ?? "unknown")}\n`);
  }
}

function safeProgressText(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return value.replaceAll(/[^\x20-\x7e]/gu, "?").slice(0, 100);
}

function publicResult(result: RepairRunResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: result.status,
    reason: result.reason,
    runId: result.runId,
    artifactDirectory: result.artifactDirectory,
    changedFiles: result.changedFiles,
    scopeCompliant: result.scopeCompliant,
    usage: result.usage,
  });
}

function exitCode(result: RepairRunResult): number {
  if (result.status === "succeeded") return 0;
  if (result.status === "blocked") return 3;
  if (result.status === "cancelled") return 130;
  return 1;
}

function blockedReason(error: unknown): string {
  if (
    error instanceof TaskContractError ||
    error instanceof WorkspaceError ||
    error instanceof RunPreparationError
  ) {
    return error.code;
  }
  if (error instanceof PathPolicyConfigurationError) return "invalid_path_policy";
  return "preparation_failed";
}

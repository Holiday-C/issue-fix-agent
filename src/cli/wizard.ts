import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { stringify } from "yaml";

import { RESOURCE_BUDGET_CEILINGS, type ModelPricing } from "../agent/budget.js";
import { parseTaskContract, type TaskContract } from "../task/task-contract.js";

const execFile = promisify(execFileCallback);

export interface PromptPort {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface WizardDiscoveryPort {
  resolveRepository(path: string): Promise<string>;
  suggestAllowedPaths(repositoryRoot: string): Promise<readonly string[]>;
  suggestVerificationArgs(repositoryRoot: string): Promise<readonly string[]>;
}

export type WizardDefaults = Readonly<{
  currentDirectory: string;
  model?: string;
  pricing?: string;
}>;

export type WizardPlan = Readonly<{
  repositoryPath: string;
  task: TaskContract;
  model: string;
  pricing: ModelPricing;
  maxCostUsd: number;
}>;

export class WizardInputError extends Error {
  public readonly code: "invalid_input" | "cancelled";

  public constructor(code: WizardInputError["code"], message: string) {
    super(message);
    this.name = "WizardInputError";
    this.code = code;
  }
}

export const defaultWizardDiscovery: WizardDiscoveryPort = Object.freeze({
  resolveRepository: detectRepository,
  suggestAllowedPaths,
  suggestVerificationArgs: () => Promise.resolve(Object.freeze(["--test"])),
});

export function createReadlinePrompt(input: Readable, output: Writable): PromptPort {
  const readline = createInterface({ input, output });
  return Object.freeze({
    question: (prompt: string): Promise<string> => readline.question(prompt),
    close: () => readline.close(),
  });
}

export async function collectWizardPlan(
  prompt: PromptPort,
  discovery: WizardDiscoveryPort,
  defaults: WizardDefaults,
): Promise<WizardPlan> {
  const requestedRepository = await questionWithDefault(
    prompt,
    "Repository path",
    defaults.currentDirectory,
  );
  const repositoryPath = await discovery.resolveRepository(requestedRepository);
  const suggestedPaths = await discovery.suggestAllowedPaths(repositoryPath);
  const suggestedArgs = await discovery.suggestVerificationArgs(repositoryPath);

  const goal = required(await prompt.question("What should the agent fix? "), "repair goal");
  const acceptanceCriteria = list(
    await prompt.question("Acceptance criteria (separate with semicolons): "),
    ";",
    "acceptance criteria",
  );
  const allowedPaths = list(
    await questionWithDefault(
      prompt,
      "Allowed write paths (comma-separated)",
      suggestedPaths.join(","),
    ),
    ",",
    "allowed paths",
  );
  const verificationArgs = words(
    await questionWithDefault(prompt, "Node verification arguments", suggestedArgs.join(" ")),
  );
  const limits = numericList(
    await questionWithDefault(prompt, "Limits: iterations,changed-files,minutes", "8,10,20"),
    3,
    "run limits",
  );
  const model = required(
    await questionWithDefault(prompt, "Provider model ID", defaults.model ?? ""),
    "model ID",
  );
  if (model.length > 200 || model.includes("\0")) {
    throw new WizardInputError("invalid_input", "model ID is invalid");
  }
  const pricingSource = await questionWithDefault(
    prompt,
    "Pricing: input,output,cache-write,cache-read USD per million tokens",
    defaults.pricing ?? "",
  );
  const pricing = pricingRates(pricingSource);
  const maxCostUsd = positiveNumber(
    await questionWithDefault(prompt, "Maximum estimated cost in USD", "5"),
    "maximum cost",
  );

  const task = createTask(goal, acceptanceCriteria, allowedPaths, verificationArgs, limits);
  const summary = JSON.stringify(
    {
      repositoryPath,
      title: task.title,
      acceptanceCriteria: task.acceptanceCriteria,
      allowedPaths: task.allowedPaths,
      verification: task.verification,
      limits: task.limits,
      model,
      pricing,
      maxCostUsd,
    },
    undefined,
    2,
  );
  const confirmation = (
    await prompt.question(`\nReview the proposed writes and commands:\n${summary}\nProceed? [y/N] `)
  )
    .trim()
    .toLocaleLowerCase("en-US");
  if (confirmation !== "y" && confirmation !== "yes") {
    throw new WizardInputError("cancelled", "Interactive repair was cancelled");
  }

  return Object.freeze({ repositoryPath, task, model, pricing, maxCostUsd });
}

export function serializeWizardTask(task: TaskContract): string {
  return stringify({
    title: task.title,
    description: task.description,
    acceptance_criteria: task.acceptanceCriteria,
    allowed_paths: task.allowedPaths,
    verification: task.verification,
    limits: {
      max_iterations: task.limits.maxIterations,
      max_changed_files: task.limits.maxChangedFiles,
      timeout_minutes: task.limits.timeoutMinutes,
    },
  });
}

async function detectRepository(path: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
    });
    return realpath(stdout.trim());
  } catch {
    throw new WizardInputError("invalid_input", "Repository path is not a Git repository");
  }
}

async function suggestAllowedPaths(repositoryRoot: string): Promise<readonly string[]> {
  const output: string[] = [];
  for (const name of ["app", "lib", "src", "test", "tests"]) {
    try {
      const metadata = await lstat(join(repositoryRoot, name));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) output.push(`${name}/**`);
    } catch {
      // Missing conventional source directories are normal.
    }
  }
  return Object.freeze(output);
}

async function questionWithDefault(
  prompt: PromptPort,
  label: string,
  fallback: string,
): Promise<string> {
  const suffix = fallback.length === 0 ? "" : ` [${safePromptDefault(fallback)}]`;
  const answer = (await prompt.question(`${label}${suffix}: `)).trim();
  return answer.length === 0 ? fallback : answer;
}

function safePromptDefault(value: string): string {
  return value.replaceAll(/[^\x20-\x7e]/gu, "?").slice(0, 200);
}

function required(source: string, label: string): string {
  const value = source.trim();
  if (value.length === 0) throw new WizardInputError("invalid_input", `${label} is required`);
  return value;
}

function list(source: string, separator: string, label: string): readonly string[] {
  const values = source
    .split(separator)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new WizardInputError("invalid_input", `${label} are required`);
  return Object.freeze(values);
}

function words(source: string): readonly string[] {
  const values = source
    .trim()
    .split(/\s+/u)
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new WizardInputError("invalid_input", "verification arguments are required");
  }
  if (values.some((value) => value.includes("\0"))) {
    throw new WizardInputError("invalid_input", "verification arguments are invalid");
  }
  return Object.freeze(values);
}

function numericList(source: string, count: number, label: string): readonly number[] {
  const values = source.split(",").map((value) => Number(value.trim()));
  if (
    values.length !== count ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new WizardInputError(
      "invalid_input",
      `${label} must contain ${String(count)} positive integers`,
    );
  }
  return Object.freeze(values);
}

function pricingRates(source: string): ModelPricing {
  const parts = source.split(",").map((value) => value.trim());
  const values = parts.map(Number);
  if (
    values.length !== 4 ||
    parts.some((value) => value.length === 0) ||
    values.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value > RESOURCE_BUDGET_CEILINGS.maxUsdPerMillionTokens,
    )
  ) {
    throw new WizardInputError("invalid_input", "pricing must contain four non-negative numbers");
  }
  return Object.freeze({
    inputUsdPerMillionTokens: values[0]!,
    outputUsdPerMillionTokens: values[1]!,
    cacheCreationUsdPerMillionTokens: values[2]!,
    cacheReadUsdPerMillionTokens: values[3]!,
  });
}

function positiveNumber(source: string, label: string): number {
  const value = Number(source);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > RESOURCE_BUDGET_CEILINGS.maxEstimatedCostUsd
  ) {
    throw new WizardInputError("invalid_input", `${label} must be positive`);
  }
  return value;
}

function createTask(
  goal: string,
  acceptanceCriteria: readonly string[],
  allowedPaths: readonly string[],
  verificationArgs: readonly string[],
  limits: readonly number[],
): TaskContract {
  return parseTaskContract(
    stringify({
      title: goal.split(/\r?\n/u)[0]!.slice(0, 200),
      description: goal,
      acceptance_criteria: acceptanceCriteria,
      allowed_paths: allowedPaths,
      verification: [{ executable: "node", args: verificationArgs }],
      limits: {
        max_iterations: limits[0],
        max_changed_files: limits[1],
        timeout_minutes: limits[2],
      },
    }),
  );
}

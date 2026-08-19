import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { CliDependencies, CliIo } from "../../src/cli/cli.js";
import { runCli } from "../../src/cli/cli.js";
import { loadTaskFile, prepareRun } from "../../src/cli/prepare-run.js";
import type { RepairRunResult } from "../../src/cli/run-repair.js";
import {
  collectWizardPlan,
  serializeWizardTask,
  type PromptPort,
  type WizardDiscoveryPort,
} from "../../src/cli/wizard.js";
import type { ModelPort } from "../../src/model/types.js";
import { parseTaskContract } from "../../src/task/task-contract.js";

describe("collectWizardPlan", () => {
  it("builds a validated task from concise prompts and safe suggestions", async () => {
    const prompt = new ScriptedPrompt([
      "",
      "Fix the greeting typo",
      "Greeting is correct; Existing behavior remains",
      "",
      "",
      "",
      "",
      "",
      "",
      "yes",
    ]);

    const plan = await collectWizardPlan(prompt, discovery, {
      currentDirectory: "/current",
      model: "claude-test",
      pricing: "1,2,3,4",
    });

    expect(plan).toMatchObject({
      repositoryPath: "/repository",
      model: "claude-test",
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        cacheCreationUsdPerMillionTokens: 3,
        cacheReadUsdPerMillionTokens: 4,
      },
      maxCostUsd: 5,
      task: {
        title: "Fix the greeting typo",
        acceptanceCriteria: ["Greeting is correct", "Existing behavior remains"],
        allowedPaths: ["src/**", "tests/**"],
        verification: [{ executable: "node", args: ["--test"] }],
        limits: { maxIterations: 8, maxChangedFiles: 10, timeoutMinutes: 20 },
      },
    });
    expect(parseTaskContract(serializeWizardTask(plan.task))).toEqual(plan.task);
    expect(prompt.questions.at(-1)).toContain("Review the proposed writes and commands");
  });

  it("requires explicit confirmation", async () => {
    const prompt = new ScriptedPrompt([
      "",
      "Fix it",
      "It works",
      "src/**",
      "--test",
      "8,10,20",
      "claude-test",
      "1,2,3,4",
      "5",
      "no",
    ]);

    await expect(
      collectWizardPlan(prompt, discovery, { currentDirectory: "/current" }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("interactive CLI", () => {
  it("uses the generated temporary task with the same repair runner", async () => {
    const prompt = new ScriptedPrompt([
      "",
      "Fix it",
      "It works",
      "src/**",
      "--test",
      "2,2,1",
      "claude-test",
      "1,2,3,4",
      "1",
      "yes",
    ]);
    let generatedTask = "";
    const output = captureIo();
    const dependencies: CliDependencies = {
      prepare: prepareRun,
      loadTask: loadTaskFile,
      run: (input) =>
        readFile(input.taskPath, "utf8").then((source) => {
          generatedTask = source;
          return successfulResult;
        }),
      createModel: () => unusedModel,
      environment: { ANTHROPIC_API_KEY: "test-key" },
      wizard: {
        isInteractive: () => true,
        createPrompt: () => prompt,
        currentDirectory: () => "/current",
        discovery,
      },
    };

    const exit = await runCli([], output.io, dependencies);

    expect(exit).toBe(0);
    expect(parseTaskContract(generatedTask)).toMatchObject({ title: "Fix it" });
    expect(parseJsonObject(output.stdout())).toMatchObject({ status: "succeeded" });
    expect(prompt.closed).toBe(true);
  });

  it("guides non-interactive callers to configured mode", async () => {
    const output = captureIo();
    const dependencies: CliDependencies = {
      prepare: prepareRun,
      loadTask: loadTaskFile,
      run: () => Promise.resolve(successfulResult),
      createModel: () => unusedModel,
      environment: {},
    };

    await expect(runCli([], output.io, dependencies)).resolves.toBe(2);
    expect(output.stderr()).toContain("interactive terminal required");
  });
});

class ScriptedPrompt implements PromptPort {
  public readonly questions: string[] = [];
  public closed = false;
  readonly #answers: string[];

  public constructor(answers: readonly string[]) {
    this.#answers = [...answers];
  }

  public question(question: string): Promise<string> {
    this.questions.push(question);
    const answer = this.#answers.shift();
    if (answer === undefined) return Promise.reject(new Error("No scripted answer available"));
    return Promise.resolve(answer);
  }

  public close(): void {
    this.closed = true;
  }
}

const discovery: WizardDiscoveryPort = Object.freeze({
  resolveRepository: () => Promise.resolve("/repository"),
  suggestAllowedPaths: () => Promise.resolve(Object.freeze(["src/**", "tests/**"])),
  suggestVerificationArgs: () => Promise.resolve(Object.freeze(["--test"])),
});

const unusedModel: ModelPort = Object.freeze({
  complete: () => Promise.reject(new Error("Wizard test model must not run")),
});

const successfulResult: RepairRunResult = Object.freeze({
  status: "succeeded",
  reason: "verified",
  runId: "run-test",
  artifactDirectory: "/repository/.issue-fix/runs/run-test",
  agent: null,
  verification: null,
  usage: Object.freeze({
    iterations: 0,
    elapsedMilliseconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalInputTokens: 0,
    estimatedCostUsd: 0,
    models: Object.freeze([]),
  }),
  changedFiles: 1,
  scopeCompliant: true,
});

function captureIo(): Readonly<{
  io: CliIo;
  stdout(): string;
  stderr(): string;
}> {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

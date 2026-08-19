import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "../../src/cli/cli.js";
import { prepareRun } from "../../src/cli/prepare-run.js";
import type { RepairRunResult, RepairRunStatus } from "../../src/cli/run-repair.js";
import type { AnthropicModelOptions } from "../../src/model/anthropic-messages-adapter.js";
import type { ModelPort } from "../../src/model/types.js";
import type { TaskContract } from "../../src/task/task-contract.js";
import { TaskContractError } from "../../src/task/task-contract.js";
import { createIsolatedWorktree } from "../../src/workspace/git-worktree.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("prepareRun", () => {
  it("composes a frozen isolated context and cleans it idempotently", async () => {
    const repository = await createRepository();
    const taskPath = await createTaskFile();
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-runs-");
    const prepared = await prepareRun({ repositoryPath: repository, taskPath, temporaryDirectory });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.repositoryRoot).toBe(await realpath(repository));
    expect(prepared.pathPolicy.worktreeRoot).toBe(prepared.worktreeRoot);
    await expect(
      prepared.pathPolicy.authorize({ operation: "write", path: "src/new.ts" }),
    ).resolves.toMatchObject({ allowed: true, relativePath: "src/new.ts" });

    await prepared.cleanup();
    await expect(prepared.cleanup()).resolves.toBeUndefined();
    await expect(access(prepared.worktreeRoot)).rejects.toThrow();
  });

  it("validates the task before creating a worktree", async () => {
    const repository = await createRepository();
    const directory = await createTemporaryDirectory("issue-fix-invalid-task-");
    const taskPath = join(directory, "task.yaml");
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-runs-");
    await writeFile(taskPath, "title: incomplete\n", "utf8");

    await expect(
      prepareRun({ repositoryPath: repository, taskPath, temporaryDirectory }),
    ).rejects.toBeInstanceOf(TaskContractError);
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });

  it("cleans the worktree when policy composition fails", async () => {
    const repository = await createRepository();
    const taskPath = await createTaskFile();
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-runs-");

    await expect(
      prepareRun(
        { repositoryPath: repository, taskPath, temporaryDirectory },
        {
          createWorktree: createIsolatedWorktree,
          createPathPolicy: () => Promise.reject(new Error("policy failed")),
        },
      ),
    ).rejects.toThrow("policy failed");
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });
});

describe("runCli", () => {
  it("preserves help and version behavior", async () => {
    const help = captureIo();
    const version = captureIo();

    await expect(runCli(["--help"], help.io)).resolves.toBe(0);
    await expect(runCli(["--version"], version.io)).resolves.toBe(0);
    expect(help.stdout()).toContain("issue-fix prepare");
    expect(version.stdout()).toBe("0.1.0\n");
  });

  it("prepares and cleans a deterministic repository through the CLI", async () => {
    const repository = await createRepository();
    const taskPath = await createTaskFile();
    const output = captureIo();

    await expect(
      runCli(["prepare", "--repo", repository, "--issue", taskPath], output.io),
    ).resolves.toBe(0);
    expect(output.stderr()).toBe("");

    const report = parseJsonObject(output.stdout());
    expect(report["status"]).toBe("prepared");
    expect(report["taskTitle"]).toBe("Prepare fixture");
    expect(typeof report["worktreeRoot"]).toBe("string");
    await expect(access(String(report["worktreeRoot"]))).rejects.toThrow();
    await expect(git(repository, ["status", "--short"])).resolves.toBe("");
  });

  it("returns a blocked report and non-zero status for invalid tasks", async () => {
    const repository = await createRepository();
    const directory = await createTemporaryDirectory("issue-fix-cli-task-");
    const taskPath = join(directory, "invalid.yaml");
    const output = captureIo();
    await writeFile(taskPath, "title: incomplete\n", "utf8");

    await expect(
      runCli(["prepare", "--repo", repository, "--issue", taskPath], output.io),
    ).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(parseJsonObject(output.stderr())).toMatchObject({
      status: "blocked",
      reason: "invalid_contract",
    });
  });

  it("returns a usage error when required paths are absent", async () => {
    const output = captureIo();

    await expect(runCli(["prepare"], output.io)).resolves.toBe(2);
    expect(output.stderr()).toContain("requires --repo and --issue");
  });

  it.each([
    ["succeeded", 0],
    ["failed", 1],
    ["blocked", 3],
    ["cancelled", 130],
  ] as const)("maps configured run status %s to exit code %s", async (status, expectedExit) => {
    const output = captureIo();
    const capturedModels: AnthropicModelOptions[] = [];
    const dependencies = configuredDependencies(status, capturedModels);

    const exit = await runCli(
      [
        "run",
        "--repo",
        "/repository",
        "--issue",
        "/task.yaml",
        "--model",
        "claude-test",
        "--pricing",
        "1,2,3,4",
      ],
      output.io,
      dependencies,
    );

    expect(exit).toBe(expectedExit);
    expect(parseJsonObject(output.stdout())).toMatchObject({
      status,
      artifactDirectory: "/repository/.issue-fix/runs/test-run",
      usage: { estimatedCostUsd: 0.001 },
    });
    expect(output.stderr()).toContain("progress: iteration 1");
    expect(output.stderr()).toContain("progress: tool ?[31munsafe completed");
    expect(output.stderr()).not.toContain("\u001b");
    expect(capturedModels).toMatchObject([
      { apiKey: "test-api-key", model: "claude-test", maxTokens: 8_192 },
    ]);
    expect(`${output.stdout()}${output.stderr()}`).not.toContain("test-api-key");
  });

  it("fails closed before model construction when the API key is absent", async () => {
    const output = captureIo();
    const dependencies = configuredDependencies("succeeded", [], false);

    const exit = await runCli(
      [
        "run",
        "--repo",
        "/repository",
        "--issue",
        "/task.yaml",
        "--model",
        "claude-test",
        "--pricing",
        "1,2,3,4",
      ],
      output.io,
      dependencies,
    );

    expect(exit).toBe(3);
    expect(output.stderr()).toContain("ANTHROPIC_API_KEY is required");
    expect(output.stdout()).toBe("");
  });
});

async function createRepository(): Promise<string> {
  const repository = await createTemporaryDirectory("issue-fix-cli-repository-");
  await git(repository, ["init", "--quiet"]);
  await writeFile(join(repository, "README.md"), "# Fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, [
    "-c",
    "user.name=Issue Fix Test",
    "-c",
    "user.email=issue-fix@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial fixture",
  ]);
  return repository;
}

async function createTaskFile(): Promise<string> {
  const directory = await createTemporaryDirectory("issue-fix-cli-task-");
  const taskPath = join(directory, "task.yaml");
  await writeFile(
    taskPath,
    `title: Prepare fixture
description: Validate safe preparation.
acceptance_criteria:
  - Preparation succeeds
allowed_paths:
  - src/**
verification:
  - executable: npm
    args: [test]
limits:
  max_iterations: 2
  max_changed_files: 2
  timeout_minutes: 5
`,
    "utf8",
  );
  return taskPath;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

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
    throw new Error("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function configuredDependencies(
  status: RepairRunStatus,
  capturedModels: AnthropicModelOptions[],
  withApiKey = true,
): CliDependencies {
  const environment: Record<string, string | undefined> = withApiKey
    ? { ANTHROPIC_API_KEY: "test-api-key" }
    : {};
  return {
    prepare: prepareRun,
    loadTask: () => Promise.resolve({ taskPath: "/task.yaml", task: configuredTask }),
    run: (input) => {
      input.onProgress?.({ type: "iteration_started", iteration: 1 });
      input.onProgress?.({
        type: "tool_completed",
        iteration: 1,
        metadata: { tool: "\u001b[31munsafe", isError: false },
      });
      return Promise.resolve(configuredResult(status));
    },
    createModel: (options) => {
      capturedModels.push(options);
      return unusedModel;
    },
    environment,
  };
}

function configuredResult(status: RepairRunStatus): RepairRunResult {
  const reason =
    status === "succeeded"
      ? "verified"
      : status === "blocked"
        ? "sandbox_unavailable"
        : status === "cancelled"
          ? "cancelled"
          : "runtime_failed";
  return Object.freeze({
    status,
    reason,
    runId: "test-run",
    artifactDirectory: "/repository/.issue-fix/runs/test-run",
    agent: null,
    verification: null,
    usage: Object.freeze({
      iterations: 1,
      elapsedMilliseconds: 10,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalInputTokens: 100,
      estimatedCostUsd: 0.001,
      models: Object.freeze(["claude-test"]),
    }),
    changedFiles: 1,
    scopeCompliant: status === "succeeded",
  });
}

const configuredTask: TaskContract = Object.freeze({
  title: "Configured run",
  description: "Run through the CLI.",
  acceptanceCriteria: Object.freeze(["Run completes"]),
  allowedPaths: Object.freeze(["src/**"]),
  verification: Object.freeze([
    Object.freeze({ executable: "node", args: Object.freeze(["--test"]) }),
  ]),
  limits: Object.freeze({ maxIterations: 2, maxChangedFiles: 2, timeoutMinutes: 1 }),
});

const unusedModel: ModelPort = Object.freeze({
  complete: () => Promise.reject(new Error("CLI test model must not run")),
});

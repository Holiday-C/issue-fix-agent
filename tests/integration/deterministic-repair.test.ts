import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ResourceBudget } from "../../src/agent/budget.js";
import type { AgentOutcome } from "../../src/agent/types.js";
import { runRepair, type RepairRunStatus } from "../../src/cli/run-repair.js";
import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolUseBlock,
} from "../../src/model/types.js";
import type { ProcessPort, ProcessResult } from "../../src/process/types.js";
import type { VerificationReport } from "../../src/verification/verification-runner.js";

const execFile = promisify(execFileCallback);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(testDirectory, "../../evals/fixtures/greeting");
const taskPath = join(testDirectory, "../../evals/tasks/fix-greeting.yaml");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform !== "darwin")("deterministic fixture repair", () => {
  it("repairs and verifies the fixture without changing its source checkout", async () => {
    const evidence = await runScenario("success", true);

    expect(evidence.outcome).toBe("succeeded");
    expect(evidence.agent).toMatchObject({ status: "completed", reason: "end_turn" });
    expect(evidence.verification).toMatchObject({
      verdict: "passed",
      checks: [{ status: "passed", exitCode: 0 }],
    });
    const readResult = parseToolResult(evidence.agent, "read");
    expect(readResult).toMatchObject({ ok: true });
    expect(readResult["content"]).toContain("Helo");
    expect(parseToolResult(evidence.agent, "denied-command")).toMatchObject({
      ok: false,
      error: { code: "command_denied", reason: "command_not_allowed" },
    });
    expect(parseToolResult(evidence.agent, "run-tests")).toMatchObject({
      ok: true,
      outcome: "completed",
      exitCode: 0,
    });
    expect(parseToolResult(evidence.agent, "patch")).toMatchObject({
      ok: true,
      filesChanged: 1,
      paths: ["src/greeting.js"],
    });
    expect(parseToolResult(evidence.agent, "diff")).toMatchObject({
      ok: true,
      filesChanged: 1,
      truncated: false,
    });
    expect(evidence.patch).toContain("+  return `Hello, ${name}!`;");
    expect(evidence.sourceStatus).toBe("");
    expect(evidence.sourceHeadAfter).toBe(evidence.sourceHeadBefore);
    expect(evidence.sourceImplementation).toContain("Helo");
    expect(evidence.artifactFiles).toEqual([
      "changes.patch",
      "result.md",
      "task.yaml",
      "trace.jsonl",
      "verification.json",
    ]);
    expect(evidence.trace).toContain('"type":"tool_completed"');
    expect(evidence.trace).toContain('"type":"run_completed"');
    expect(evidence.result).toContain("Verification: passed");
  }, 20_000);

  it("fails when the scripted model stops without repairing the fixture", async () => {
    const evidence = await runScenario("failure", false);

    expect(evidence.agent.status).toBe("completed");
    expect(evidence.verification).toMatchObject({
      verdict: "failed",
      checks: [{ status: "non_zero_exit" }],
    });
    expect(evidence.outcome).toBe("failed");
    expect(evidence.patch).toBe("");
    expect(evidence.result).toContain("Outcome: failed");
    expect(evidence.sourceStatus).toBe("");
  }, 20_000);

  it("verifies a valid candidate while preserving its budget-blocked outcome", async () => {
    const evidence = await runScenario("budget-stopped", true, {
      maxIterations: 5,
      omitEndTurn: true,
    });

    expect(evidence.outcome).toBe("blocked");
    expect(evidence.reason).toBe("iteration_budget_exhausted");
    expect(evidence.agent).toMatchObject({
      status: "blocked",
      reason: "iteration_budget_exhausted",
    });
    expect(evidence.verification).toMatchObject({
      verdict: "passed",
      checks: [{ status: "passed" }],
    });
    expect(evidence.patch).toContain("+  return `Hello, ${name}!`;");
  }, 20_000);
});

describe("repair runner failure handling", () => {
  it("returns blocked and cleans the worktree when the sandbox is unavailable", async () => {
    const setup = await createFixtureRepository();
    const model = new ScriptedModel([endTurn("Should not run")]);

    const run = await runRepair(
      {
        ...setup.input,
        runId: "sandbox-unavailable",
        model,
        budget: createBudget(),
      },
      { createProcess: () => Promise.reject(new Error("sandbox unavailable")) },
    );

    expect(run).toMatchObject({ status: "blocked", reason: "sandbox_unavailable", agent: null });
    expect(await git(setup.repository, ["status", "--short"])).toBe("");
    expect(model.calls).toBe(0);
  });

  it("never reports success when process cleanup fails", async () => {
    const setup = await createFixtureRepository();
    const model = new ScriptedModel([endTurn("Done")]);
    const process = new FailingCleanupProcess();

    const run = await runRepair(
      {
        ...setup.input,
        runId: "cleanup-failure",
        model,
        budget: createBudget(),
      },
      { createProcess: () => Promise.resolve(process) },
    );

    expect(run).toMatchObject({ status: "failed", reason: "cleanup_failed" });
    expect(await git(setup.repository, ["status", "--short"])).toBe("");
  });
});

type ScenarioEvidence = Readonly<{
  outcome: RepairRunStatus;
  reason: string;
  agent: AgentOutcome;
  verification: VerificationReport;
  patch: string;
  result: string;
  trace: string;
  artifactFiles: readonly string[];
  sourceHeadBefore: string;
  sourceHeadAfter: string;
  sourceStatus: string;
  sourceImplementation: string;
}>;

async function runScenario(
  runId: string,
  applyFix: boolean,
  options: Readonly<{ maxIterations?: number; omitEndTurn?: boolean }> = {},
): Promise<ScenarioEvidence> {
  const testRoot = await createTemporaryDirectory();
  const repository = join(testRoot, "repository");
  const worktrees = join(testRoot, "worktrees");
  await cp(fixtureDirectory, repository, { recursive: true });
  await mkdir(worktrees);
  await initializeRepository(repository);
  const sourceHeadBefore = await git(repository, ["rev-parse", "HEAD"]);
  const successResponses = successfulScript();
  const model = new ScriptedModel(
    applyFix
      ? options.omitEndTurn === true
        ? successResponses.slice(0, -1)
        : successResponses
      : [endTurn("No change needed")],
  );
  const run = await runRepair({
    repositoryPath: repository,
    taskPath,
    temporaryDirectory: worktrees,
    runId,
    model,
    budget: new ResourceBudget(
      {
        maxIterations: options.maxIterations ?? 8,
        maxElapsedMilliseconds: 60_000,
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxEstimatedCostUsd: 1,
      },
      zeroPricing,
    ),
  });
  if (run.agent === null || run.verification === null || run.artifactDirectory === null) {
    throw new Error(`Scenario did not produce complete evidence: ${run.reason}`);
  }
  const patch = await readFile(join(run.artifactDirectory, "changes.patch"), "utf8");
  const result = await readFile(join(run.artifactDirectory, "result.md"), "utf8");

  return Object.freeze({
    outcome: run.status,
    reason: run.reason,
    agent: run.agent,
    verification: run.verification,
    patch,
    result,
    trace: await readFile(join(run.artifactDirectory, "trace.jsonl"), "utf8"),
    artifactFiles: Object.freeze((await readdir(run.artifactDirectory)).sort()),
    sourceHeadBefore,
    sourceHeadAfter: await git(repository, ["rev-parse", "HEAD"]),
    sourceStatus: await git(repository, ["status", "--short"]),
    sourceImplementation: await readFile(join(repository, "src/greeting.js"), "utf8"),
  });
}

class ScriptedModel implements ModelPort {
  public calls = 0;
  readonly #responses: ModelResponse[];
  #index = 0;

  public constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  public async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const response = this.#responses[this.#index];
    if (response === undefined) throw new Error("Scripted model exhausted its responses");
    if (this.#index === 0) {
      const names = request.tools.map((tool) => tool.name).sort();
      if (!names.includes("read_file") || !names.includes("apply_patch")) {
        throw new Error("Scripted model did not receive the provider-neutral tools");
      }
    } else if (!request.messages.at(-1)?.content.some((block) => block.type === "tool_result")) {
      throw new Error("Scripted model did not receive the preceding tool result");
    }
    this.#index += 1;
    return Promise.resolve(response);
  }
}

class FailingCleanupProcess implements ProcessPort {
  public run(): Promise<ProcessResult> {
    return Promise.resolve({
      outcome: "completed",
      exitCode: 1,
      durationMilliseconds: 1,
      stdout: "",
      stderr: "fixture failed",
      stdoutTruncated: false,
      stderrTruncated: false,
      sandboxViolation: false,
    });
  }

  public close(): Promise<void> {
    return Promise.reject(new Error("cleanup failed"));
  }
}

function successfulScript(): readonly ModelResponse[] {
  return Object.freeze([
    useTool("read", "read_file", { path: "src/greeting.js" }),
    useTool("denied-command", "run_command", {
      executable: "node",
      args: ["--eval", "process.exit(0)"],
      cwd: ".",
    }),
    useTool("patch", "apply_patch", { patch: greetingPatch }),
    useTool("run-tests", "run_command", {
      executable: "node",
      args: ["--test", "test/greeting.test.js"],
      cwd: ".",
      timeoutMilliseconds: 10_000,
      maxOutputBytes: 8_192,
    }),
    useTool("diff", "git_diff", { maxBytes: 16 * 1024 }),
    endTurn("The scoped repair is complete."),
  ]);
}

function useTool(id: string, name: string, input: unknown): ModelResponse {
  const call: ToolUseBlock = Object.freeze({ type: "tool_use", id, name, input });
  return Object.freeze({
    message: Object.freeze({ role: "assistant", content: Object.freeze([call]) }),
    stopReason: "tool_use",
    toolCalls: Object.freeze([call]),
    model: "scripted-model",
    usage: emptyUsage,
  });
}

function endTurn(text: string): ModelResponse {
  return Object.freeze({
    message: Object.freeze({
      role: "assistant",
      content: Object.freeze([{ type: "text" as const, text }]),
    }),
    stopReason: "end_turn",
    toolCalls: Object.freeze([]),
    model: "scripted-model",
    usage: emptyUsage,
  });
}

function parseToolResult(
  outcome: AgentOutcome,
  toolUseId: string,
): Readonly<Record<string, unknown>> {
  for (const message of outcome.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolUseId === toolUseId) {
        return parseJsonObject(block.content);
      }
    }
  }
  throw new Error(`Missing tool result ${toolUseId}`);
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

async function initializeRepository(repository: string): Promise<void> {
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["add", "."]);
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
}

async function createFixtureRepository(): Promise<
  Readonly<{
    repository: string;
    input: Readonly<{ repositoryPath: string; taskPath: string; temporaryDirectory: string }>;
  }>
> {
  const testRoot = await createTemporaryDirectory();
  const repository = join(testRoot, "repository");
  const worktrees = join(testRoot, "worktrees");
  await cp(fixtureDirectory, repository, { recursive: true });
  await mkdir(worktrees);
  await initializeRepository(repository);
  return Object.freeze({
    repository,
    input: Object.freeze({ repositoryPath: repository, taskPath, temporaryDirectory: worktrees }),
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "issue-fix-eval-"));
  temporaryDirectories.push(path);
  return path;
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

const greetingPatch = `diff --git a/src/greeting.js b/src/greeting.js
--- a/src/greeting.js
+++ b/src/greeting.js
@@ -1,3 +1,3 @@
 export function greet(name) {
-  return \`Helo, \${name}!\`;
+  return \`Hello, \${name}!\`;
 }
`;

const emptyUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

const zeroPricing = Object.freeze({
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  cacheCreationUsdPerMillionTokens: 0,
  cacheReadUsdPerMillionTokens: 0,
});

function createBudget(): ResourceBudget {
  return new ResourceBudget(
    {
      maxIterations: 8,
      maxElapsedMilliseconds: 60_000,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxEstimatedCostUsd: 1,
    },
    zeroPricing,
  );
}

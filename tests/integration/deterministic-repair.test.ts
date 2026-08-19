import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import { IterationBudget } from "../../src/agent/budget.js";
import type { AgentOutcome } from "../../src/agent/types.js";
import { prepareRun } from "../../src/cli/prepare-run.js";
import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolUseBlock,
} from "../../src/model/types.js";
import { CommandPolicy } from "../../src/permissions/command-policy.js";
import { SandboxRuntimeAdapter } from "../../src/process/sandbox-runtime-adapter.js";
import type { TaskContract } from "../../src/task/task-contract.js";
import { createCommandTool } from "../../src/tools/command-tool.js";
import { createRepositoryDiscoveryTools } from "../../src/tools/repository-discovery.js";
import { createRepositoryMutationTools } from "../../src/tools/repository-mutation.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ToolResult } from "../../src/tools/types.js";
import { createRunArtifacts } from "../../src/trace/run-artifacts.js";
import type { VerificationReport } from "../../src/verification/verification-runner.js";
import { runVerification } from "../../src/verification/verification-runner.js";

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
});

type ScenarioEvidence = Readonly<{
  outcome: "succeeded" | "failed" | "blocked";
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

async function runScenario(runId: string, applyFix: boolean): Promise<ScenarioEvidence> {
  const testRoot = await createTemporaryDirectory();
  const repository = join(testRoot, "repository");
  const worktrees = join(testRoot, "worktrees");
  await cp(fixtureDirectory, repository, { recursive: true });
  await mkdir(worktrees);
  await initializeRepository(repository);
  const sourceHeadBefore = await git(repository, ["rev-parse", "HEAD"]);
  const prepared = await prepareRun({
    repositoryPath: repository,
    taskPath,
    temporaryDirectory: worktrees,
  });
  const artifacts = await createRunArtifacts(prepared.repositoryRoot, { runId });
  await artifacts.writeTask(prepared.task);

  const commandPolicy = new CommandPolicy(
    prepared.pathPolicy,
    allowedVerificationCommands(prepared.task),
  );
  const process = await SandboxRuntimeAdapter.create(prepared.worktreeRoot);
  let agent: AgentOutcome;
  let verification: VerificationReport;
  let diffResult: ToolResult;

  try {
    const tools = new ToolRegistry([
      ...createRepositoryDiscoveryTools(prepared.pathPolicy),
      ...createRepositoryMutationTools(prepared.pathPolicy),
      createCommandTool(commandPolicy, process),
    ]);
    const model = new ScriptedModel(applyFix ? successfulScript() : [endTurn("No change needed")]);
    agent = await runAgentLoop(
      {
        system: "Repair only the scoped fixture and use the provided tools.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prepared.task.description }],
          },
        ],
      },
      {
        model,
        tools,
        budget: new IterationBudget(prepared.task.limits.maxIterations),
        trace: artifacts.trace,
      },
    );
    verification = await runVerification({
      task: prepared.task,
      worktreeRoot: prepared.worktreeRoot,
      commands: commandPolicy,
      process,
    });
    diffResult = await tools.execute({
      type: "tool_use",
      id: "final-diff",
      name: "git_diff",
      input: { maxBytes: 32 * 1024 },
    });
  } finally {
    await process.close();
  }

  const diff = parseJsonObject(diffResult.content);
  const patch = typeof diff["diff"] === "string" ? diff["diff"] : "";
  const scopeCompliant =
    !diffResult.isError &&
    diff["truncated"] === false &&
    typeof diff["filesChanged"] === "number" &&
    diff["filesChanged"] <= prepared.task.limits.maxChangedFiles;
  const outcome = finalOutcome(agent, verification, scopeCompliant);
  const result = [
    `# Deterministic repair`,
    ``,
    `Outcome: ${outcome}`,
    `Agent: ${agent.status} (${agent.reason})`,
    `Verification: ${verification.verdict}`,
    `Scope compliant: ${String(scopeCompliant)}`,
    ``,
  ].join("\n");
  await artifacts.writeVerification(verification);
  await artifacts.writePatch(patch);
  await artifacts.writeResult(result);
  await prepared.cleanup();

  return Object.freeze({
    outcome,
    agent,
    verification,
    patch,
    result,
    trace: await readFile(join(artifacts.runDirectory, "trace.jsonl"), "utf8"),
    artifactFiles: Object.freeze((await readdir(artifacts.runDirectory)).sort()),
    sourceHeadBefore,
    sourceHeadAfter: await git(repository, ["rev-parse", "HEAD"]),
    sourceStatus: await git(repository, ["status", "--short"]),
    sourceImplementation: await readFile(join(repository, "src/greeting.js"), "utf8"),
  });
}

class ScriptedModel implements ModelPort {
  readonly #responses: ModelResponse[];
  #index = 0;

  public constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  public async complete(request: ModelRequest): Promise<ModelResponse> {
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
  });
}

function finalOutcome(
  agent: AgentOutcome,
  verification: VerificationReport,
  scopeCompliant: boolean,
): ScenarioEvidence["outcome"] {
  if (agent.status === "blocked") return "blocked";
  return agent.status === "completed" && verification.verdict === "passed" && scopeCompliant
    ? "succeeded"
    : "failed";
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

function allowedVerificationCommands(
  task: TaskContract,
): readonly Readonly<{ executable: "node"; args: readonly string[] }>[] {
  return task.verification.map((command) => {
    if (command.executable !== "node") {
      throw new Error("The deterministic fixture requires Node verification commands");
    }
    return Object.freeze({ executable: "node" as const, args: command.args });
  });
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

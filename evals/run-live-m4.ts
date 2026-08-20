import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { CliIo } from "../src/cli/cli.js";
import { runCli } from "../src/cli/cli.js";
import {
  createEvaluationReport,
  renderEvaluationReportMarkdown,
  serializeEvaluationReport,
} from "./evaluation-report.js";
import { loadEvaluationManifest } from "./evaluation-manifest.js";
import { createEvaluationResult, type EvaluationResult } from "./evaluation-results.js";
import {
  countToolErrors,
  credentialValues,
  extractPatchPaths,
  isRegressionFree,
  LiveM4ConfigurationError,
  loadLiveM4Config,
  parseLiveM4CliResult,
  parseLiveM4Verification,
} from "./live-m4.js";

const execFile = promisify(execFileCallback);

async function main(): Promise<number> {
  const config = loadLiveM4Config(process.env, process.cwd());
  const manifest = await loadEvaluationManifest(resolve("evals/manifest.yaml"));
  if (manifest.tasks.length !== 10) throw new Error("M4 requires exactly ten manifest tasks");

  await mkdir(config.outputRoot, { recursive: true });
  const outputDirectory = await mkdtemp(join(config.outputRoot, "m4-live-"));
  const secrets = credentialValues(process.env);
  const results: EvaluationResult[] = [];
  const runs: Readonly<Record<string, unknown>>[] = [];
  let totalCostUsd = 0;

  for (const [index, task] of manifest.tasks.entries()) {
    if (totalCostUsd >= config.maxTotalCostUsd) break;
    const runDirectory = join(outputDirectory, `run-${String(index + 1).padStart(2, "0")}`);
    const repository = join(runDirectory, "repository");
    await mkdir(runDirectory);
    await cp(task.fixturePath, repository, { recursive: true });
    await initializeRepository(repository);
    const headBefore = await git(repository, ["rev-parse", "HEAD"]);
    const captured = captureIo();
    const remainingCostUsd = Math.min(
      config.maxCostUsdPerRun,
      roundCost(config.maxTotalCostUsd - totalCostUsd),
    );
    const exitCode = await runCli(
      [
        "run",
        "--repo",
        repository,
        "--issue",
        task.taskPath,
        "--model",
        config.model,
        "--pricing",
        config.pricing,
        "--max-cost-usd",
        String(remainingCostUsd),
      ],
      captured.io,
    );
    const cliResult = parseLiveM4CliResult(captured.stdout());
    if (cliResult.artifactDirectory === null) {
      throw new Error(`Task ${task.id} did not produce evaluation artifacts`);
    }

    const artifactDirectory = await canonicalArtifactDirectory(
      repository,
      cliResult.artifactDirectory,
    );
    const verification = parseLiveM4Verification(
      await readFile(join(artifactDirectory, "verification.json"), "utf8"),
    );
    const trace = await readFile(join(artifactDirectory, "trace.jsonl"), "utf8");
    const patch = await readFile(join(artifactDirectory, "changes.patch"), "utf8");
    const consoleSafe = secretAbsent(`${captured.stdout()}\n${captured.stderr()}`, secrets);
    const artifactSafe = await artifactsAreCredentialSafe(artifactDirectory, secrets);
    const credentialSafe = consoleSafe && artifactSafe;
    const sourceClean =
      (await git(repository, ["status", "--short"])) === "" &&
      (await git(repository, ["rev-parse", "HEAD"])) === headBefore;
    const patchPaths = extractPatchPaths(patch);
    const expectedPaths = [...task.expectedChangedPaths].sort((left, right) =>
      left.localeCompare(right),
    );
    const negativeFixture = task.expectedFailureChecks.length > 0;
    const expectedPathMatch = negativeFixture
      ? patchPaths.every((path) => expectedPaths.includes(path))
      : equalPaths(patchPaths, expectedPaths);
    const regressionFree = isRegressionFree(
      verification,
      task.contract.verification.length,
      task.expectedFailureChecks,
    );
    const toolErrors = countToolErrors(trace);
    const evaluation = createEvaluationResult(
      task.id,
      { ...cliResult, verification },
      { regressionFree, toolErrors },
    );
    results.push(evaluation);
    totalCostUsd = roundCost(totalCostUsd + evaluation.estimatedCostUsd);
    runs.push(
      Object.freeze({
        index: index + 1,
        taskId: task.id,
        exitCode,
        status: evaluation.status,
        failure: evaluation.failure,
        artifactDirectory,
        sourceClean,
        credentialSafe,
        expectedPathMatch,
        patchPaths,
        regressionFree,
        scopeCompliant: evaluation.scopeCompliant,
        costUsd: evaluation.estimatedCostUsd,
      }),
    );
    process.stdout.write(
      `M4 live evaluation ${String(index + 1)}/10 ${task.id}: ${evaluation.status}\n`,
    );

    if (!credentialSafe || !sourceClean || totalCostUsd > config.maxTotalCostUsd) break;
  }

  const report = createEvaluationReport(`m4-${config.protocol}-${config.model}`, results, {
    secretPatterns: secrets,
  });
  const allRunsSafe =
    runs.length === 10 &&
    runs.every(
      (run) =>
        run["sourceClean"] === true &&
        run["credentialSafe"] === true &&
        run["expectedPathMatch"] === true,
    );
  const complete =
    report.summary.totalTasks === 10 &&
    report.summary.resolvedTasks >= 7 &&
    report.summary.regressionFreeTasks === 10 &&
    report.summary.scopeCompliantTasks === 10 &&
    totalCostUsd <= config.maxTotalCostUsd &&
    allRunsSafe;
  const metadata = Object.freeze({
    version: 1,
    complete,
    protocol: config.protocol,
    model: config.model,
    baseURL: config.baseURL ?? null,
    thinkingMode: config.thinkingMode,
    pricing: config.pricing,
    maxCostUsdPerRun: config.maxCostUsdPerRun,
    maxTotalCostUsd: config.maxTotalCostUsd,
    totalCostUsd,
    runs: Object.freeze(runs),
  });
  const reportJson = serializeEvaluationReport(report);
  const reportMarkdown = renderEvaluationReportMarkdown(report);
  const metadataJson = `${JSON.stringify(metadata, undefined, 2)}\n`;
  if (!secretAbsent(`${reportJson}\n${reportMarkdown}\n${metadataJson}`, secrets)) {
    throw new Error("Credential disclosure detected in M4 report");
  }

  await writeFile(join(outputDirectory, "evaluation.json"), reportJson, "utf8");
  await writeFile(join(outputDirectory, "evaluation.md"), reportMarkdown, "utf8");
  await writeFile(join(outputDirectory, "metadata.json"), metadataJson, "utf8");
  process.stdout.write(`Report: ${outputDirectory}\n`);
  return complete ? 0 : 1;
}

async function initializeRepository(repository: string): Promise<void> {
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["add", "."]);
  await git(repository, [
    "-c",
    "user.name=Issue Fix Live Eval",
    "-c",
    "user.email=issue-fix@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial fixture",
  ]);
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    },
  });
  return stdout.trim();
}

async function artifactsAreCredentialSafe(
  artifactDirectory: string,
  secrets: readonly string[],
): Promise<boolean> {
  const sources = await Promise.all(
    ["task.yaml", "trace.jsonl", "result.md", "verification.json", "changes.patch"].map((name) =>
      readFile(join(artifactDirectory, name), "utf8"),
    ),
  );
  return sources.every((source) => secretAbsent(source, secrets));
}

async function canonicalArtifactDirectory(repository: string, candidate: string): Promise<string> {
  const artifactRoot = await realpath(join(repository, ".issue-fix", "runs"));
  const canonical = await realpath(candidate);
  const pathFromRoot = relative(artifactRoot, canonical);
  if (
    !(await stat(canonical)).isDirectory() ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Artifact directory escaped the fixture repository");
  }
  return canonical;
}

function secretAbsent(source: string, secrets: readonly string[]): boolean {
  return secrets.every((secret) => !source.includes(secret));
}

function equalPaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function captureIo(): Readonly<{
  io: CliIo;
  stdout(): string;
  stderr(): string;
}> {
  let stdout = "";
  let stderr = "";
  return Object.freeze({
    io: Object.freeze({
      stdout: Object.freeze({ write: (text: string) => (stdout += text) }),
      stderr: Object.freeze({ write: (text: string) => (stderr += text) }),
    }),
    stdout: () => stdout,
    stderr: () => stderr,
  });
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof LiveM4ConfigurationError ? error.message : "M4 live evaluation failed"}\n`,
    );
    process.exitCode = 1;
  });

import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { CliIo } from "../src/cli/cli.js";
import { runCli } from "../src/cli/cli.js";
import { LiveM3ConfigurationError, loadLiveM3Config } from "./live-m3-config.js";

const execFile = promisify(execFileCallback);
const REQUIRED_CONSECUTIVE_SUCCESSES = 3;

async function main(): Promise<number> {
  const config = loadLiveM3Config(process.env, process.cwd());
  await mkdir(config.outputRoot, { recursive: true });
  const outputDirectory = await mkdtemp(join(config.outputRoot, "m3-live-"));
  const taskPath = resolve("evals/tasks/fix-greeting.yaml");
  const fixturePath = resolve("evals/fixtures/greeting");
  const summaries: Readonly<Record<string, unknown>>[] = [];

  for (let index = 1; index <= REQUIRED_CONSECUTIVE_SUCCESSES; index += 1) {
    const runDirectory = join(outputDirectory, `run-${String(index)}`);
    const repository = join(runDirectory, "repository");
    await mkdir(runDirectory);
    await cp(fixturePath, repository, { recursive: true });
    await initializeRepository(repository);
    const headBefore = await git(repository, ["rev-parse", "HEAD"]);
    const captured = captureIo();
    const exitCode = await runCli(
      [
        "run",
        "--repo",
        repository,
        "--issue",
        taskPath,
        "--model",
        config.model,
        "--pricing",
        config.pricing,
        "--max-cost-usd",
        String(config.maxCostUsd),
      ],
      captured.io,
    );
    const result = parseCliResult(captured.stdout());
    const artifactDirectory = result["artifactDirectory"];
    let credentialSafe = true;
    if (typeof artifactDirectory === "string") {
      try {
        await assertSecretAbsent(artifactDirectory, captured.stdout(), captured.stderr());
      } catch {
        credentialSafe = false;
      }
    }
    const sourceClean =
      (await git(repository, ["status", "--short"])) === "" &&
      (await git(repository, ["rev-parse", "HEAD"])) === headBefore;
    const succeeded =
      exitCode === 0 &&
      result["status"] === "succeeded" &&
      typeof artifactDirectory === "string" &&
      sourceClean &&
      credentialSafe;
    const summary = Object.freeze({
      index,
      succeeded,
      exitCode,
      status: result["status"],
      reason: credentialSafe ? result["reason"] : "credential_evidence_failed",
      artifactDirectory,
      usage: result["usage"],
      sourceClean,
      credentialSafe,
    });
    summaries.push(summary);
    await writeFile(
      join(runDirectory, "console.json"),
      `${JSON.stringify({ stdout: captured.stdout(), stderr: captured.stderr() }, undefined, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `M3 live evaluation ${String(index)}/${String(REQUIRED_CONSECUTIVE_SUCCESSES)}: ${succeeded ? "succeeded" : "failed"}\n`,
    );
    if (!succeeded) break;
  }

  const complete =
    summaries.length === REQUIRED_CONSECUTIVE_SUCCESSES &&
    summaries.every((summary) => summary["succeeded"] === true);
  const report = Object.freeze({
    complete,
    model: config.model,
    baseURL: config.baseURL ?? null,
    thinkingMode: config.thinkingMode,
    pricing: config.pricing,
    maxCostUsdPerRun: config.maxCostUsd,
    runs: Object.freeze(summaries),
  });
  const reportPath = join(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`, "utf8");
  process.stdout.write(`Report: ${reportPath}\n`);
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

async function assertSecretAbsent(
  artifactDirectory: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  const secrets = [process.env["ANTHROPIC_AUTH_TOKEN"], process.env["ANTHROPIC_API_KEY"]].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (secrets.length === 0) return;
  const sources = [stdout, stderr];
  for (const name of [
    "task.yaml",
    "trace.jsonl",
    "result.md",
    "verification.json",
    "changes.patch",
  ]) {
    sources.push(await readFile(join(artifactDirectory, name), "utf8"));
  }
  if (sources.some((source) => secrets.some((secret) => source.includes(secret)))) {
    throw new Error("Credential disclosure detected in live evaluation evidence");
  }
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

function parseCliResult(source: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Readonly<Record<string, unknown>>;
    }
  } catch {
    // Preserve a structured failed evaluation when CLI output is malformed.
  }
  return Object.freeze({ status: "failed", reason: "invalid_cli_output" });
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof LiveM3ConfigurationError ? error.message : "M3 live evaluation failed"}\n`,
    );
    process.exitCode = 1;
  });

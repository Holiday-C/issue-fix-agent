import { parseArgs } from "node:util";

import { PathPolicyConfigurationError } from "../permissions/path-policy.js";
import { TaskContractError } from "../task/task-contract.js";
import { WorkspaceError } from "../workspace/git-worktree.js";
import { prepareRun, RunPreparationError } from "./prepare-run.js";

const VERSION = "0.1.0";

const HELP = `Issue Fix Agent

Usage:
  issue-fix [options]
  issue-fix prepare --repo <path> --issue <task.yaml>

Commands:
  prepare            Validate a task and repository in an isolated worktree

Options:
  -h, --help         Show this help message
  -v, --version      Show the installed version
      --repo <path>  Target local Git repository
      --issue <path> YAML task contract

The prepare command does not call a model or run task-configured commands.
`;

export type CliIo = Readonly<{
  stdout: Readonly<{ write(text: string): void }>;
  stderr: Readonly<{ write(text: string): void }>;
}>;

export type CliDependencies = Readonly<{
  prepare: typeof prepareRun;
}>;

const defaultDependencies: CliDependencies = Object.freeze({ prepare: prepareRun });

export async function runCli(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = defaultDependencies,
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

  if (parsed.values["help"] === true || parsed.positionals.length === 0) {
    io.stdout.write(HELP);
    return 0;
  }

  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "prepare") {
    io.stderr.write("error: unknown command\n");
    return 2;
  }

  const repositoryPath = parsed.values["repo"];
  const taskPath = parsed.values["issue"];
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

function blockedReason(error: unknown): string {
  if (
    error instanceof TaskContractError ||
    error instanceof WorkspaceError ||
    error instanceof RunPreparationError
  ) {
    return error.code;
  }
  if (error instanceof PathPolicyConfigurationError) {
    return "invalid_path_policy";
  }
  return "preparation_failed";
}

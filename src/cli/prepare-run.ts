import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { PathPolicy } from "../permissions/path-policy.js";
import {
  MAX_TASK_SOURCE_BYTES,
  parseTaskContract,
  TaskContractError,
  type TaskContract,
} from "../task/task-contract.js";
import {
  createIsolatedWorktree,
  type CreateIsolatedWorktreeOptions,
} from "../workspace/git-worktree.js";

export type RunPreparationErrorCode = "invalid_task_path" | "invalid_task_file";

export class RunPreparationError extends Error {
  public readonly code: RunPreparationErrorCode;

  public constructor(code: RunPreparationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunPreparationError";
    this.code = code;
  }
}

export type PrepareRunInput = Readonly<{
  repositoryPath: string;
  taskPath: string;
  temporaryDirectory?: string;
}>;

export type PreparedRun = Readonly<{
  taskPath: string;
  task: TaskContract;
  repositoryRoot: string;
  worktreeRoot: string;
  pathPolicy: PathPolicy;
  cleanup(): Promise<void>;
}>;

export type PrepareRunDependencies = Readonly<{
  createWorktree: typeof createIsolatedWorktree;
  createPathPolicy(worktreeRoot: string, allowedPaths: readonly string[]): Promise<PathPolicy>;
}>;

const defaultDependencies: PrepareRunDependencies = Object.freeze({
  createWorktree: createIsolatedWorktree,
  createPathPolicy: (worktreeRoot, allowedPaths) => PathPolicy.create(worktreeRoot, allowedPaths),
});

export async function prepareRun(
  input: PrepareRunInput,
  dependencies: PrepareRunDependencies = defaultDependencies,
): Promise<PreparedRun> {
  const { taskPath, task } = await loadTask(input.taskPath);
  const worktreeOptions: CreateIsolatedWorktreeOptions =
    input.temporaryDirectory === undefined ? {} : { temporaryDirectory: input.temporaryDirectory };
  const worktree = await dependencies.createWorktree(input.repositoryPath, worktreeOptions);

  try {
    const pathPolicy = await dependencies.createPathPolicy(
      worktree.worktreeRoot,
      task.allowedPaths,
    );

    return Object.freeze({
      taskPath,
      task,
      repositoryRoot: worktree.repositoryRoot,
      worktreeRoot: worktree.worktreeRoot,
      pathPolicy,
      cleanup: worktree.cleanup,
    });
  } catch (error: unknown) {
    await worktree.cleanup();
    throw error;
  }
}

async function loadTask(
  requestedPath: string,
): Promise<Readonly<{ taskPath: string; task: TaskContract }>> {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.trim().length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw new RunPreparationError("invalid_task_path", "Task path must be a non-empty string");
  }

  let taskPath: string;
  try {
    taskPath = await realpath(resolve(requestedPath));
  } catch (error: unknown) {
    throw new RunPreparationError("invalid_task_path", "Task path cannot be resolved", {
      cause: error,
    });
  }

  try {
    const metadata = await stat(taskPath);
    if (!metadata.isFile()) {
      throw new RunPreparationError("invalid_task_file", "Task path must reference a file");
    }
    if (metadata.size > MAX_TASK_SOURCE_BYTES) {
      throw new RunPreparationError("invalid_task_file", "Task file exceeds the size limit");
    }
    const source = await readFile(taskPath, "utf8");
    return Object.freeze({ taskPath, task: parseTaskContract(source) });
  } catch (error: unknown) {
    if (error instanceof RunPreparationError || error instanceof TaskContractError) {
      throw error;
    }
    throw new RunPreparationError("invalid_task_file", "Task file cannot be read", {
      cause: error,
    });
  }
}

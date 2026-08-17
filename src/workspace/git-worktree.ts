import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GIT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const GIT_TIMEOUT_MILLISECONDS = 15_000;

export type WorkspaceErrorCode =
  | "invalid_path"
  | "not_git_repository"
  | "invalid_repository"
  | "worktree_creation_failed"
  | "worktree_cleanup_failed";

export class WorkspaceError extends Error {
  public readonly code: WorkspaceErrorCode;

  public constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export type IsolatedWorktree = Readonly<{
  repositoryRoot: string;
  worktreeRoot: string;
  headSha: string;
  cleanup(): Promise<void>;
}>;

export type CreateIsolatedWorktreeOptions = Readonly<{
  temporaryDirectory?: string;
}>;

export async function createIsolatedWorktree(
  repositoryPath: string,
  options: CreateIsolatedWorktreeOptions = {},
): Promise<IsolatedWorktree> {
  const requestedRepository = await canonicalDirectory(repositoryPath);
  const repositoryRoot = await discoverRepositoryRoot(requestedRepository);
  const headSha = await resolveHead(repositoryRoot);
  const temporaryDirectory = await canonicalDirectory(options.temporaryDirectory ?? tmpdir());
  const runDirectory = await mkdtemp(join(temporaryDirectory, "issue-fix-"));
  const worktreeRoot = join(runDirectory, "worktree");

  try {
    await runGit(
      ["-C", repositoryRoot, "worktree", "add", "--detach", worktreeRoot, headSha],
      "worktree_creation_failed",
    );
  } catch (error: unknown) {
    await rm(runDirectory, { force: true, recursive: true });
    throw error;
  }

  let cleaned = false;

  return Object.freeze({
    repositoryRoot,
    worktreeRoot: await realpath(worktreeRoot),
    headSha,
    cleanup: async (): Promise<void> => {
      if (cleaned) {
        return;
      }
      cleaned = true;

      try {
        await runGit(
          ["-C", repositoryRoot, "worktree", "remove", "--force", worktreeRoot],
          "worktree_cleanup_failed",
        );
      } catch (error: unknown) {
        await rm(runDirectory, { force: true, recursive: true });
        await pruneWorktrees(repositoryRoot);
        throw error;
      }

      await rm(runDirectory, { force: true, recursive: true });
    },
  });
}

async function canonicalDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) {
    throw new WorkspaceError("invalid_path", "Workspace paths must be non-empty strings");
  }

  try {
    const canonicalPath = await realpath(resolve(path));
    const metadata = await stat(canonicalPath);

    if (!metadata.isDirectory()) {
      throw new WorkspaceError("invalid_path", "Workspace paths must reference directories");
    }

    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError("invalid_path", "Workspace directory cannot be resolved", {
      cause: error,
    });
  }
}

async function discoverRepositoryRoot(repositoryPath: string): Promise<string> {
  let root: string;

  try {
    root = await runGit(
      ["-C", repositoryPath, "rev-parse", "--show-toplevel"],
      "not_git_repository",
    );
  } catch (error: unknown) {
    throw new WorkspaceError("not_git_repository", "Target path is not a Git repository", {
      cause: error,
    });
  }

  try {
    return await realpath(root);
  } catch (error: unknown) {
    throw new WorkspaceError("invalid_repository", "Git repository root cannot be resolved", {
      cause: error,
    });
  }
}

async function resolveHead(repositoryRoot: string): Promise<string> {
  try {
    return await runGit(
      ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"],
      "invalid_repository",
    );
  } catch (error: unknown) {
    throw new WorkspaceError("invalid_repository", "Git repository must have a valid HEAD", {
      cause: error,
    });
  }
}

async function pruneWorktrees(repositoryRoot: string): Promise<void> {
  try {
    await runGit(["-C", repositoryRoot, "worktree", "prune"], "worktree_cleanup_failed");
  } catch {
    // Preserve the original cleanup failure. A later Git command can prune the
    // administrative entry without risking another filesystem deletion here.
  }
}

async function runGit(args: readonly string[], errorCode: WorkspaceErrorCode): Promise<string> {
  try {
    const { stdout } = await execFile("git", [...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      timeout: GIT_TIMEOUT_MILLISECONDS,
    });
    return stdout.trim();
  } catch (error: unknown) {
    throw new WorkspaceError(errorCode, "Git command failed", { cause: error });
  }
}

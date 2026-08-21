import { spawn } from "node:child_process";

import { z } from "zod";

import type { PathPolicy } from "../permissions/path-policy.js";
import type { ToolExecutor } from "./types.js";

const MAX_PATCH_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 48 * 1024;
const MAX_GIT_METADATA_BYTES = 64 * 1024;
const MAX_PATCH_FILES = 20;
const MAX_DIFF_FILES = 50;
const GIT_TIMEOUT_MILLISECONDS = 15_000;
const PROTECTED_SEGMENTS = new Set([".aws", ".git", ".gnupg", ".issue-fix", ".ssh"]);
const PROTECTED_NAMES = new Set([".netrc", ".npmrc", ".pypirc", "credentials"]);
const PROTECTED_EXTENSIONS = [".key", ".p12", ".pem", ".pfx"];

const applyPatchInput = z.strictObject({
  patch: z.string().min(1).max(MAX_PATCH_BYTES),
});

const gitDiffInput = z.strictObject({
  maxBytes: z
    .int()
    .min(1)
    .max(MAX_DIFF_BYTES)
    .default(32 * 1024),
});

type FileStat = Readonly<{
  path: string;
  added: number | null;
  deleted: number | null;
  untracked: boolean;
}>;

type ProcessResult = Readonly<{
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  spawnFailed: boolean;
}>;

export function createRepositoryMutationTools(pathPolicy: PathPolicy): readonly ToolExecutor[] {
  return Object.freeze([
    createExecutor(
      "apply_patch",
      "Apply a bounded text-only Git unified diff to authorized worktree paths. Start with diff --git, include --- a/path and +++ b/path headers plus an @@ hunk; wrappers such as *** Begin Patch are invalid.",
      applyPatchInput,
      (input) => applyPatch(pathPolicy, input),
    ),
    createExecutor(
      "git_diff",
      "Return a bounded worktree diff with changed paths and statistics.",
      gitDiffInput,
      (input) => captureGitDiff(pathPolicy, input),
    ),
  ]);
}

function createExecutor<Schema extends z.ZodType>(
  name: string,
  description: string,
  schema: Schema,
  execute: (input: z.output<Schema>) => Promise<Readonly<Record<string, unknown>>>,
): ToolExecutor {
  return Object.freeze({
    definition: Object.freeze({ name, description, inputSchema: jsonSchema(schema) }),
    execute: async (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return toolError("invalid_arguments", {
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }
      try {
        return { content: JSON.stringify(await execute(parsed.data)), isError: false };
      } catch (error: unknown) {
        if (error instanceof RepositoryMutationError) {
          return toolError(error.code, error.metadata);
        }
        return toolError("mutation_failed");
      }
    },
  });
}

async function applyPatch(
  pathPolicy: PathPolicy,
  input: z.output<typeof applyPatchInput>,
): Promise<Readonly<Record<string, unknown>>> {
  const patchBytes = Buffer.from(input.patch, "utf8");
  if (patchBytes.length > MAX_PATCH_BYTES) {
    throw new RepositoryMutationError("patch_too_large");
  }
  rejectUnsupportedPatch(input.patch);

  const numstat = await runGit(pathPolicy.worktreeRoot, ["apply", "--numstat", "-z", "-"], {
    input: patchBytes,
    maxStdoutBytes: MAX_GIT_METADATA_BYTES,
  });
  assertGitSuccess(numstat, "invalid_patch");
  if (numstat.truncated) {
    throw new RepositoryMutationError("patch_metadata_too_large");
  }

  const stats = parseNumstat(numstat.stdout, false);
  if (stats.length === 0 || stats.length > MAX_PATCH_FILES) {
    throw new RepositoryMutationError("invalid_patch_file_count");
  }

  for (const file of stats) {
    if (isProtectedPath(file.path)) {
      throw new RepositoryMutationError("protected_path", { path: file.path });
    }
    const decision = await pathPolicy.authorize({ operation: "write", path: file.path });
    if (!decision.allowed) {
      throw new RepositoryMutationError("path_denied", {
        path: file.path,
        reason: decision.reason,
      });
    }
    if (decision.relativePath !== file.path) {
      throw new RepositoryMutationError("symlink_path_denied", { path: file.path });
    }
  }

  const check = await runGit(
    pathPolicy.worktreeRoot,
    ["apply", "--check", "--whitespace=error-all", "-"],
    { input: patchBytes, maxStdoutBytes: 8 * 1024 },
  );
  assertGitSuccess(check, "patch_rejected");

  const applied = await runGit(pathPolicy.worktreeRoot, ["apply", "--whitespace=error-all", "-"], {
    input: patchBytes,
    maxStdoutBytes: 8 * 1024,
  });
  assertGitSuccess(applied, "patch_apply_failed");

  return Object.freeze({
    ok: true,
    filesChanged: stats.length,
    paths: Object.freeze(stats.map((file) => file.path)),
  });
}

async function captureGitDiff(
  pathPolicy: PathPolicy,
  input: z.output<typeof gitDiffInput>,
): Promise<Readonly<Record<string, unknown>>> {
  const trackedStatsResult = await runGit(
    pathPolicy.worktreeRoot,
    ["diff", "--numstat", "-z", "--no-renames", "HEAD", "--"],
    { maxStdoutBytes: MAX_GIT_METADATA_BYTES },
  );
  assertGitSuccess(trackedStatsResult, "diff_failed");
  if (trackedStatsResult.truncated) {
    throw new RepositoryMutationError("diff_metadata_too_large");
  }

  const trackedStats = parseNumstat(trackedStatsResult.stdout, false);
  const untrackedPaths = await readUntrackedPaths(pathPolicy.worktreeRoot);
  const stats = [
    ...trackedStats,
    ...untrackedPaths.map(
      (path): FileStat => Object.freeze({ path, added: null, deleted: 0, untracked: true }),
    ),
  ];
  if (stats.length > MAX_DIFF_FILES) {
    throw new RepositoryMutationError("too_many_changed_files");
  }

  for (const file of stats) {
    if (isProtectedPath(file.path)) {
      throw new RepositoryMutationError("scope_violation", {
        path: file.path,
        reason: "protected_path",
      });
    }
    const decision = await pathPolicy.authorize({ operation: "write", path: file.path });
    if (!decision.allowed || decision.relativePath !== file.path) {
      throw new RepositoryMutationError("scope_violation", {
        path: file.path,
        reason: decision.allowed ? "symlink_path" : decision.reason,
      });
    }
  }

  const trackedDiff = await runGit(
    pathPolicy.worktreeRoot,
    ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", "HEAD", "--"],
    { maxStdoutBytes: input.maxBytes },
  );
  assertGitSuccess(trackedDiff, "diff_failed");

  const chunks: Buffer[] = [trackedDiff.stdout];
  let usedBytes = trackedDiff.stdout.length;
  let truncated = trackedDiff.truncated;

  for (const path of untrackedPaths) {
    const remaining = input.maxBytes - usedBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const untrackedDiff = await runGit(
      pathPolicy.worktreeRoot,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--",
        nullDevice(),
        path,
      ],
      { maxStdoutBytes: remaining },
    );
    if (untrackedDiff.spawnFailed || untrackedDiff.timedOut || untrackedDiff.exitCode !== 1) {
      throw new RepositoryMutationError("diff_failed");
    }
    chunks.push(untrackedDiff.stdout);
    usedBytes += untrackedDiff.stdout.length;
    truncated ||= untrackedDiff.truncated;
  }

  return Object.freeze({
    ok: true,
    filesChanged: stats.length,
    files: Object.freeze(stats),
    diff: Buffer.concat(chunks, usedBytes).toString("utf8"),
    truncated,
  });
}

function rejectUnsupportedPatch(patch: string): void {
  const prohibited = [
    /(^|\n)GIT binary patch(?:\n|$)/u,
    /(^|\n)Binary files /u,
    /(^|\n)deleted file mode /u,
    /(^|\n)rename (?:from|to) /u,
    /(^|\n)(?:old|new) mode /u,
    /(^|\n)\+\+\+ \/dev\/null(?:\t|\n|$)/u,
  ];
  if (prohibited.some((pattern) => pattern.test(patch))) {
    throw new RepositoryMutationError("unsupported_patch_operation");
  }
}

function parseNumstat(bytes: Buffer, untracked: boolean): FileStat[] {
  if (bytes.length === 0) {
    return [];
  }
  return bytes
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record): FileStat => {
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab <= 0 || secondTab <= firstTab + 1) {
        throw new RepositoryMutationError("invalid_git_metadata");
      }
      const added = parseCount(record.slice(0, firstTab));
      const deleted = parseCount(record.slice(firstTab + 1, secondTab));
      const path = record.slice(secondTab + 1);
      if (path.length === 0 || path.includes("\0") || path.includes("�")) {
        throw new RepositoryMutationError("invalid_git_metadata");
      }
      return Object.freeze({ path, added, deleted, untracked });
    });
}

function parseCount(value: string): number | null {
  if (value === "-") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RepositoryMutationError("invalid_git_metadata");
  }
  return parsed;
}

async function readUntrackedPaths(worktreeRoot: string): Promise<string[]> {
  const status = await runGit(
    worktreeRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"],
    { maxStdoutBytes: MAX_GIT_METADATA_BYTES },
  );
  assertGitSuccess(status, "diff_failed");
  if (status.truncated) {
    throw new RepositoryMutationError("diff_metadata_too_large");
  }

  return status.stdout
    .toString("utf8")
    .split("\0")
    .filter((record) => record.startsWith("?? "))
    .map((record) => record.slice(3));
}

function assertGitSuccess(result: ProcessResult, code: string): void {
  if (result.spawnFailed || result.timedOut || result.exitCode !== 0) {
    const detail = boundedGitError(result.stderr);
    throw new RepositoryMutationError(code, detail.length === 0 ? {} : { detail });
  }
}

function boundedGitError(stderr: Buffer): string {
  return stderr
    .toString("utf8")
    .replace(/[^\x20-\x7e]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: Readonly<{ input?: Buffer; maxStdoutBytes: number }>,
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn("git", [...args], {
      cwd,
      env: gitEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = options.maxStdoutBytes - stdoutBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        stdout.push(kept);
        stdoutBytes += kept.length;
      }
      truncated ||= chunk.length > Math.max(remaining, 0);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 8 * 1024 - stderrBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        stderr.push(kept);
        stderrBytes += kept.length;
      }
    });
    child.on("error", () => {
      spawnFailed = true;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MILLISECONDS);

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult(
        Object.freeze({
          exitCode,
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes),
          timedOut,
          truncated,
          spawnFailed,
        }),
      );
    });

    child.stdin.end(options.input);
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env["PATH"],
    SystemRoot: process.env["SystemRoot"],
    TEMP: process.env["TEMP"],
    TMP: process.env["TMP"],
    TMPDIR: process.env["TMPDIR"],
  };
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function isProtectedPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const normalizedSegments = segments.map((segment) => segment.toLocaleLowerCase("en-US"));
  const name = normalizedSegments.at(-1) ?? "";
  return (
    normalizedSegments.some((segment) => PROTECTED_SEGMENTS.has(segment)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    PROTECTED_NAMES.has(name) ||
    PROTECTED_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

function jsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const value: unknown = z.toJSONSchema(schema);
  if (!isRecord(value)) {
    throw new Error("Zod did not produce an object JSON schema");
  }
  return Object.freeze({ ...value });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RepositoryMutationError extends Error {
  public readonly code: string;
  public readonly metadata: Readonly<Record<string, unknown>>;

  public constructor(code: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "RepositoryMutationError";
    this.code = code;
    this.metadata = metadata;
  }
}

function toolError(
  code: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Readonly<{ content: string; isError: true }> {
  return Object.freeze({
    content: JSON.stringify({ ok: false, error: { code, ...metadata } }),
    isError: true,
  });
}

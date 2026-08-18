import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

export type PathOperation = "read" | "write";

export type PathDenialReason =
  | "invalid_request"
  | "unknown_operation"
  | "invalid_path"
  | "path_not_found"
  | "symlink_escape"
  | "outside_worktree"
  | "path_not_allowed"
  | "path_resolution_failed";

export type PathDecision =
  | Readonly<{
      allowed: true;
      operation: PathOperation;
      canonicalPath: string;
      relativePath: string;
    }>
  | Readonly<{
      allowed: false;
      reason: PathDenialReason;
    }>;

export class PathPolicyConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathPolicyConfigurationError";
  }
}

export class PathPolicy {
  readonly #worktreeRoot: string;
  readonly #allowedWritePatterns: readonly string[];

  private constructor(worktreeRoot: string, allowedWritePatterns: readonly string[]) {
    this.#worktreeRoot = worktreeRoot;
    this.#allowedWritePatterns = Object.freeze([...allowedWritePatterns]);
    Object.freeze(this);
  }

  public static async create(
    worktreeRoot: string,
    allowedWritePatterns: readonly string[],
  ): Promise<PathPolicy> {
    const canonicalRoot = await canonicalDirectory(worktreeRoot);
    const patterns = allowedWritePatterns.map(normalizePattern);

    if (patterns.length === 0) {
      throw new PathPolicyConfigurationError("At least one allowed write pattern is required");
    }

    return new PathPolicy(canonicalRoot, patterns);
  }

  public get worktreeRoot(): string {
    return this.#worktreeRoot;
  }

  public async authorize(request: unknown): Promise<PathDecision> {
    if (!isRecord(request) || typeof request["path"] !== "string") {
      return deny("invalid_request");
    }

    const operation = request["operation"];
    if (operation !== "read" && operation !== "write") {
      return deny("unknown_operation");
    }

    const normalizedRequest = normalizeRequestedPath(request["path"]);
    if (normalizedRequest === undefined) {
      return deny("invalid_path");
    }

    const lexicalPath = resolve(this.#worktreeRoot, ...normalizedRequest.split("/"));
    if (!isContained(this.#worktreeRoot, lexicalPath)) {
      return deny("outside_worktree");
    }

    const resolved = await resolveCandidate(lexicalPath, operation);
    if (!resolved.ok) {
      return deny(resolved.reason);
    }

    if (!isContained(this.#worktreeRoot, resolved.canonicalPath)) {
      return deny("symlink_escape");
    }

    const resolvedRelativePath = toPortablePath(
      relative(this.#worktreeRoot, resolved.canonicalPath),
    );
    if (resolvedRelativePath.length === 0) {
      if (operation === "write") {
        return deny("invalid_path");
      }
      return Object.freeze({
        allowed: true,
        operation,
        canonicalPath: resolved.canonicalPath,
        relativePath: ".",
      });
    }

    if (
      operation === "write" &&
      !this.#allowedWritePatterns.some((pattern) => matchesGlob(resolvedRelativePath, pattern))
    ) {
      return deny("path_not_allowed");
    }

    return Object.freeze({
      allowed: true,
      operation,
      canonicalPath: resolved.canonicalPath,
      relativePath: resolvedRelativePath,
    });
  }
}

type CandidateResolution =
  | Readonly<{ ok: true; canonicalPath: string }>
  | Readonly<{
      ok: false;
      reason: Extract<PathDenialReason, "path_not_found" | "path_resolution_failed">;
    }>;

async function resolveCandidate(
  lexicalPath: string,
  operation: PathOperation,
): Promise<CandidateResolution> {
  try {
    return { ok: true, canonicalPath: await realpath(lexicalPath) };
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      return { ok: false, reason: "path_resolution_failed" };
    }
    if (operation === "read") {
      return { ok: false, reason: "path_not_found" };
    }
  }

  const missingSegments: string[] = [];
  let cursor = lexicalPath;

  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return {
        ok: true,
        canonicalPath: resolve(canonicalAncestor, ...missingSegments),
      };
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        return { ok: false, reason: "path_resolution_failed" };
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      return { ok: false, reason: "path_resolution_failed" };
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) {
    throw new PathPolicyConfigurationError("Worktree root must be a non-empty path");
  }

  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new PathPolicyConfigurationError("Worktree root must be a directory");
    }
    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof PathPolicyConfigurationError) {
      throw error;
    }
    throw new PathPolicyConfigurationError("Worktree root cannot be resolved", { cause: error });
  }
}

function normalizePattern(pattern: string): string {
  if (typeof pattern !== "string") {
    throw new PathPolicyConfigurationError("Allowed write patterns must be strings");
  }

  const portablePattern = pattern.replaceAll("\\", "/").trim();
  if (
    portablePattern.length === 0 ||
    portablePattern.includes("\0") ||
    portablePattern.startsWith("/") ||
    win32.isAbsolute(portablePattern) ||
    portablePattern.split("/").includes("..")
  ) {
    throw new PathPolicyConfigurationError(
      "Allowed write patterns must be relative and stay inside the worktree",
    );
  }

  try {
    matchesGlob("validation-probe", portablePattern);
  } catch (error: unknown) {
    throw new PathPolicyConfigurationError("Allowed write pattern is not a valid glob", {
      cause: error,
    });
  }

  return portablePattern;
}

function normalizeRequestedPath(path: string): string | undefined {
  const portablePath = path.replaceAll("\\", "/");
  if (
    portablePath.length === 0 ||
    portablePath.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    portablePath.startsWith("/")
  ) {
    return undefined;
  }

  const segments = portablePath.split("/");
  if (segments.includes("..")) {
    return undefined;
  }

  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return normalized.length === 0 ? "." : normalized;
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function deny(reason: PathDenialReason): PathDecision {
  return Object.freeze({ allowed: false, reason });
}

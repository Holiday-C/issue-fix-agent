import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { stringify } from "yaml";

import type { TaskContract } from "../task/task-contract.js";
import type { TraceEvent, TraceSink } from "./types.js";

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_TRACE_BYTES = 1024 * 1024;
const TRACE_TRUNCATION_RESERVE_BYTES = 128;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_VERIFICATION_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_COLLECTION_ITEMS = 100;
const MAX_VALUE_DEPTH = 10;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const SENSITIVE_KEY_PATTERN =
  /(?:api.?key|authorization|cookie|credential|env|password|secret|token)/iu;

export type RunArtifactOptions = Readonly<{
  runId?: string;
  secretPatterns?: readonly string[];
  onEvent?: (event: TraceEvent) => void;
}>;

export class RunArtifactError extends Error {
  public readonly code:
    | "invalid_repository_root"
    | "invalid_run_id"
    | "unsafe_artifact_path"
    | "run_already_exists"
    | "artifact_write_failed";

  public constructor(code: RunArtifactError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunArtifactError";
    this.code = code;
  }
}

export class RunArtifacts {
  public readonly runId: string;
  public readonly runDirectory: string;
  public readonly trace: TraceSink;
  readonly #redactor: Redactor;

  public constructor(
    runId: string,
    runDirectory: string,
    redactor: Redactor,
    onEvent?: (event: TraceEvent) => void,
  ) {
    this.runId = runId;
    this.runDirectory = runDirectory;
    this.#redactor = redactor;
    this.trace = new JsonlTraceSink(join(runDirectory, "trace.jsonl"), redactor, onEvent);
    Object.freeze(this);
  }

  public async writeTask(task: TaskContract): Promise<void> {
    const value = this.#redactor.value({
      title: task.title,
      description: task.description,
      acceptance_criteria: task.acceptanceCriteria,
      allowed_paths: task.allowedPaths,
      verification: task.verification,
      limits: task.limits,
    });
    await this.#writeText("task.yaml", stringify(value), MAX_TASK_BYTES);
  }

  public async writeVerification(verification: unknown): Promise<void> {
    const serialized = `${JSON.stringify(this.#redactor.value(verification), undefined, 2)}\n`;
    await this.#writeText("verification.json", serialized, MAX_VERIFICATION_BYTES);
  }

  public async writeResult(markdown: string): Promise<void> {
    await this.#writeText("result.md", this.#redactor.text(markdown), MAX_RESULT_BYTES);
  }

  public async writePatch(patch: string): Promise<void> {
    await this.#writeText("changes.patch", this.#redactor.text(patch), MAX_PATCH_BYTES);
  }

  async #writeText(name: string, source: string, maximumBytes: number): Promise<void> {
    const bounded = truncateText(source, maximumBytes);
    await atomicWrite(
      this.runDirectory,
      name,
      bounded.truncated ? `${bounded.text}\n[TRUNCATED]\n` : bounded.text,
    );
  }
}

export async function createRunArtifacts(
  repositoryRoot: string,
  options: RunArtifactOptions = {},
): Promise<RunArtifacts> {
  const canonicalRoot = await canonicalRepositoryRoot(repositoryRoot);
  const runId = options.runId ?? randomUUID();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunArtifactError("invalid_run_id", "Run ID contains unsupported characters");
  }

  const issueFixDirectory = await ensureDirectory(canonicalRoot, ".issue-fix");
  const runsDirectory = await ensureDirectory(issueFixDirectory, "runs");
  if (!isContained(canonicalRoot, runsDirectory)) {
    throw new RunArtifactError("unsafe_artifact_path", "Run directory escapes the repository");
  }

  const runDirectory = join(runsDirectory, runId);
  try {
    await mkdir(runDirectory);
  } catch (error: unknown) {
    if (isFileSystemError(error, "EEXIST")) {
      throw new RunArtifactError("run_already_exists", "Run directory already exists", {
        cause: error,
      });
    }
    throw new RunArtifactError("artifact_write_failed", "Run directory cannot be created", {
      cause: error,
    });
  }

  const canonicalRunDirectory = await realpath(runDirectory);
  if (!isContained(runsDirectory, canonicalRunDirectory)) {
    throw new RunArtifactError("unsafe_artifact_path", "Run directory escapes the runs root");
  }

  try {
    await writeFile(join(canonicalRunDirectory, "trace.jsonl"), "", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error: unknown) {
    await rm(canonicalRunDirectory, { force: true, recursive: true });
    throw new RunArtifactError("artifact_write_failed", "Trace file cannot be created", {
      cause: error,
    });
  }

  return new RunArtifacts(
    runId,
    canonicalRunDirectory,
    new Redactor(options.secretPatterns ?? []),
    options.onEvent,
  );
}

class JsonlTraceSink implements TraceSink {
  readonly #path: string;
  readonly #redactor: Redactor;
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;
  #bytesWritten = 0;
  #truncated = false;
  #queue: Promise<void> = Promise.resolve();

  public constructor(path: string, redactor: Redactor, onEvent?: (event: TraceEvent) => void) {
    this.#path = path;
    this.#redactor = redactor;
    this.#onEvent = onEvent;
  }

  public record(event: TraceEvent): Promise<void> {
    const operation = this.#queue.then(() => this.#append(event));
    this.#queue = operation;
    return operation;
  }

  async #append(event: TraceEvent): Promise<void> {
    if (this.#truncated) return;

    let value = this.#redactor.value(event);
    let line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
      value = {
        type: event.type,
        iteration: event.iteration,
        metadata: { truncated: true },
      };
      line = `${JSON.stringify(value)}\n`;
    }

    if (
      this.#bytesWritten + Buffer.byteLength(line, "utf8") + TRACE_TRUNCATION_RESERVE_BYTES >
      MAX_TRACE_BYTES
    ) {
      const marker = `${JSON.stringify({ type: "trace_truncated", iteration: event.iteration })}\n`;
      await this.#write(marker);
      this.#bytesWritten += Buffer.byteLength(marker, "utf8");
      this.#truncated = true;
      this.#notify(event);
      return;
    }

    await this.#write(line);
    this.#bytesWritten += Buffer.byteLength(line, "utf8");
    this.#notify(event);
  }

  async #write(line: string): Promise<void> {
    try {
      await appendFile(this.#path, line, "utf8");
    } catch (error: unknown) {
      throw new RunArtifactError("artifact_write_failed", "Trace event cannot be written", {
        cause: error,
      });
    }
  }

  #notify(event: TraceEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Progress rendering is observational and cannot change run behavior.
    }
  }
}

class Redactor {
  readonly #patterns: readonly string[];

  public constructor(patterns: readonly string[]) {
    this.#patterns = Object.freeze(patterns.filter((pattern) => pattern.length > 0));
  }

  public text(source: string): string {
    let value = source
      .replace(/sk-ant-[A-Za-z0-9_-]+/gu, "[REDACTED]")
      .replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "[REDACTED]");
    for (const pattern of this.#patterns) value = value.replaceAll(pattern, "[REDACTED]");
    return value;
  }

  public value(source: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (depth > MAX_VALUE_DEPTH) return "[TRUNCATED]";
    if (typeof source === "string") {
      const bounded = truncateText(this.text(source), 4 * 1024);
      return bounded.truncated ? `${bounded.text}\n[TRUNCATED]` : bounded.text;
    }
    if (source === null || typeof source === "number" || typeof source === "boolean") return source;
    if (typeof source === "bigint") return source.toString();
    if (typeof source !== "object") return "[UNSUPPORTED]";
    if (seen.has(source)) return "[CIRCULAR]";
    seen.add(source);

    if (Array.isArray(source)) {
      return source.slice(0, MAX_COLLECTION_ITEMS).map((item) => this.value(item, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .slice(0, MAX_COLLECTION_ITEMS)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : this.value(value, depth + 1, seen);
    }
    return output;
  }
}

async function canonicalRepositoryRoot(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error: unknown) {
    throw new RunArtifactError("invalid_repository_root", "Repository root cannot be resolved", {
      cause: error,
    });
  }
}

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new RunArtifactError(
        "unsafe_artifact_path",
        "Artifact directory is not a real directory",
      );
    }
  } catch (error: unknown) {
    if (error instanceof RunArtifactError) throw error;
    if (!isFileSystemError(error, "ENOENT")) {
      throw new RunArtifactError(
        "artifact_write_failed",
        "Artifact directory cannot be inspected",
        { cause: error },
      );
    }
    await mkdir(path);
  }
  return realpath(path);
}

async function atomicWrite(directory: string, name: string, content: string): Promise<void> {
  const temporaryPath = join(directory, `.${name}.${randomUUID()}.tmp`);
  const destination = join(directory, name);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, destination);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw new RunArtifactError("artifact_write_failed", `Artifact ${name} cannot be written`, {
      cause: error,
    });
  }
}

function truncateText(
  source: string,
  maximumBytes: number,
): Readonly<{ text: string; truncated: boolean }> {
  if (Buffer.byteLength(source, "utf8") <= maximumBytes) return { text: source, truncated: false };
  const markerBytes = Buffer.byteLength("\n[TRUNCATED]\n", "utf8");
  let end = Math.min(source.length, maximumBytes - markerBytes);
  let text = source.slice(0, end);
  while (end > 0 && Buffer.byteLength(text, "utf8") > maximumBytes - markerBytes) {
    end -= 1;
    text = source.slice(0, end);
  }
  return { text, truncated: true };
}

function isContained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

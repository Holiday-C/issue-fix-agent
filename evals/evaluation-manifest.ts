import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep, win32 } from "node:path";

import { z } from "zod";
import { parseDocument } from "yaml";

import {
  MAX_TASK_SOURCE_BYTES,
  parseTaskContract,
  TaskContractError,
  type TaskContract,
} from "../src/task/task-contract.js";

export const MAX_EVALUATION_MANIFEST_BYTES = 256 * 1024;
export const MAX_EVALUATION_TASKS = 20;

export type EvaluationTask = Readonly<{
  id: string;
  fixture: string;
  fixturePath: string;
  task: string;
  taskPath: string;
  expectedChangedPaths: readonly string[];
  contract: TaskContract;
}>;

export type EvaluationManifest = Readonly<{
  version: 1;
  tasks: readonly EvaluationTask[];
}>;

export type EvaluationManifestErrorCode =
  | "invalid_path"
  | "invalid_yaml"
  | "invalid_manifest"
  | "invalid_reference";

export type EvaluationManifestIssue = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

export class EvaluationManifestError extends Error {
  public readonly code: EvaluationManifestErrorCode;
  public readonly issues: readonly EvaluationManifestIssue[];

  public constructor(
    code: EvaluationManifestErrorCode,
    message: string,
    issues: readonly EvaluationManifestIssue[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EvaluationManifestError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

const boundedText = (maximum: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\0"), "Must not contain a null byte");

const portableRelativePath = boundedText(500).refine(
  (value) =>
    !value.includes("\\") &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  "Must be a normalized portable relative path",
);

const evaluationTaskSchema = z.strictObject({
  id: boundedText(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  fixture: portableRelativePath,
  task: portableRelativePath,
  expected_changed_paths: z.array(portableRelativePath).min(1).max(100),
});

const evaluationManifestSchema = z
  .strictObject({
    version: z.literal(1),
    tasks: z.array(evaluationTaskSchema).min(1).max(MAX_EVALUATION_TASKS),
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    manifest.tasks.forEach((task, index) => {
      if (seen.has(task.id)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: "Task IDs must be unique",
        });
      }
      seen.add(task.id);
    });
  });

export async function loadEvaluationManifest(manifestPath: string): Promise<EvaluationManifest> {
  const canonicalManifestPath = await canonicalFile(manifestPath);
  const evaluationRoot = await realpath(dirname(canonicalManifestPath));
  const source = await readBoundedText(canonicalManifestPath, MAX_EVALUATION_MANIFEST_BYTES);
  const input = parseManifestYaml(source);
  const result = evaluationManifestSchema.safeParse(input);

  if (!result.success) {
    throw new EvaluationManifestError(
      "invalid_manifest",
      "Evaluation manifest validation failed",
      result.error.issues.map((issue) =>
        Object.freeze({
          path: Object.freeze(
            issue.path.map((segment) =>
              typeof segment === "number" || typeof segment === "string"
                ? segment
                : String(segment),
            ),
          ),
          message: issue.message,
        }),
      ),
    );
  }

  const tasks = await Promise.all(
    result.data.tasks.map((entry, index) => loadEvaluationTask(entry, index, evaluationRoot)),
  );

  return Object.freeze({ version: 1, tasks: Object.freeze(tasks) });
}

async function loadEvaluationTask(
  entry: z.infer<typeof evaluationTaskSchema>,
  index: number,
  evaluationRoot: string,
): Promise<EvaluationTask> {
  const fixturePath = await resolveReference(evaluationRoot, entry.fixture, "directory", [
    "tasks",
    index,
    "fixture",
  ]);
  const taskPath = await resolveReference(evaluationRoot, entry.task, "file", [
    "tasks",
    index,
    "task",
  ]);

  let contract: TaskContract;
  try {
    contract = parseTaskContract(await readBoundedText(taskPath, MAX_TASK_SOURCE_BYTES));
  } catch (error: unknown) {
    if (error instanceof TaskContractError) {
      throw new EvaluationManifestError(
        "invalid_reference",
        "Referenced task contract is invalid",
        [
          Object.freeze({
            path: Object.freeze(["tasks", index, "task"]),
            message: error.code,
          }),
        ],
        { cause: error },
      );
    }
    throw error;
  }

  const unexpectedPath = entry.expected_changed_paths.find(
    (path) => !contract.allowedPaths.some((pattern) => matchesGlob(path, pattern)),
  );
  if (unexpectedPath !== undefined) {
    throw new EvaluationManifestError(
      "invalid_reference",
      "Expected changed paths must be allowed by the task contract",
      [
        Object.freeze({
          path: Object.freeze(["tasks", index, "expected_changed_paths"]),
          message: "Path is outside the task contract's allowed paths",
        }),
      ],
    );
  }

  return Object.freeze({
    id: entry.id,
    fixture: entry.fixture,
    fixturePath,
    task: entry.task,
    taskPath,
    expectedChangedPaths: Object.freeze([...entry.expected_changed_paths]),
    contract,
  });
}

function parseManifestYaml(source: string): unknown {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      merge: false,
      prettyErrors: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (error: unknown) {
    throw new EvaluationManifestError(
      "invalid_yaml",
      "Evaluation manifest could not be parsed",
      [],
      {
        cause: error,
      },
    );
  }

  if (document.errors.length > 0) {
    throw new EvaluationManifestError(
      "invalid_yaml",
      "Evaluation manifest could not be parsed",
      document.errors.map((error) =>
        Object.freeze({ path: Object.freeze([]), message: error.code }),
      ),
    );
  }

  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    throw new EvaluationManifestError(
      "invalid_yaml",
      "Evaluation manifest contains unsupported aliases",
      [],
      { cause: error },
    );
  }
}

async function canonicalFile(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) {
    throw new EvaluationManifestError("invalid_path", "Manifest path must be a non-empty string");
  }

  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await stat(canonicalPath)).isFile()) {
      throw new EvaluationManifestError("invalid_path", "Manifest path must reference a file");
    }
    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof EvaluationManifestError) {
      throw error;
    }
    throw new EvaluationManifestError("invalid_path", "Manifest path cannot be resolved", [], {
      cause: error,
    });
  }
}

async function resolveReference(
  evaluationRoot: string,
  path: string,
  expectedType: "directory" | "file",
  issuePath: readonly (string | number)[],
): Promise<string> {
  try {
    const canonicalPath = await realpath(resolve(evaluationRoot, ...path.split("/")));
    if (!isContained(evaluationRoot, canonicalPath)) {
      throw new Error("reference escaped evaluation root");
    }

    const metadata = await stat(canonicalPath);
    if (
      (expectedType === "directory" && !metadata.isDirectory()) ||
      (expectedType === "file" && !metadata.isFile())
    ) {
      throw new Error("reference has the wrong type");
    }
    return canonicalPath;
  } catch (error: unknown) {
    throw new EvaluationManifestError(
      "invalid_reference",
      "Evaluation manifest reference cannot be resolved safely",
      [Object.freeze({ path: Object.freeze([...issuePath]), message: "Invalid reference" })],
      { cause: error },
    );
  }
}

async function readBoundedText(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    if (offset > maximumBytes) {
      throw new EvaluationManifestError(
        "invalid_manifest",
        "Referenced file exceeds its size limit",
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

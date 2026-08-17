import { z } from "zod";
import { parseDocument } from "yaml";

const MAX_TASK_SOURCE_BYTES = 1_000_000;

export const SAFE_TASK_LIMITS = Object.freeze({
  maxIterations: 100,
  maxChangedFiles: 100,
  timeoutMinutes: 120,
});

export type VerificationCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;

export type TaskLimits = Readonly<{
  maxIterations: number;
  maxChangedFiles: number;
  timeoutMinutes: number;
}>;

export type TaskContract = Readonly<{
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  allowedPaths: readonly string[];
  verification: readonly VerificationCommand[];
  limits: TaskLimits;
}>;

export type TaskContractErrorCode = "invalid_yaml" | "invalid_contract";

export type TaskContractIssue = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

export class TaskContractError extends Error {
  public readonly code: TaskContractErrorCode;
  public readonly issues: readonly TaskContractIssue[];

  public constructor(
    code: TaskContractErrorCode,
    message: string,
    issues: readonly TaskContractIssue[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskContractError";
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

const pathPattern = boundedText(500).refine(
  (value) =>
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.split(/[\\/]/u).includes(".."),
  "Must be a relative path pattern without parent traversal",
);

const commandArgument = z
  .string()
  .max(2_000)
  .refine((value) => !value.includes("\0"), "Must not contain a null byte");

const verificationCommandSchema = z.strictObject({
  executable: boundedText(300),
  args: z.array(commandArgument).max(100),
});

const taskSchema = z.strictObject({
  title: boundedText(200),
  description: boundedText(50_000),
  acceptance_criteria: z.array(boundedText(2_000)).min(1).max(100),
  allowed_paths: z.array(pathPattern).min(1).max(100),
  verification: z.array(verificationCommandSchema).min(1).max(20),
  limits: z.strictObject({
    max_iterations: z.int().min(1).max(SAFE_TASK_LIMITS.maxIterations),
    max_changed_files: z.int().min(1).max(SAFE_TASK_LIMITS.maxChangedFiles),
    timeout_minutes: z.int().min(1).max(SAFE_TASK_LIMITS.timeoutMinutes),
  }),
});

export function parseTaskContract(source: string): TaskContract {
  if (typeof source !== "string" || source.length === 0) {
    throw new TaskContractError("invalid_yaml", "Task source must be a non-empty string");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TASK_SOURCE_BYTES) {
    throw new TaskContractError("invalid_yaml", "Task source exceeds the size limit");
  }

  const input = parseYaml(source);
  const result = taskSchema.safeParse(input);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue): TaskContractIssue =>
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
    );
    throw new TaskContractError("invalid_contract", "Task contract validation failed", issues);
  }

  return freezeTaskContract(result.data);
}

function parseYaml(source: string): unknown {
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
    throw new TaskContractError("invalid_yaml", "Task YAML could not be parsed", [], {
      cause: error,
    });
  }

  if (document.errors.length > 0) {
    const issues = document.errors.map(
      (error): TaskContractIssue => Object.freeze({ path: Object.freeze([]), message: error.code }),
    );
    throw new TaskContractError("invalid_yaml", "Task YAML could not be parsed", issues);
  }

  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    throw new TaskContractError("invalid_yaml", "Task YAML contains unsupported aliases", [], {
      cause: error,
    });
  }
}

function freezeTaskContract(input: z.infer<typeof taskSchema>): TaskContract {
  const verification = input.verification.map((command) =>
    Object.freeze({
      executable: command.executable,
      args: Object.freeze([...command.args]),
    }),
  );

  return Object.freeze({
    title: input.title,
    description: input.description,
    acceptanceCriteria: Object.freeze([...input.acceptance_criteria]),
    allowedPaths: Object.freeze([...input.allowed_paths]),
    verification: Object.freeze(verification),
    limits: Object.freeze({
      maxIterations: input.limits.max_iterations,
      maxChangedFiles: input.limits.max_changed_files,
      timeoutMinutes: input.limits.timeout_minutes,
    }),
  });
}

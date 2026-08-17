import { describe, expect, it } from "vitest";

import {
  parseTaskContract,
  SAFE_TASK_LIMITS,
  TaskContractError,
} from "../../src/task/task-contract.js";

const validTask = `
title: Add email search
description: Add a case-insensitive email query.
acceptance_criteria:
  - Partial matches are supported
  - Pagination is unchanged
allowed_paths:
  - src/users/**
  - tests/users/**
verification:
  - executable: npm
    args: [run, lint]
  - executable: npm
    args: [test, --, users]
limits:
  max_iterations: 8
  max_changed_files: 10
  timeout_minutes: 20
`;

describe("parseTaskContract", () => {
  it("parses and freezes a valid provider-neutral task", () => {
    const task = parseTaskContract(validTask);

    expect(task).toEqual({
      title: "Add email search",
      description: "Add a case-insensitive email query.",
      acceptanceCriteria: ["Partial matches are supported", "Pagination is unchanged"],
      allowedPaths: ["src/users/**", "tests/users/**"],
      verification: [
        { executable: "npm", args: ["run", "lint"] },
        { executable: "npm", args: ["test", "--", "users"] },
      ],
      limits: { maxIterations: 8, maxChangedFiles: 10, timeoutMinutes: 20 },
    });
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(task.verification[0]?.args)).toBe(true);
    expect(Object.isFrozen(task.limits)).toBe(true);
  });

  it("returns structured issues for malformed YAML", () => {
    const error = captureTaskError(`${validTask}\ntitle: duplicate`);

    expect(error.code).toBe("invalid_yaml");
    expect(error.issues.some((issue) => issue.path.length === 0)).toBe(true);
  });

  it("rejects unknown fields", () => {
    const error = captureTaskError(`${validTask}\nnetwork: true`);

    expect(error.code).toBe("invalid_contract");
    expect(error.issues.some((issue) => issue.path.length === 0)).toBe(true);
  });

  it("rejects missing required fields", () => {
    const error = captureTaskError(validTask.replace("title: Add email search\n", ""));

    expect(error.code).toBe("invalid_contract");
    expect(error.issues.some((issue) => issue.path.join(".") === "title")).toBe(true);
  });

  it("rejects task sources larger than the parser boundary", () => {
    expect(captureTaskError("x".repeat(1_000_001)).code).toBe("invalid_yaml");
  });

  it("rejects shell-string verification commands", () => {
    const task = validTask.replace(
      "  - executable: npm\n    args: [run, lint]",
      "  - npm run lint",
    );

    const error = captureTaskError(task);

    expect(error.code).toBe("invalid_contract");
    expect(error.issues.some((issue) => issue.path.join(".") === "verification.0")).toBe(true);
  });

  it.each([
    ["max_iterations", 0],
    ["max_iterations", 1.5],
    ["max_iterations", SAFE_TASK_LIMITS.maxIterations + 1],
    ["max_changed_files", SAFE_TASK_LIMITS.maxChangedFiles + 1],
    ["timeout_minutes", SAFE_TASK_LIMITS.timeoutMinutes + 1],
  ])("rejects unsafe limit %s=%s", (name, value) => {
    const task = validTask.replace(new RegExp(`${name}: \\d+`, "u"), `${name}: ${value}`);

    expect(captureTaskError(task).code).toBe("invalid_contract");
  });

  it.each(["/etc/**", "../outside/**", "src/../../outside/**", "C:\\\\secrets\\\\**"])(
    "rejects unsafe allowed path %s",
    (path) => {
      const task = validTask.replace("src/users/**", path);

      const error = captureTaskError(task);

      expect(error.code).toBe("invalid_contract");
      expect(error.issues.some((issue) => issue.path.join(".") === "allowed_paths.0")).toBe(true);
    },
  );

  it("rejects YAML aliases", () => {
    const task = validTask.replace(
      "acceptance_criteria:\n  - Partial matches are supported\n  - Pagination is unchanged",
      "acceptance_criteria: &criteria\n  - Partial matches are supported\n  - Pagination is unchanged\nextra: *criteria",
    );

    expect(["invalid_yaml", "invalid_contract"]).toContain(captureTaskError(task).code);
  });
});

function captureTaskError(source: string): TaskContractError {
  try {
    parseTaskContract(source);
  } catch (error: unknown) {
    if (error instanceof TaskContractError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected task parsing to fail");
}

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy } from "../../src/permissions/path-policy.js";
import type { TaskContract } from "../../src/task/task-contract.js";
import {
  loadRepositoryInstructions,
  REPOSITORY_INSTRUCTION_LIMITS,
} from "../../src/workspace/repository-instructions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("loadRepositoryInstructions", () => {
  it("loads only applicable documents from general to specific scope", async () => {
    const root = await createRoot();
    await mkdir(join(root, "src/feature"), { recursive: true });
    await mkdir(join(root, "unrelated"));
    await writeFile(join(root, "AGENTS.md"), "root rules\n", "utf8");
    await writeFile(join(root, "src/AGENTS.md"), "source rules\n", "utf8");
    await writeFile(join(root, "src/feature/AGENTS.md"), "feature rules\n", "utf8");
    await writeFile(join(root, "unrelated/AGENTS.md"), "unrelated rules\n", "utf8");
    const task = createTask(["src/feature/**"]);
    const policy = await PathPolicy.create(root, task.allowedPaths);

    const instructions = await loadRepositoryInstructions(task, policy);

    expect(instructions.documents).toEqual([
      { path: "AGENTS.md", content: "root rules\n", truncated: false },
      { path: "src/AGENTS.md", content: "source rules\n", truncated: false },
      { path: "src/feature/AGENTS.md", content: "feature rules\n", truncated: false },
    ]);
    expect(instructions.omitted).toEqual([]);
    expect(instructions.truncated).toBe(false);
  });

  it("bounds instruction bytes and reports invalid UTF-8 explicitly", async () => {
    const root = await createRoot();
    await mkdir(join(root, "src/feature"), { recursive: true });
    await writeFile(
      join(root, "AGENTS.md"),
      "x".repeat(REPOSITORY_INSTRUCTION_LIMITS.maximumFileBytes + 100),
      "utf8",
    );
    await writeFile(join(root, "src/AGENTS.md"), Buffer.from([0xff, 0xfe]));
    const task = createTask(["src/feature/**"]);
    const policy = await PathPolicy.create(root, task.allowedPaths);

    const instructions = await loadRepositoryInstructions(task, policy);

    expect(instructions.documents[0]).toMatchObject({ path: "AGENTS.md", truncated: true });
    expect(instructions.totalBytes).toBeLessThanOrEqual(
      REPOSITORY_INSTRUCTION_LIMITS.maximumTotalBytes,
    );
    expect(instructions.omitted).toContainEqual({ path: "src/AGENTS.md", reason: "invalid_utf8" });
    expect(instructions.truncated).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "omits a symlink escape instead of reading it",
    async () => {
      const root = await createRoot();
      const outside = await createRoot();
      await mkdir(join(root, "src"));
      await writeFile(join(outside, "outside.md"), "outside secret\n", "utf8");
      await symlink(join(outside, "outside.md"), join(root, "src/AGENTS.md"));
      const task = createTask(["src/**"]);
      const policy = await PathPolicy.create(root, task.allowedPaths);

      const instructions = await loadRepositoryInstructions(task, policy);

      expect(instructions.documents).toEqual([]);
      expect(instructions.omitted).toContainEqual({
        path: "src/AGENTS.md",
        reason: "symlink_escape",
      });
    },
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-instructions-"));
  temporaryDirectories.push(root);
  return root;
}

function createTask(allowedPaths: readonly string[]): TaskContract {
  return Object.freeze({
    title: "Instruction task",
    description: "Load applicable instructions.",
    acceptanceCriteria: Object.freeze(["Instructions loaded"]),
    allowedPaths: Object.freeze([...allowedPaths]),
    verification: Object.freeze([
      Object.freeze({ executable: "node", args: Object.freeze(["--test"]) }),
    ]),
    limits: Object.freeze({ maxIterations: 2, maxChangedFiles: 2, timeoutMinutes: 1 }),
  });
}

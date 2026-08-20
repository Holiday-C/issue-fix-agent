import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvaluationManifestError,
  loadEvaluationManifest,
} from "../../evals/evaluation-manifest.js";

const temporaryDirectories: string[] = [];

const validTask = `
title: Fix a greeting
description: Correct the greeting implementation.
acceptance_criteria:
  - The greeting is correct
allowed_paths:
  - src/greeting.js
verification:
  - executable: node
    args: [--test]
limits:
  max_iterations: 4
  max_changed_files: 1
  timeout_minutes: 1
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("loadEvaluationManifest", () => {
  it("loads an ordered, deeply frozen manifest", async () => {
    const setup = await createEvaluation();

    const manifest = await loadEvaluationManifest(setup.manifestPath);

    expect(manifest.version).toBe(1);
    expect(manifest.tasks.map((task) => task.id)).toEqual(["greeting-typo"]);
    expect(manifest.tasks[0]).toMatchObject({
      fixture: "fixtures/greeting",
      task: "tasks/fix-greeting.yaml",
      expectedChangedPaths: ["src/greeting.js"],
      contract: { title: "Fix a greeting" },
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tasks)).toBe(true);
    expect(Object.isFrozen(manifest.tasks[0]?.expectedChangedPaths)).toBe(true);
  });

  it("loads the repository manifest", async () => {
    const manifest = await loadEvaluationManifest(join(process.cwd(), "evals", "manifest.yaml"));

    expect(manifest.tasks.map((task) => task.id)).toEqual(["greeting-typo"]);
    expect(manifest.tasks[0]?.contract.title).toBe("Fix the greeting typo");
  });

  it("rejects duplicate task IDs", async () => {
    const setup = await createEvaluation();
    await writeFile(
      setup.manifestPath,
      manifestSource(`
  - id: greeting-typo
    fixture: fixtures/greeting
    task: tasks/fix-greeting.yaml
    expected_changed_paths: [src/greeting.js]`),
    );

    const error = await captureManifestError(setup.manifestPath);

    expect(error.code).toBe("invalid_manifest");
    expect(error.issues.some((issue) => issue.path.join(".") === "tasks.1.id")).toBe(true);
  });

  it.each(["../outside", "/tmp/outside", "C:\\outside"])(
    "rejects unsafe manifest paths: %s",
    async (unsafePath) => {
      const setup = await createEvaluation();
      await writeFile(
        setup.manifestPath,
        manifestSource().replace("fixtures/greeting", unsafePath),
      );

      expect((await captureManifestError(setup.manifestPath)).code).toBe("invalid_manifest");
    },
  );

  it("rejects a symlink reference that escapes the evaluation root", async () => {
    const setup = await createEvaluation();
    const outside = await mkdtemp(join(tmpdir(), "issue-fix-eval-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(setup.root, "fixtures", "escaped"), "dir");
    await writeFile(
      setup.manifestPath,
      manifestSource().replace("fixtures/greeting", "fixtures/escaped"),
    );

    const error = await captureManifestError(setup.manifestPath);

    expect(error.code).toBe("invalid_reference");
    expect(error.issues[0]?.path.join(".")).toBe("tasks.0.fixture");
  });

  it("rejects missing and wrongly typed references", async () => {
    const setup = await createEvaluation();
    await writeFile(
      setup.manifestPath,
      manifestSource().replace("tasks/fix-greeting.yaml", "fixtures/greeting"),
    );

    expect((await captureManifestError(setup.manifestPath)).code).toBe("invalid_reference");
  });

  it("rejects expected paths outside the task contract", async () => {
    const setup = await createEvaluation();
    await writeFile(
      setup.manifestPath,
      manifestSource().replace("src/greeting.js", "docs/readme.md"),
    );

    const error = await captureManifestError(setup.manifestPath);

    expect(error.code).toBe("invalid_reference");
    expect(error.issues[0]?.path.join(".")).toBe("tasks.0.expected_changed_paths");
  });
});

async function createEvaluation(): Promise<Readonly<{ root: string; manifestPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-eval-manifest-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "fixtures", "greeting"), { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(join(root, "tasks", "fix-greeting.yaml"), validTask);
  const manifestPath = join(root, "manifest.yaml");
  await writeFile(manifestPath, manifestSource());
  return { root, manifestPath };
}

function manifestSource(additionalTask = ""): string {
  return `version: 1
tasks:
  - id: greeting-typo
    fixture: fixtures/greeting
    task: tasks/fix-greeting.yaml
    expected_changed_paths: [src/greeting.js]
${additionalTask}
`;
}

async function captureManifestError(path: string): Promise<EvaluationManifestError> {
  try {
    await loadEvaluationManifest(path);
  } catch (error: unknown) {
    if (error instanceof EvaluationManifestError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected manifest loading to fail");
}

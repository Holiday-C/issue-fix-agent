import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunArtifacts, RunArtifactError } from "../../src/trace/run-artifacts.js";
import { parseTaskContract } from "../../src/task/task-contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("run artifacts", () => {
  it("persists ordered, redacted, reviewable run evidence", async () => {
    const root = await createRepository();
    const artifacts = await createRunArtifacts(root, {
      runId: "run-test-1",
      secretPatterns: ["custom-secret"],
    });
    const task = parseTaskContract(validTask);

    await artifacts.writeTask(task);
    await Promise.all([
      artifacts.trace.record({ type: "iteration_started", iteration: 1 }),
      artifacts.trace.record({
        type: "model_responded",
        iteration: 1,
        metadata: { apiKey: "custom-secret", note: "ghp_abcdefghijklmnopqrstuvwxyz" },
      }),
      artifacts.trace.record({
        type: "agent_stopped",
        iteration: 1,
        metadata: { status: "completed" },
      }),
    ]);
    await artifacts.writeVerification({
      passed: true,
      environment: { DATABASE_URL: "custom-secret" },
      token: "custom-secret",
    });
    await artifacts.writeResult("Result custom-secret sk-ant-abcdefghijklmnopqrstuvwxyz");
    await artifacts.writePatch("+const token = 'ghp_abcdefghijklmnopqrstuvwxyz';\n");

    const files = await readdir(artifacts.runDirectory);
    expect(files.sort()).toEqual([
      "changes.patch",
      "result.md",
      "task.yaml",
      "trace.jsonl",
      "verification.json",
    ]);
    const trace = await readFile(join(artifacts.runDirectory, "trace.jsonl"), "utf8");
    expect(trace.trim().split("\n").map(parseJsonObject)).toMatchObject([
      { type: "iteration_started", iteration: 1 },
      {
        type: "model_responded",
        iteration: 1,
        metadata: { apiKey: "[REDACTED]", note: "[REDACTED]" },
      },
      { type: "agent_stopped", iteration: 1 },
    ]);
    for (const name of files) {
      expect(await readFile(join(artifacts.runDirectory, name), "utf8")).not.toMatch(
        /custom-secret|ghp_|sk-ant-/u,
      );
    }
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await readFile(join(artifacts.runDirectory, "verification.json"), "utf8")).toContain(
      '"environment": "[REDACTED]"',
    );
  });

  it("truncates oversized events explicitly", async () => {
    const root = await createRepository();
    const artifacts = await createRunArtifacts(root, { runId: "run-truncate" });

    await artifacts.trace.record({
      type: "model_responded",
      iteration: 2,
      metadata: {
        first: "x".repeat(40_000),
        second: "x".repeat(40_000),
        third: "x".repeat(40_000),
        fourth: "x".repeat(40_000),
        fifth: "x".repeat(40_000),
      },
    });

    const event = parseJsonObject(
      await readFile(join(artifacts.runDirectory, "trace.jsonl"), "utf8"),
    );
    expect(event).toMatchObject({
      type: "model_responded",
      iteration: 2,
      metadata: { truncated: true },
    });
  });

  it("bounds oversized artifacts with an explicit marker", async () => {
    const root = await createRepository();
    const artifacts = await createRunArtifacts(root, { runId: "run-large-result" });

    await artifacts.writeResult("x".repeat(300_000));

    const result = await readFile(join(artifacts.runDirectory, "result.md"));
    expect(result.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(result.toString("utf8")).toMatch(/\[TRUNCATED\]\n$/u);
  });

  it("bounds the complete trace with an explicit terminal event", async () => {
    const root = await createRepository();
    const artifacts = await createRunArtifacts(root, { runId: "run-large-trace" });
    const value = "x".repeat(4_000);

    for (let iteration = 1; iteration <= 100; iteration += 1) {
      await artifacts.trace.record({
        type: "model_responded",
        iteration,
        metadata: { first: value, second: value, third: value },
      });
    }

    const trace = await readFile(join(artifacts.runDirectory, "trace.jsonl"));
    const lastEvent = parseJsonObject(trace.toString("utf8").trim().split("\n").at(-1) ?? "");
    expect(trace.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(lastEvent).toMatchObject({ type: "trace_truncated" });
  });

  it("cleans up a staged artifact when its atomic replacement fails", async () => {
    const root = await createRepository();
    const artifacts = await createRunArtifacts(root, { runId: "run-write-failure" });
    const destination = join(artifacts.runDirectory, "result.md");
    await mkdir(destination);

    await expect(artifacts.writeResult("incomplete")).rejects.toMatchObject({
      code: "artifact_write_failed",
    });

    expect((await stat(destination)).isDirectory()).toBe(true);
    expect((await readdir(artifacts.runDirectory)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("rejects duplicate run IDs", async () => {
    const root = await createRepository();
    await createRunArtifacts(root, { runId: "same-run" });

    await expect(createRunArtifacts(root, { runId: "same-run" })).rejects.toMatchObject({
      code: "run_already_exists",
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked artifact root", async () => {
    const root = await createRepository();
    const outside = await createRepository();
    await symlink(outside, join(root, ".issue-fix"));

    await expect(createRunArtifacts(root)).rejects.toBeInstanceOf(RunArtifactError);
    expect(await readdir(outside)).toEqual([]);
  });
});

const validTask = `
title: Artifact task
description: Persist safe evidence.
acceptance_criteria:
  - Evidence exists
allowed_paths:
  - src/**
verification:
  - executable: node
    args: [--test]
limits:
  max_iterations: 2
  max_changed_files: 2
  timeout_minutes: 5
`;

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-artifacts-"));
  temporaryDirectories.push(root);
  return root;
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

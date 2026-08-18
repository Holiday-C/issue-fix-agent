import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandPolicy } from "../../src/permissions/command-policy.js";
import { PathPolicy } from "../../src/permissions/path-policy.js";
import { SandboxRuntimeAdapter } from "../../src/process/sandbox-runtime-adapter.js";
import type { TaskContract } from "../../src/task/task-contract.js";
import { runVerification } from "../../src/verification/verification-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "darwin")("SandboxRuntimeAdapter", () => {
  it("runs inside the worktree with bounded output", async () => {
    const root = await createTemporaryDirectory("issue-fix-sandbox-worktree-");
    const script = join(root, "inside.mjs");
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync('generated.txt', 'ok'); console.log(process.argv[2]); console.log('x'.repeat(1000));\n",
      "utf8",
    );
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      const result = await adapter.run({
        executable: process.execPath,
        args: [script, "; touch injected.txt; #"],
        cwd: root,
        timeoutMilliseconds: 5_000,
        maxOutputBytes: 100,
      });
      expect(result).toMatchObject({ outcome: "completed", exitCode: 0, stdoutTruncated: true });
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(100);
      expect(result.stdout).toContain("; touch injected.txt; #");
      await expect(readFile(join(root, "generated.txt"), "utf8")).resolves.toBe("ok");
      await expect(access(join(root, "injected.txt"))).rejects.toThrow();
    } finally {
      await adapter.close();
    }
  });

  it("blocks writes outside the worktree", async () => {
    const root = await createTemporaryDirectory("issue-fix-sandbox-worktree-");
    const outside = join(
      await createTemporaryDirectory("issue-fix-sandbox-outside-"),
      "escaped.txt",
    );
    const script = join(root, "escape.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'escaped');\n`,
      "utf8",
    );
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      const result = await adapter.run({
        executable: process.execPath,
        args: [script],
        cwd: root,
        timeoutMilliseconds: 5_000,
        maxOutputBytes: 2_000,
      });
      expect(result.exitCode).not.toBe(0);
      await expect(access(outside)).rejects.toThrow();
    } finally {
      await adapter.close();
    }
  });

  it("blocks outbound network access", async () => {
    const root = await createTemporaryDirectory("issue-fix-sandbox-worktree-");
    const script = join(root, "network.mjs");
    await writeFile(
      script,
      "import net from 'node:net'; const s = net.connect(80, 'example.com'); s.on('error', () => process.exit(7)); s.on('connect', () => process.exit(0));\n",
      "utf8",
    );
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      const result = await adapter.run({
        executable: process.execPath,
        args: [script],
        cwd: root,
        timeoutMilliseconds: 5_000,
        maxOutputBytes: 2_000,
      });
      expect(result.exitCode).toBe(7);
    } finally {
      await adapter.close();
    }
  });

  it("blocks reads from the host home and strips credential environment variables", async () => {
    const root = await createTemporaryDirectory("issue-fix-sandbox-worktree-");
    const script = join(root, "credentials.mjs");
    await writeFile(
      script,
      `import { readdirSync } from 'node:fs';
if (process.env.ANTHROPIC_API_KEY !== undefined) process.exit(8);
try { readdirSync(${JSON.stringify(homedir())}); process.exit(0); } catch { process.exit(9); }
`,
      "utf8",
    );
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "must-not-leak";
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      const result = await adapter.run({
        executable: process.execPath,
        args: [script],
        cwd: root,
        timeoutMilliseconds: 5_000,
        maxOutputBytes: 2_000,
      });
      expect(result.exitCode).toBe(9);
    } finally {
      await adapter.close();
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("returns distinct timeout and cancellation outcomes", async () => {
    const root = await createTemporaryDirectory("issue-fix-sandbox-worktree-");
    const script = join(root, "wait.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      const timedOut = await adapter.run({
        executable: process.execPath,
        args: [script],
        cwd: root,
        timeoutMilliseconds: 50,
        maxOutputBytes: 2_000,
      });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await adapter.run(
        {
          executable: process.execPath,
          args: [script],
          cwd: root,
          timeoutMilliseconds: 5_000,
          maxOutputBytes: 2_000,
        },
        controller.signal,
      );

      expect(timedOut.outcome).toBe("timed_out");
      expect(cancelled.outcome).toBe("cancelled");
    } finally {
      await adapter.close();
    }
  });

  it("runs an authorized verification through the real process boundary", async () => {
    const root = await createTemporaryDirectory("issue-fix-verification-worktree-");
    await writeFile(
      join(root, "fixture.test.mjs"),
      "import assert from 'node:assert/strict'; import test from 'node:test'; test('fixture', () => assert.equal(2 + 2, 4));\n",
      "utf8",
    );
    const task: TaskContract = Object.freeze({
      title: "Fixture verification",
      description: "Run a deterministic test.",
      acceptanceCriteria: Object.freeze(["Test passes"]),
      allowedPaths: Object.freeze(["**"]),
      verification: Object.freeze([
        Object.freeze({
          executable: "node",
          args: Object.freeze(["--test", "fixture.test.mjs"]),
        }),
      ]),
      limits: Object.freeze({ maxIterations: 1, maxChangedFiles: 1, timeoutMinutes: 1 }),
    });
    const pathPolicy = await PathPolicy.create(root, task.allowedPaths);
    const commands = new CommandPolicy(pathPolicy, [
      { executable: "node", args: ["--test", "fixture.test.mjs"] },
    ]);
    const adapter = await SandboxRuntimeAdapter.create(root);

    try {
      await expect(
        runVerification({
          task,
          worktreeRoot: pathPolicy.worktreeRoot,
          commands,
          process: adapter,
        }),
      ).resolves.toMatchObject({
        verdict: "passed",
        completedAllChecks: true,
        checks: [{ status: "passed", exitCode: 0 }],
      });
    } finally {
      await adapter.close();
    }
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return realpath(root);
}

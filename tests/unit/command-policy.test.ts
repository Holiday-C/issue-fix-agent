import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandPolicy } from "../../src/permissions/command-policy.js";
import { PathPolicy } from "../../src/permissions/path-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CommandPolicy", () => {
  it("authorizes only an exact trusted Node command inside the worktree", async () => {
    const root = await createWorktree();
    const pathPolicy = await PathPolicy.create(root, ["src/**"]);
    const policy = new CommandPolicy(pathPolicy, [{ executable: "node", args: ["--test"] }]);

    const decision = await policy.authorize({ executable: "node", args: ["--test"], cwd: "." });

    expect(decision).toMatchObject({
      allowed: true,
      invocation: {
        executable: process.execPath,
        args: ["--test"],
        cwd: await realpath(root),
        timeoutMilliseconds: 30_000,
        maxOutputBytes: 32 * 1024,
      },
    });
  });

  it.each([
    [{ executable: "npm", args: ["test"], cwd: "." }, "unsupported_executable"],
    [{ executable: "node", args: ["--version"], cwd: "." }, "command_not_allowed"],
    [{ executable: "node", args: ["--test"], cwd: "../outside" }, "cwd_denied"],
    [{ executable: "node", args: ["--test"], cwd: "file.txt" }, "cwd_not_directory"],
    [{ executable: "node", args: ["--test"], cwd: ".", extra: true }, "invalid_request"],
  ])("denies request %j with %s", async (request, reason) => {
    const root = await createWorktree();
    const pathPolicy = await PathPolicy.create(root, ["src/**"]);
    const policy = new CommandPolicy(pathPolicy, [{ executable: "node", args: ["--test"] }]);

    await expect(policy.authorize(request)).resolves.toEqual({ allowed: false, reason });
  });
});

async function createWorktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-command-policy-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "file.txt"), "file\n", "utf8");
  return root;
}

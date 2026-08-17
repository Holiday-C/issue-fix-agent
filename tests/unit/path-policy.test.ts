import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy, PathPolicyConfigurationError } from "../../src/permissions/path-policy.js";

const temporaryDirectories: string[] = [];
const invalidPatternSets: readonly (readonly [readonly string[]])[] = [
  [[]],
  [["/absolute/**"]],
  [["../outside/**"]],
  [["src/../../outside/**"]],
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PathPolicy", () => {
  it("allows writes to existing files matched by an allowed pattern", async () => {
    const root = await createWorktree();
    const policy = await PathPolicy.create(root, ["src/**", "tests/**"]);

    await expect(policy.authorize({ operation: "write", path: "src/example.ts" })).resolves.toEqual(
      {
        allowed: true,
        operation: "write",
        canonicalPath: await realpath(join(root, "src/example.ts")),
        relativePath: "src/example.ts",
      },
    );
  });

  it("allows writes to a missing path when its canonical ancestor is allowed", async () => {
    const root = await createWorktree();
    const policy = await PathPolicy.create(root, ["src/**"]);

    await expect(
      policy.authorize({ operation: "write", path: "src/new/nested.ts" }),
    ).resolves.toMatchObject({
      allowed: true,
      operation: "write",
      relativePath: "src/new/nested.ts",
    });
  });

  it("allows reads inside the worktree without expanding write scope", async () => {
    const root = await createWorktree();
    const policy = await PathPolicy.create(root, ["src/**"]);

    await expect(policy.authorize({ operation: "read", path: "README.md" })).resolves.toMatchObject(
      {
        allowed: true,
        operation: "read",
        relativePath: "README.md",
      },
    );
    await expect(policy.authorize({ operation: "write", path: "README.md" })).resolves.toEqual({
      allowed: false,
      reason: "path_not_allowed",
    });
  });

  it.each(["/etc/passwd", "../outside.txt", "src/../../outside.txt", "C:\\secrets.txt"])(
    "denies unsafe requested path %s",
    async (path) => {
      const root = await createWorktree();
      const policy = await PathPolicy.create(root, ["**"]);

      await expect(policy.authorize({ operation: "read", path })).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it("denies a sibling-prefix traversal", async () => {
    const parent = await createTemporaryDirectory("issue-fix-policy-parent-");
    const root = join(parent, "worktree");
    const sibling = join(parent, "worktree-secret");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.txt"), "secret\n", "utf8");
    const policy = await PathPolicy.create(root, ["**"]);

    await expect(
      policy.authorize({ operation: "read", path: "../worktree-secret/secret.txt" }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.skipIf(process.platform === "win32")("denies paths that escape through symlinks", async () => {
    const root = await createWorktree();
    const outside = await createTemporaryDirectory("issue-fix-policy-outside-");
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(outside, join(root, "src/external"));
    const policy = await PathPolicy.create(root, ["src/**"]);

    await expect(
      policy.authorize({ operation: "read", path: "src/external/secret.txt" }),
    ).resolves.toEqual({ allowed: false, reason: "symlink_escape" });
    await expect(
      policy.authorize({ operation: "write", path: "src/external/new.txt" }),
    ).resolves.toEqual({ allowed: false, reason: "symlink_escape" });
  });

  it("denies missing read paths", async () => {
    const root = await createWorktree();
    const policy = await PathPolicy.create(root, ["src/**"]);

    await expect(policy.authorize({ operation: "read", path: "src/missing.ts" })).resolves.toEqual({
      allowed: false,
      reason: "path_not_found",
    });
  });

  it("denies malformed requests and unknown operations", async () => {
    const root = await createWorktree();
    const policy = await PathPolicy.create(root, ["src/**"]);

    await expect(
      policy.authorize({ operation: "delete", path: "src/example.ts" }),
    ).resolves.toEqual({ allowed: false, reason: "unknown_operation" });
    await expect(policy.authorize({ operation: "read", path: 42 })).resolves.toEqual({
      allowed: false,
      reason: "invalid_request",
    });
  });

  it.each(invalidPatternSets)("rejects unsafe policy patterns %j", async (patterns) => {
    const root = await createWorktree();

    await expect(PathPolicy.create(root, patterns)).rejects.toBeInstanceOf(
      PathPolicyConfigurationError,
    );
  });
});

async function createWorktree(): Promise<string> {
  const root = await createTemporaryDirectory("issue-fix-policy-worktree-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/example.ts"), "export {};\n", "utf8");
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

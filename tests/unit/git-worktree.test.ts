import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createIsolatedWorktree } from "../../src/workspace/git-worktree.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("createIsolatedWorktree", () => {
  it("creates a detached worktree at the repository HEAD", async () => {
    const repository = await createRepository();
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-worktrees-");
    const expectedHead = await git(repository, ["rev-parse", "HEAD"]);
    const worktree = await createIsolatedWorktree(repository, { temporaryDirectory });

    expect(worktree.repositoryRoot).toBe(await realpath(repository));
    expect(worktree.headSha).toBe(expectedHead);
    await expect(readFile(join(worktree.worktreeRoot, "example.txt"), "utf8")).resolves.toBe(
      "committed\n",
    );
    await expect(git(worktree.worktreeRoot, ["branch", "--show-current"])).resolves.toBe("");

    await worktree.cleanup();
    await expect(access(worktree.worktreeRoot)).rejects.toThrow();
  });

  it("preserves dirty and untracked files in the source checkout", async () => {
    const repository = await createRepository();
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-worktrees-");
    await writeFile(join(repository, "example.txt"), "user change\n", "utf8");
    await writeFile(join(repository, "untracked.txt"), "keep me\n", "utf8");
    const statusBefore = await git(repository, ["status", "--short"]);

    const worktree = await createIsolatedWorktree(repository, { temporaryDirectory });

    await expect(readFile(join(worktree.worktreeRoot, "example.txt"), "utf8")).resolves.toBe(
      "committed\n",
    );
    expect(await git(repository, ["status", "--short"])).toBe(statusBefore);

    await worktree.cleanup();
    await expect(readFile(join(repository, "example.txt"), "utf8")).resolves.toBe("user change\n");
    await expect(readFile(join(repository, "untracked.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("cleans up idempotently", async () => {
    const repository = await createRepository();
    const temporaryDirectory = await createTemporaryDirectory("issue-fix-worktrees-");
    const worktree = await createIsolatedWorktree(repository, { temporaryDirectory });

    await worktree.cleanup();
    await expect(worktree.cleanup()).resolves.toBeUndefined();
  });

  it("rejects paths that are not Git repositories", async () => {
    const directory = await createTemporaryDirectory("issue-fix-not-repository-");

    await expect(createIsolatedWorktree(directory)).rejects.toMatchObject({
      code: "not_git_repository",
    });
  });

  it("rejects repositories without a commit", async () => {
    const repository = await createTemporaryDirectory("issue-fix-empty-repository-");
    await git(repository, ["init", "--quiet"]);

    await expect(createIsolatedWorktree(repository)).rejects.toMatchObject({
      code: "invalid_repository",
    });
  });
});

async function createRepository(): Promise<string> {
  const repository = await createTemporaryDirectory("issue-fix-repository-");
  await git(repository, ["init", "--quiet"]);
  await writeFile(join(repository, "example.txt"), "committed\n", "utf8");
  await git(repository, ["add", "example.txt"]);
  await git(repository, [
    "-c",
    "user.name=Issue Fix Test",
    "-c",
    "user.email=issue-fix@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial fixture",
  ]);
  return repository;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy } from "../../src/permissions/path-policy.js";
import { createRepositoryDiscoveryTools } from "../../src/tools/repository-discovery.js";
import type { ToolExecutor } from "../../src/tools/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("repository discovery tools", () => {
  it("lists deterministic bounded pages and omits sensitive entries", async () => {
    const tools = await createTools();
    const first = await execute(tools, "list_files", { path: ".", maxDepth: 2, limit: 2 });
    const second = await execute(tools, "list_files", {
      path: ".",
      maxDepth: 2,
      cursor: 2,
      limit: 20,
    });

    expect(first.isError).toBe(false);
    expect(first.value["entries"]).toEqual([
      { path: "README.md", kind: "file", size: 10 },
      { path: "src", kind: "directory" },
    ]);
    expect(first.value["truncated"]).toBe(true);
    expect(first.value["nextCursor"]).toBe(2);
    expect(second.value["entries"]).toEqual([
      { path: "src/a.ts", kind: "file", size: 25 },
      { path: "src/data.bin", kind: "file", size: 4 },
      { path: "src/nested", kind: "directory" },
      { path: "src/nested/b.ts", kind: "file", size: 26 },
    ]);
    expect(second.value["omittedEntries"]).toBeGreaterThanOrEqual(2);
  });

  it("searches literal text deterministically with pagination", async () => {
    const tools = await createTools();
    const first = await execute(tools, "search_code", {
      path: ".",
      query: "needle",
      caseSensitive: false,
      limit: 1,
    });
    const second = await execute(tools, "search_code", {
      path: ".",
      query: "needle",
      caseSensitive: false,
      cursor: 1,
      limit: 10,
    });

    expect(first.value["entries"]).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 1, column: 8 }),
    ]);
    expect(first.value["nextCursor"]).toBe(1);
    expect(second.value["entries"]).toEqual([
      expect.objectContaining({ path: "src/nested/b.ts", line: 1, column: 8 }),
    ]);
  });

  it("reads UTF-8 files in bounded continuation segments", async () => {
    const tools = await createTools();
    const first = await execute(tools, "read_file", {
      path: "README.md",
      maxBytes: 4,
    });
    const second = await execute(tools, "read_file", {
      path: "README.md",
      offset: first.value["nextOffset"],
      maxBytes: 20,
    });

    expect(first.value).toMatchObject({ content: "# Fi", bytesRead: 4, nextOffset: 4 });
    expect(second.value).toMatchObject({ content: "xture\n", truncated: false, nextOffset: null });
  });

  it("requires continuation reads for files larger than the read ceiling", async () => {
    const root = await createFixture();
    await writeFile(join(root, "src/large.txt"), "x".repeat(20 * 1024), "utf8");
    const policy = await PathPolicy.create(root, ["src/**"]);
    const tools = createRepositoryDiscoveryTools(policy);

    const first = await execute(tools, "read_file", {
      path: "src/large.txt",
      maxBytes: 16 * 1024,
    });
    const second = await execute(tools, "read_file", {
      path: "src/large.txt",
      offset: first.value["nextOffset"],
      maxBytes: 16 * 1024,
    });

    expect(first.value).toMatchObject({
      bytesRead: 16 * 1024,
      totalBytes: 20 * 1024,
      truncated: true,
      nextOffset: 16 * 1024,
    });
    expect(second.value).toMatchObject({
      bytesRead: 4 * 1024,
      totalBytes: 20 * 1024,
      truncated: false,
      nextOffset: null,
    });
  });

  it("ends byte segments on UTF-8 character boundaries", async () => {
    const root = await createFixture();
    await writeFile(join(root, "src/unicode.txt"), "éé\n", "utf8");
    const policy = await PathPolicy.create(root, ["src/**"]);
    const tools = createRepositoryDiscoveryTools(policy);

    const first = await execute(tools, "read_file", {
      path: "src/unicode.txt",
      maxBytes: 3,
    });
    const second = await execute(tools, "read_file", {
      path: "src/unicode.txt",
      offset: first.value["nextOffset"],
      maxBytes: 3,
    });

    expect(first.value).toMatchObject({ content: "é", bytesRead: 2, nextOffset: 2 });
    expect(second.value).toMatchObject({ content: "é\n", bytesRead: 3, nextOffset: null });
  });

  it("rejects sensitive, binary, traversal, and malformed requests", async () => {
    const tools = await createTools();

    await expectError(tools, "read_file", { path: ".env", maxBytes: 20 }, "sensitive_path");
    await expectError(
      tools,
      "read_file",
      { path: "src/data.bin", maxBytes: 20 },
      "binary_or_invalid_utf8",
    );
    await expectError(tools, "read_file", { path: "../outside.txt", maxBytes: 20 }, "path_denied");
    await expectError(
      tools,
      "read_file",
      { path: "README.md", unknown: true },
      "invalid_arguments",
    );
  });

  it.skipIf(process.platform === "win32")("does not follow directory symlinks", async () => {
    const root = await createFixture();
    const outside = await createTemporaryDirectory("issue-fix-discovery-outside-");
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(outside, join(root, "linked"));
    const policy = await PathPolicy.create(root, ["src/**"]);
    const tools = createRepositoryDiscoveryTools(policy);

    const result = await execute(tools, "list_files", { path: ".", maxDepth: 5, limit: 50 });
    expect(result.value["entries"]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "linked/secret.txt" })]),
    );
  });
});

async function createTools(): Promise<readonly ToolExecutor[]> {
  const root = await createFixture();
  const policy = await PathPolicy.create(root, ["src/**"]);
  return createRepositoryDiscoveryTools(policy);
}

async function createFixture(): Promise<string> {
  const root = await createTemporaryDirectory("issue-fix-discovery-");
  await mkdir(join(root, "src/nested"), { recursive: true });
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, "src/a.ts"), "export NEEDLE = 'first';\n", "utf8");
  await writeFile(join(root, "src/nested/b.ts"), "export needle = 'second';\n", "utf8");
  await writeFile(join(root, "src/data.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
  await writeFile(join(root, "node_modules/ignored.js"), "needle\n", "utf8");
  return root;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function execute(
  tools: readonly ToolExecutor[],
  name: string,
  input: unknown,
): Promise<Readonly<{ isError: boolean; value: Readonly<Record<string, unknown>> }>> {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool ${name}`);
  }
  const result = await tool.execute(input);
  return Object.freeze({ isError: result.isError, value: parseJsonObject(result.content) });
}

async function expectError(
  tools: readonly ToolExecutor[],
  name: string,
  input: unknown,
  code: string,
): Promise<void> {
  const result = await execute(tools, name, input);
  expect(result.isError).toBe(true);
  expect(result.value).toMatchObject({ ok: false, error: { code } });
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

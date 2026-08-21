import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy } from "../../src/permissions/path-policy.js";
import { createRepositoryMutationTools } from "../../src/tools/repository-mutation.js";
import type { ToolExecutor } from "../../src/tools/types.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("repository mutation tools", () => {
  it("describes the exact patch format exposed to models", async () => {
    const { tools } = await createTools();
    const applyPatch = tools.find((tool) => tool.definition.name === "apply_patch");

    expect(applyPatch?.definition.description).toContain("diff --git");
    expect(applyPatch?.definition.description).toContain("--- a/path");
    expect(applyPatch?.definition.description).toContain("*** Begin Patch are invalid");
  });

  it("applies an authorized text patch and returns its bounded diff", async () => {
    const { root, tools } = await createTools();
    const patch = modificationPatch("export const value = 1;", "export const value = 2;");

    const applied = await execute(tools, "apply_patch", { patch });
    const diff = await execute(tools, "git_diff", { maxBytes: 20_000 });

    expect(applied.isError).toBe(false);
    expect(applied.value).toMatchObject({ ok: true, filesChanged: 1, paths: ["src/value.ts"] });
    await expect(readFile(join(root, "src/value.ts"), "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
    expect(diff.value).toMatchObject({
      ok: true,
      filesChanged: 1,
      files: [{ path: "src/value.ts", added: 1, deleted: 1, untracked: false }],
      truncated: false,
    });
    expect(diff.value["diff"]).toContain("+export const value = 2;");
  });

  it("replaces one exact text occurrence through the existing patch boundary", async () => {
    const { root, tools } = await createTools();

    const replaced = await execute(tools, "replace_text", {
      path: "src/value.ts",
      oldText: "value = 1",
      newText: "value = 2",
    });

    expect(replaced).toMatchObject({
      isError: false,
      value: { ok: true, filesChanged: 1, paths: ["src/value.ts"] },
    });
    await expect(readFile(join(root, "src/value.ts"), "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
  });

  it("rejects ambiguous or unauthorized exact replacements", async () => {
    const { root, tools } = await createTools();
    await writeFile(join(root, "src/value.ts"), "same same\n", "utf8");

    await expectError(
      tools,
      "replace_text",
      { path: "src/value.ts", oldText: "same", newText: "new" },
      "text_not_unique",
    );
    await expectError(
      tools,
      "replace_text",
      { path: "README.md", oldText: "Fixture", newText: "Changed" },
      "path_denied",
    );
    await expect(readFile(join(root, "src/value.ts"), "utf8")).resolves.toBe("same same\n");
  });

  it("replaces text beyond one read segment while keeping the patch bounded", async () => {
    const { root, tools } = await createTools();
    const source = `${Array.from({ length: 800 }, (_, index) => `line ${String(index).padStart(3, "0")}: catalog value`).join("\n")}\nomega: Oemga\n`;
    await writeFile(join(root, "src/value.ts"), source, "utf8");

    const result = await execute(tools, "replace_text", {
      path: "src/value.ts",
      oldText: "omega: Oemga",
      newText: "omega: Omega",
    });

    expect(result.isError).toBe(false);
    await expect(readFile(join(root, "src/value.ts"), "utf8")).resolves.toContain("omega: Omega");
  });

  it("includes an authorized new file in the diff", async () => {
    const { tools } = await createTools();
    const patch = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const created = true;
`;

    await expect(execute(tools, "apply_patch", { patch })).resolves.toMatchObject({
      isError: false,
    });
    const diff = await execute(tools, "git_diff", { maxBytes: 20_000 });

    expect(diff.value).toMatchObject({
      filesChanged: 1,
      files: [{ path: "src/new.ts", added: null, deleted: 0, untracked: true }],
    });
    expect(diff.value["diff"]).toContain("+export const created = true;");
  });

  it("rejects a multi-file patch when any target is unauthorized without partial mutation", async () => {
    const { root, tools } = await createTools();
    const patch = `${modificationPatch("export const value = 1;", "export const value = 2;")}
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# Fixture
+# Changed
`;

    await expectError(tools, "apply_patch", { patch }, "path_denied");
    await expect(readFile(join(root, "src/value.ts"), "utf8")).resolves.toBe(
      "export const value = 1;\n",
    );
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe("# Fixture\n");
  });

  it.each([
    ["deletion", "+++ /dev/null\n"],
    ["rename", "rename from src/value.ts\nrename to src/other.ts\n"],
    ["binary", "GIT binary patch\n"],
    ["mode", "old mode 100644\nnew mode 100755\n"],
  ])("rejects unsupported %s patches", async (_name, marker) => {
    const { tools } = await createTools();

    await expectError(
      tools,
      "apply_patch",
      { patch: `${modificationPatch()}${marker}` },
      "unsupported_patch_operation",
    );
  });

  it("returns a truncated diff within the requested output limit", async () => {
    const { tools } = await createTools();
    await execute(tools, "apply_patch", {
      patch: modificationPatch(
        "export const value = 1;",
        `export const value = "${"x".repeat(2_000)}";`,
      ),
    });

    const diff = await execute(tools, "git_diff", { maxBytes: 200 });

    expect(diff.value["truncated"]).toBe(true);
    expect(Buffer.byteLength(String(diff.value["diff"]), "utf8")).toBeLessThanOrEqual(200);
  });

  it("rejects malformed tool arguments", async () => {
    const { tools } = await createTools();

    await expectError(
      tools,
      "apply_patch",
      { patch: modificationPatch(), extra: true },
      "invalid_arguments",
    );
  });

  it("returns a bounded Git diagnostic for an invalid patch", async () => {
    const { tools } = await createTools();

    const result = await execute(tools, "apply_patch", {
      patch: "*** Begin Patch\n*** End Patch",
    });

    expect(result.value).toMatchObject({ ok: false, error: { code: "invalid_patch" } });
    const error = result.value["error"];
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      throw new TypeError("Expected a structured tool error");
    }
    const detail = (error as Readonly<Record<string, unknown>>)["detail"];
    expect(typeof detail).toBe("string");
    expect(
      typeof detail === "string" ? detail.length : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(200);
  });

  it("keeps repository metadata and credential paths protected from broad task scopes", async () => {
    const root = await createRepository();
    const policy = await PathPolicy.create(root, ["**"]);
    const tools = createRepositoryMutationTools(policy);
    const patch = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+TOKEN=secret
`;

    await expectError(tools, "apply_patch", { patch }, "protected_path");
  });
});

function modificationPatch(
  before = "export const value = 1;",
  after = "export const value = 2;",
): string {
  return `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-${before}
+${after}
`;
}

async function createTools(): Promise<Readonly<{ root: string; tools: readonly ToolExecutor[] }>> {
  const root = await createRepository();
  const policy = await PathPolicy.create(root, ["src/**"]);
  return Object.freeze({ root, tools: createRepositoryMutationTools(policy) });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "issue-fix-mutation-"));
  temporaryDirectories.push(root);
  await execFile("git", ["-C", root, "init", "--quiet"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await execFile("git", ["-C", root, "add", "."]);
  await execFile("git", [
    "-C",
    root,
    "-c",
    "user.name=Issue Fix Test",
    "-c",
    "user.email=issue-fix@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial fixture",
  ]);
  return root;
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

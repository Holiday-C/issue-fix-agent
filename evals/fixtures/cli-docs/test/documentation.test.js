import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("documents the current serve subcommand", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /node app\.js serve/u);
  assert.doesNotMatch(readme, /--serve/u);
});

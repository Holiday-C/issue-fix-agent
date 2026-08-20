import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runtimeMode } from "../src/runtime.js";

test("uses strict mode in source and configuration", async () => {
  const settings = JSON.parse(
    await readFile(new URL("../config/settings.json", import.meta.url), "utf8"),
  );
  assert.equal(runtimeMode, "strict");
  assert.equal(settings.mode, "strict");
});

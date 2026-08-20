import assert from "node:assert/strict";
import test from "node:test";

import { labelFor } from "../src/catalog.js";

test("returns the corrected omega label", () => {
  assert.equal(labelFor("omega"), "Omega");
});

test("preserves existing catalog entries", () => {
  assert.equal(labelFor("item-001"), "Catalog item 001");
  assert.equal(labelFor("missing"), null);
});

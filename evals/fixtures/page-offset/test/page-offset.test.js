import assert from "node:assert/strict";
import test from "node:test";

import { pageOffset } from "../src/page-offset.js";

test("preserves offsets for positive pages", () => {
  assert.equal(pageOffset(1, 25), 0);
  assert.equal(pageOffset(3, 25), 50);
});

test("clamps non-positive pages to the first page", () => {
  assert.equal(pageOffset(0, 25), 0);
  assert.equal(pageOffset(-2, 25), 0);
});

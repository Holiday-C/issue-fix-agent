import assert from "node:assert/strict";
import test from "node:test";

import { displayName } from "../src/profile.js";

test("displays the canonical profile name", () => {
  assert.equal(displayName(), "Ada Lovelace");
});

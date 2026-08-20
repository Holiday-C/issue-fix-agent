import assert from "node:assert/strict";
import test from "node:test";

import { slugify } from "../src/slug.js";

test("creates a normalized lowercase slug", () => {
  assert.equal(slugify("  Hello   Agent  "), "hello-agent");
});

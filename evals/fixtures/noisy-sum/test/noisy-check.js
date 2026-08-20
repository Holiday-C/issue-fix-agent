import assert from "node:assert/strict";

import { sum } from "../src/sum.js";

process.stdout.write("diagnostic output\n".repeat(5_000));
assert.equal(sum(2, 3), 5);

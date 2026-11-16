import assert from "node:assert/strict";
import test from "node:test";

import { opensAtTaskStart } from "../src/settings/taskPlaces.js";

test("建单前已有次数时，只把建单之后增加的次数算进任务", () => {
  assert.equal(opensAtTaskStart(2, 0, [1, 2]), 0);
  assert.equal(opensAtTaskStart(8, 5, [6, 8]), 5);
  assert.equal(opensAtTaskStart(5, 5, []), 5);
});

test("芯片复位后只累计变大的差值", () => {
  assert.equal(opensAtTaskStart(6, 5, [1, 2]), 5);
});

import assert from "node:assert/strict";
import test from "node:test";

import { foldBoxEvents } from "../src/domain/feed.js";

const row = (box, kind, at) => ({ box_id: box, name: box, kind, received_at: `2026-11-06 ${at}` });

test("工作台动态：同一台箱子连续上电合成一条，开关箱合成一条；中间夹别类事件就分开", () => {
  const rows = [
    row("A", "boot", "12:00:00"),
    row("B", "pad", "11:59:00"),
    row("A", "boot", "11:00:00"),
    row("A", "boot", "10:00:00"),
    row("B", "shut", "09:00:00"),
    row("B", "pad", "08:00:00"),
    row("A", "pad", "07:00:00"),
    row("A", "boot", "06:00:00"),
  ];
  const items = foldBoxEvents(rows);
  assert.deepEqual(
    items.map((i) => [i.boxName, i.action, i.count, i.time.slice(11), i.since.slice(11)]),
    [
      ["A", "上电 3 次", 3, "12:00:00", "10:00:00"],
      ["B", "开箱 2 次、关箱 1 次", 3, "11:59:00", "08:00:00"],
      ["A", "开箱", 1, "07:00:00", "07:00:00"],
      ["A", "上电", 1, "06:00:00", "06:00:00"],
    ]
  );
  assert.equal(items[1].kind, "pad");
  assert.equal(items[0].kind, "boot");
});

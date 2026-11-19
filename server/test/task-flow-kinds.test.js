import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_KINDS,
  ENDED,
  stepsOf,
  nextOf,
  initialOf,
  signTargetOf,
  prefixOf,
} from "../../shared/taskFlow.js";

test("B1 状态机：划拨两终态、无步骤、不走通用 transition", () => {
  assert.deepEqual(DOC_KINDS, ["采样", "送检", "划拨"]);
  assert.deepEqual(stepsOf({ kind: "划拨" }), []);
  assert.deepEqual(nextOf({ kind: "划拨" }, "已划拨"), []);
  assert.deepEqual(nextOf({ kind: "划拨" }, "已撤销"), []);
  assert.equal(initialOf({ kind: "划拨" }), "已划拨");
  assert.ok(ENDED.includes("已划拨") && ENDED.includes("已撤销"));
  assert.equal(prefixOf("划拨"), "AL-");
});

test("B1 状态机：送检 9 状态、已签收非持久态、返程与拒收分支", () => {
  assert.deepEqual(stepsOf({ kind: "送检" }), ["待寄出", "运送中", "待签收", "待检测", "已检测"]);
  assert.deepEqual(stepsOf({ kind: "送检", status: "退回中" }), [
    "待寄出",
    "运送中",
    "待签收",
    "退回中",
    "已退回",
  ]);
  assert.equal(signTargetOf({ kind: "送检" }), "待检测");
  assert.equal(initialOf({ kind: "送检" }), "待寄出");
  assert.deepEqual(nextOf({ kind: "送检" }, "待签收"), ["待检测", "已拒收", "退回中", "已取消"]);
  assert.deepEqual(nextOf({ kind: "送检" }, "待检测"), ["已检测", "已取消"]);
  assert.deepEqual(nextOf({ kind: "送检" }, "退回中"), ["已退回"]); // 退回途中不能取消
  assert.deepEqual(nextOf({ kind: "送检" }, "已检测"), []);
  assert.equal(prefixOf("送检"), "IN-");
  const states = new Set([
    ...stepsOf({ kind: "送检" }),
    ...stepsOf({ kind: "送检", status: "退回中" }),
    "已拒收",
    "已取消",
  ]);
  assert.equal(states.size, 9);
  assert.ok(!states.has("已签收"));
});

test("B1 状态机：采样与旧调拨保持原口径（回归锁）", () => {
  assert.equal(stepsOf({ kind: "采样", trip: "双向" }).length, 8);
  assert.equal(prefixOf("采样"), "TK-");
  assert.deepEqual(stepsOf({ kind: "调拨", direct: true }), ["待签收", "已签收"]);
  assert.deepEqual(nextOf({ kind: "调拨", direct: true }, "待签收"), [
    "已签收",
    "已拒收",
    "退回中",
    "已取消",
  ]);
});

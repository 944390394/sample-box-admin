import assert from "node:assert/strict";
import test from "node:test";

import { mergeLabels, publicLabels } from "../src/settings/labelConfig.js";

test("没配置时返回默认名称", () => {
  const labels = publicLabels(null);
  assert.equal(labels.life.未使用, "未使用");
  assert.equal(labels.kind.boot, "上电");
  assert.equal(labels.online.waitEvent, "等待事件上报");
});

test("只存改过的名称，空值和默认值回到默认", () => {
  const next = mergeLabels(
    { dialect: "sqlite" },
    {
      life: { 未使用: " 空闲 ", 在途: "", 停用: "停用" },
      kind: { timer: "心跳" },
      nope: { a: "b" },
    }
  );
  assert.equal(next.dialect, "sqlite");
  assert.deepEqual(next.labels, { life: { 未使用: "空闲" }, kind: { timer: "心跳" } });
  const labels = publicLabels(next);
  assert.equal(labels.life.未使用, "空闲");
  assert.equal(labels.life.在途, "在途");
  assert.equal(labels.kind.timer, "心跳");
  assert.equal("nope" in labels, false);
});

test("过长或不是文字时拒绝保存", () => {
  assert.throws(() => mergeLabels({}, { life: { 在途: "一二三四五六七八九" } }), /最多 8 个字/);
  assert.throws(() => mergeLabels({}, { kind: { boot: 1 } }), /要填文字/);
});

test("配置文件里被手改的超长值读出时回到默认", () => {
  assert.equal(
    publicLabels({ labels: { life: { 停用: "一二三四五六七八九" } } }).life.停用,
    "停用"
  );
});

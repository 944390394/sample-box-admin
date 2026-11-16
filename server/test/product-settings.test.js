import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeProduct,
  passwordMinOf,
  publicBrand,
  publicProduct,
} from "../src/settings/productSettings.js";

test("未配置时给出采样箱默认项，安全密钥留空", () => {
  const visible = publicProduct(undefined);
  assert.equal(visible.policy.reportIntervalSec, 60);
  assert.equal(visible.policy.batteryPercent, 20);
  assert.equal(visible.policy.arrivalRadiusM, 2000);
  assert.equal(visible.brand.name, "智采 · 采样箱");
  assert.equal(visible.map.skSet, false);
  assert.equal(visible.map.sk, "");
  assert.equal(visible.security.passwordMin, 8);
  assert.equal(visible.security.idleMinutes, 30);
});

test("留空的安全密钥不覆盖原值，显式清除才去掉", () => {
  const saved = mergeProduct(undefined, { map: { tk: "abc123", sk: "secret-key" } });
  const kept = mergeProduct(saved, { map: { tk: "abc123", sk: "" } });
  assert.equal(kept.map.sk, "secret-key");
  const cleared = mergeProduct(saved, { map: { clearSk: true } });
  assert.equal(cleared.map.sk, "");
  assert.equal(publicProduct(cleared).map.skSet, false);
});

test("策略超出范围会被拒绝，其它已保存项还在", () => {
  const saved = mergeProduct(undefined, { brand: { name: "智采" } });
  assert.throws(() => mergeProduct(saved, { policy: { reportIntervalSec: 10 } }), /上报间隔/);
  assert.throws(() => mergeProduct(saved, { policy: { batteryPercent: 80 } }), /电量阈值/);
  assert.equal(mergeProduct(saved, { policy: { reportIntervalSec: 300 } }).brand.name, "智采");
});

test("回调地址只接受 http，启用时不能空着", () => {
  assert.throws(() =>
    mergeProduct(undefined, { integration: { webhookEnabled: true, webhookUrl: "" } })
  );
  assert.throws(() =>
    mergeProduct(undefined, { integration: { webhookUrl: "ftp://files.example.com/hook" } })
  );
  const saved = mergeProduct(undefined, {
    integration: { webhookEnabled: true, webhookUrl: "https://ops.example.com/hook" },
  });
  assert.equal(saved.integration.webhookUrl, "https://ops.example.com/hook");
});

test("公开品牌信息不带密钥，密码位数从配置里读", () => {
  const saved = mergeProduct(undefined, { map: { sk: "secret-key" }, brand: { name: "智采" } });
  const brand = publicBrand(saved);
  assert.equal(brand.name, "智采");
  assert.equal(JSON.stringify(brand).includes("secret-key"), false);
  assert.equal(passwordMinOf({ product: saved }), 8);
  assert.equal(passwordMinOf({}), 8);
});

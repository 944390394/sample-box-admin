import assert from "node:assert/strict";
import test from "node:test";

import {
  ackForBox,
  applyBoxSettings,
  currentBoxSettings,
  firmwareAcceptsConfig,
  mergeBoxSettings,
} from "../src/settings/boxConfig.js";

test("1.0.1 仍只回 ok，1.0.2 才带上周期和充电限制", () => {
  applyBoxSettings({
    box: { reportPeriodSec: 60, reportOnlyWhenCharging: true, batteryReserve: 20 },
  });
  assert.equal(ackForBox({ firmware: "1.0.1" }), "ok\n");
  assert.equal(ackForBox({ firmware: "" }), "ok\n");
  assert.equal(ackForBox({ firmware: "1.0.2" }), "ok p=60 c=1\n");
  assert.equal(firmwareAcceptsConfig("1.0.2"), true);
  assert.equal(firmwareAcceptsConfig("1.0.1"), false);
});

test("周期和预留超出范围时拒绝保存", () => {
  assert.throws(() => mergeBoxSettings({}, { reportPeriodSec: 1, batteryReserve: 20 }), /上报周期/);
  assert.throws(
    () => mergeBoxSettings({}, { reportPeriodSec: 60, batteryReserve: 90 }),
    /电量预留/
  );
  const next = mergeBoxSettings(
    { dialect: "sqlite" },
    {
      reportPeriodSec: 30,
      reportOnlyWhenCharging: false,
      batteryReserve: 15,
    }
  );
  assert.equal(next.dialect, "sqlite");
  assert.deepEqual(next.box, {
    reportPeriodSec: 30,
    reportOnlyWhenCharging: false,
    batteryReserve: 15,
    arriveRadiusM: 2000,
  });
  assert.throws(
    () => mergeBoxSettings({}, { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 10 }),
    /到达半径/
  );
  assert.equal(
    mergeBoxSettings({ box: { arriveRadiusM: 800 } }, { reportPeriodSec: 60, batteryReserve: 20 })
      .box.arriveRadiusM,
    800
  );
  applyBoxSettings(next);
  assert.equal(currentBoxSettings().batteryReserve, 15);
  assert.equal(ackForBox({ firmware: "1.0.2" }), "ok p=30 c=0\n");
});

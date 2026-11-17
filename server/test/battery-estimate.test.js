import assert from "node:assert/strict";
import test from "node:test";
import { BoxState } from "../src/domain/BoxState.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { bucketBattery } from "../src/domain/BatterySeries.js";

test("部分放电到 3.60 V 后回充，历史和实时都不能将该点校准成零", () => {
  const model = { cycles: [{ full: 4160, empty: 3600 }] };
  const latest = estimateBattery(model, 3600, 20, 0);
  const [history] = bucketBattery(
    [{ received_at: "2026-11-09 13:34:27", summary: "3.50 V", stmMv: "3600", charge: 0 }],
    360,
    { model }
  );
  assert.equal(history.mv, 3600);
  assert.equal(history.percent, 12);
  assert.equal(history.percent, latest.soc);
  assert.equal(latest.learned, false);
});

test("STM 电压优先，缺状态的后续读数不能和旧百分比拼成一组", () => {
  const parser = new UplinkParser();
  const parse = (uart, vbat) =>
    parser.parse(JSON.stringify({ imei: "864317080992517", uart, vbat }));
  const box = new BoxState({});
  box.apply(parse("why=timer,bat=3900,chg=0", 3500), new Date());
  box.apply(parse("why=unknown", 3500), new Date());
  assert.equal(box.batteryMv, 3900);
  assert.equal(box.battery, "3.90 V");
});

import {
  chargingPercent,
  estimateBattery,
  observeBattery,
  voltagePercent,
} from "../src/domain/BatteryEstimate.js";

test("默认曲线把 4.2 V 当成满电，3.3 V 当空", () => {
  assert.equal(voltagePercent(4200), 100);
  assert.equal(voltagePercent(3300), 0);
  assert.ok(voltagePercent(3900) > voltagePercent(3700));
});

test("完整充放电之后，电量按这几次的高低电压对齐，并扣掉预留", () => {
  let model = observeBattery(null, 4180, 2);
  model = observeBattery(model, 3600, 0);
  model = observeBattery(model, 3460, 0);
  model = observeBattery(model, 3900, 1);
  assert.equal(model.cycles.length, 1);
  assert.equal(model.cycles[0].full, 4180);
  assert.equal(model.cycles[0].empty, 3460);

  const estimate = estimateBattery(model, 4180, 20);
  assert.equal(estimate.learned, true);
  assert.equal(estimate.soc, 100);
  assert.equal(estimate.usable, 100);
  assert.equal(estimate.reserve, 20);

  const low = estimateBattery(model, 3460, 20);
  assert.equal(low.soc, 0);
  assert.equal(low.usable, 0);

  const shallow = observeBattery(observeBattery(null, 4100, 2), 4000, 0);
  const ignored = observeBattery(shallow, 4050, 1);
  assert.equal(ignored.cycles.length, 0);
});

test("充电中先扣掉端电压抬高，同样电压低于静置曲线，也不记满", () => {
  assert.ok(chargingPercent(4120) < voltagePercent(4120));
  const charging = estimateBattery(null, 4120, 20, 1);
  const resting = estimateBattery(null, 4120, 20, 0);
  assert.equal(charging.basis, "charge");
  assert.equal(charging.soc, 76);
  assert.ok(charging.soc < resting.soc);
  assert.ok(charging.usable < resting.usable);

  const topped = estimateBattery(null, 4200, 20, 1);
  // 到了恒压段（4.18 V 以上）不再卡在 85%，按电压走但最多 92%，等充满指示才到 100
  assert.equal(topped.soc, 87);
  assert.ok(topped.usable < 100);
});

test("充满后 4.16 V 记满，往下按电压平滑降，4.10 V 接上静置曲线", () => {
  const top = estimateBattery(null, 4160, 20, 2);
  assert.equal(top.soc, 100);
  assert.equal(top.basis, "full");

  const model = observeBattery(null, 4160, 2);
  assert.equal(estimateBattery(model, 4140, 20, 1).soc, 97);
  assert.equal(estimateBattery(model, 4110, 20, 1).soc, 92);
  assert.equal(estimateBattery(model, 4100, 20, 1).soc, 90);
  const dipped = observeBattery(model, 4080, 1);
  assert.equal(dipped.phase, "full");
  assert.equal(estimateBattery(dipped, 4080, 20, 1).soc, 87);
});

test("报过充满后补电，电压还在高位就保持充满", () => {
  let model = observeBattery(null, 4131, 2);
  model = observeBattery(model, 4165, 1);
  assert.equal(model.phase, "full");
  const topping = estimateBattery(model, 4165, 20, 1);
  assert.equal(topping.soc, 100);
  assert.equal(topping.basis, "full");

  model = observeBattery(model, 4132, 0);
  assert.equal(model.phase, "full");
  assert.equal(estimateBattery(model, 4132, 20, 0).soc, 95);
});

test("设备上报的学习端点优先于默认充满段", () => {
  const model = {
    cycles: [{ full: 4100, empty: 3400 }],
    phase: "full",
    deviceCycles: 3,
  };
  const full = estimateBattery(model, 4100, 20, 1);
  assert.equal(full.basis, "learned");
  assert.equal(full.soc, 100);
  assert.equal(full.cycles, 3);
  const empty = estimateBattery(model, 3400, 20, 0);
  assert.equal(empty.soc, 0);
});

test("离开充电器并且电压掉下来，才结束充满", () => {
  let model = observeBattery(null, 4131, 2);
  model = observeBattery(model, 4000, 0);
  assert.equal(model.phase, "down");
  const resting = estimateBattery(model, 4000, 20, 0);
  assert.notEqual(resting.basis, "full");
  assert.ok(resting.soc < 100);
});

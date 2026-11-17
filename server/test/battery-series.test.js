import assert from "node:assert/strict";
import test from "node:test";

import { bucketBattery, readMillivolts } from "../src/domain/BatterySeries.js";
import { BoxState } from "../src/domain/BoxState.js";

test("按当时设备周期标记缺报，保留真正的长空档", () => {
  const rows = ["00:00", "00:12", "00:30"].map((t) => ({
    received_at: "2026-11-07 " + t + ":00",
    summary: "4.09 V",
    periodSec: 300,
    charge: 0,
  }));
  const result = bucketBattery(rows);
  assert.deepEqual(
    result.filter((r) => r.gap).map((r) => r.time),
    ["2026-11-07 00:30:00"]
  );
  assert.equal(
    bucketBattery(rows.map((r) => ({ ...r, chargeOnly: true }))).some((r) => r.gap),
    false
  );
});

test("七天视图的点保留同一条报告的时间、电压、状态和电量", () => {
  const rows = ["3.70", "3.80", "4.16"].map((v, i) => ({
    received_at: "2026-11-07 09:00:0" + i,
    summary: v + " V",
    charge: i === 2 ? 2 : 0,
  }));
  const [p] = bucketBattery(rows, 1);
  assert.deepEqual(p, { time: rows[2].received_at, mv: 4160, percent: 100, charge: 2 });
});

test("从摘要里读出毫伏，异常数字丢掉", () => {
  assert.equal(readMillivolts("定时上报 · seq 1 · 3.98 V · 开着"), 3980);
  assert.equal(readMillivolts("定时上报"), null);
  assert.equal(readMillivolts("电压 1.20 V"), null);
});

test("充满之后沿电压从 4.16 V 降到 4.10 V，不再整段 100 再跳水", () => {
  const resting = bucketBattery([
    { received_at: "2026-10-22 09:30:00", summary: "定时上报 · 4.13 V" },
  ]);
  assert.equal(resting[0].percent, 93);

  const full = bucketBattery([
    { received_at: "2026-10-22 09:29:00", summary: "充电上报 · 4.16 V", charge: 2 },
    { received_at: "2026-10-22 09:30:00", summary: "定时上报 · 4.14 V", charge: 1 },
    { received_at: "2026-10-22 09:31:00", summary: "定时上报 · 4.11 V", charge: 1 },
    { received_at: "2026-10-22 09:32:00", summary: "定时上报 · 4.10 V", charge: 1 },
    { received_at: "2026-10-22 09:33:00", summary: "定时上报 · 4.08 V", charge: 1 },
  ]);
  assert.equal(full[0].percent, 100);
  assert.equal(full[0].charge, 2);
  assert.equal(full[1].charge, 1);
  assert.equal(resting[0].charge, null);
  assert.equal(full[1].percent, 97);
  assert.equal(full[2].percent, 92);
  assert.equal(full[3].percent, 90);
  assert.equal(full[4].percent, 87);
  assert.ok(full[2].percent - full[3].percent <= 5);
  assert.ok(full[3].percent - full[4].percent <= 5);
});

test("点数太多时按段取平均", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    received_at: `2026-10-22 00:${String(index).padStart(2, "0")}:00`,
    summary: `定时 · ${(3.5 + index * 0.01).toFixed(2)} V`,
  }));
  const points = bucketBattery(rows, 4);
  assert.equal(points.length, 4);
  assert.equal(points[0].mv > 2500, true);
  assert.equal(typeof points[0].percent, "number");
});

test("曲线点带上充电状态，合并后取这一段最后的充电状态；间隔太大时插空点断开", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    received_at: `2026-10-27 1${index}:00:00`,
    summary: "定时 · 3.70 V",
    charge: index < 4 ? 0 : 1,
  }));
  const points = bucketBattery(rows, 2);
  assert.deepEqual(
    points.filter((item) => !item.gap).map((item) => item.charge),
    [0, 1]
  );
  // 两段相隔 4 小时，远超 3 个上报周期：中间有一个空点
  assert.equal(points.filter((item) => item.gap).length, 1);
});

test("补传的点按设备时间落位；每段取中位数，发射瞬间的低电压不会被抽中", () => {
  const rows = [
    {
      received_at: "2026-11-03 10:00:00",
      device_time: "2026-11-03 10:00:00",
      summary: "定时 · 3.90 V",
      charge: 0,
    },
    // 9:00 发生、10:01 才补传上来
    {
      received_at: "2026-11-03 10:01:00",
      device_time: "2026-11-03 09:00:00",
      summary: "定时 · 3.95 V",
      charge: 0,
    },
  ];
  const ordered = bucketBattery(rows).filter((item) => !item.gap);
  assert.deepEqual(
    ordered.map((item) => item.time),
    ["2026-11-03 09:00:00", "2026-11-03 10:00:00"]
  );

  const dense = ["3.90", "3.90", "3.60", "3.90", "3.90", "3.90"].map((v, index) => ({
    received_at: `2026-11-03 11:00:0${index}`,
    summary: `定时 · ${v} V`,
    charge: 0,
  }));
  const [only] = bucketBattery(dense, 1);
  assert.equal(only.mv, 3900);
});

test("离开充电才开始计使用时间，再次充电清掉", () => {
  const box = new BoxState({
    id: "BOX-001",
    imei: "1",
    iccid: "",
    imsi: "",
    firmware: "",
    org: "",
    owner: "",
    life: "待激活",
    alert: "",
    battery: "",
    csq: 0,
    last: "",
    lbs: "",
    lbsLng: null,
    lbsLat: null,
    gps: "",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    charge: 1,
    activateStep: "等待激活",
    poweredAt: "",
  });
  const uplink = (charge, vbat) => ({
    charge,
    vbat,
    seq: null,
    hasLbs: () => false,
    hasGps: () => false,
  });
  const at = new Date("2026-10-22T00:10:00");
  box.apply(uplink(0, 4000), at);
  assert.match(box.unchargedAt, /^2026-10-22 00:10:00/);
  box.apply(uplink(1, 4100), new Date("2026-10-22T01:00:00"));
  assert.equal(box.unchargedAt, "");
});

test("7 天每分钟都有上报：合并成 360 段后曲线是连着的，不会每两点之间都断开", () => {
  const start = Date.parse("2026-10-29T23:00:00");
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const rows = Array.from({ length: 7 * 24 * 60 }, (_, index) => ({
    received_at: stamp(start + index * 60000),
    summary: `定时 · ${(4.1 - index / 50000).toFixed(2)} V`,
    charge: 0,
  }));
  // 中间停报 2 小时：只在这里断开一次
  rows.splice(3000, 120);
  const points = bucketBattery(rows, 360, { periodSec: 60 });
  assert.ok(points.filter((item) => !item.gap).length >= 300);
  assert.equal(points.filter((item) => item.gap).length, 1);
});

test("SQLite 里 raw 列存的是 gzip 字节：读得出原文和充电状态（以前转成「31,139,…」读不出）", async () => {
  const { gzipSync } = await import("node:zlib");
  const { chargeFromRaw, uplinkText } = await import("../src/domain/BatterySeries.js");
  const text = JSON.stringify({ imei: "1", uart: "why=timer,bat=3700,chg=1,lid=0" });
  const packed = gzipSync(Buffer.from(text, "utf8"));
  assert.equal(uplinkText({ raw: packed }), text);
  assert.equal(uplinkText({ raw: new Uint8Array(packed) }), text);
  assert.equal(uplinkText({ raw: "", raw_gz: packed }), text);
  assert.equal(uplinkText({ raw: text }), text);
  assert.equal(chargeFromRaw(uplinkText({ raw: new Uint8Array(packed) })), 1);
});

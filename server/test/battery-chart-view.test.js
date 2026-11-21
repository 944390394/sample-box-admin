/**
 * 估算总电量图切换卡顿修复（前端纯逻辑）回归。
 * 被测＝src/utils/batteryChart.ts（node type-stripping 直导 .ts，R14 duration.ts 先例），
 * 与 BatteryCurve.vue 共用同一套函数。
 * 钉死：1) presetRange 四档跨度与秒级格式；2) chargeBands 充电区间边界保留/gap 截断/尾段闭合/孤立点；
 *       3) createSeriesCache LRU 淘汰/get 提升热度/clear；4) onCharge 三态。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeBands,
  createSeriesCache,
  onCharge,
  presetRange,
  stamp,
} from "../../src/utils/batteryChart.ts";

const ms = (time) => Date.parse(time.replace(" ", "T"));
const point = (time, charge, gap = false) => ({
  time,
  mv: gap ? null : 3900,
  percent: gap ? null : 50,
  charge,
  gap,
});

test("presetRange 四档跨度正确，格式 YYYY-MM-DD HH:mm:ss", () => {
  const end = Date.parse("2026-11-21T12:00:00");
  for (const [key, hours] of [
    ["1h", 1],
    ["6h", 6],
    ["24h", 24],
    ["7d", 168],
  ]) {
    const [from, to] = presetRange(key, end);
    assert.match(from, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(to, stamp(new Date(end)));
    assert.equal(ms(to) - ms(from), hours * 3600000);
  }
  // 未知键回落 7 天（与组件旧行为一致）
  const [from, to] = presetRange("xx", end);
  assert.equal(ms(to) - ms(from), 168 * 3600000);
});

test("chargeBands：连续充电段画一个区间，起点段内首个充电点、终点段后首个非充电点（原语义保持）", () => {
  const points = [
    point("2026-11-21 00:00:00", 0),
    point("2026-11-21 01:00:00", 1),
    point("2026-11-21 02:00:00", 2),
    point("2026-11-21 03:00:00", 0),
  ];
  assert.deepEqual(chargeBands(points), [
    [{ xAxis: ms("2026-11-21 01:00:00") }, { xAxis: ms("2026-11-21 03:00:00") }],
  ]);
});

test("chargeBands：空点截断区间，终点落在空点前一个真实点，不把断线空档涂绿", () => {
  const points = [
    point("2026-11-21 00:00:00", 1),
    point("2026-11-21 01:00:00", 1),
    point("2026-11-21 05:00:00", null, true),
    point("2026-11-21 06:00:00", 1),
    point("2026-11-21 07:00:00", 0),
  ];
  assert.deepEqual(chargeBands(points), [
    [{ xAxis: ms("2026-11-21 00:00:00") }, { xAxis: ms("2026-11-21 01:00:00") }],
    [{ xAxis: ms("2026-11-21 06:00:00") }, { xAxis: ms("2026-11-21 07:00:00") }],
  ]);
});

test("chargeBands：充电持续到最后一个点时尾段闭合；全程未充电无区间", () => {
  const tail = [point("2026-11-21 00:00:00", 0), point("2026-11-21 01:00:00", 2)];
  assert.deepEqual(chargeBands(tail), [
    [{ xAxis: ms("2026-11-21 01:00:00") }, { xAxis: ms("2026-11-21 01:00:00") }],
  ]);
  assert.deepEqual(
    chargeBands([point("2026-11-21 00:00:00", 0), point("2026-11-21 01:00:00", null)]),
    []
  );
  assert.deepEqual(chargeBands([]), []);
});

test("chargeBands：分桶合并后的代表点序列仍按充电态边界分段（多段交替）", () => {
  const points = [
    point("2026-11-21 00:00:00", 0),
    point("2026-11-21 00:28:00", 1),
    point("2026-11-21 00:56:00", 2),
    point("2026-11-21 01:24:00", 0),
    point("2026-11-21 01:52:00", 1),
    point("2026-11-21 02:20:00", 0),
  ];
  const bands = chargeBands(points);
  assert.equal(bands.length, 2);
  assert.equal(bands[0][0].xAxis, ms("2026-11-21 00:28:00"));
  assert.equal(bands[0][1].xAxis, ms("2026-11-21 01:24:00"));
  assert.equal(bands[1][0].xAxis, ms("2026-11-21 01:52:00"));
  assert.equal(bands[1][1].xAxis, ms("2026-11-21 02:20:00"));
});

test("createSeriesCache：LRU 淘汰最久未用，get 命中提升热度，clear 清空", () => {
  const cache = createSeriesCache(2);
  cache.set("1h", [1]);
  cache.set("7d", [7]);
  assert.equal(cache.size, 2);
  // 读 1h → 7d 变最久未用；写入 24h 应淘汰 7d
  assert.deepEqual(cache.get("1h"), [1]);
  cache.set("24h", [24]);
  assert.equal(cache.get("7d"), undefined);
  assert.deepEqual(cache.get("24h"), [24]);
  assert.deepEqual(cache.get("1h"), [1]);
  // 同键覆盖不增计数
  cache.set("1h", [11]);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get("1h"), [11]);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("1h"), undefined);
});

test("onCharge：充电中/已充满为真，未充电/未知为假", () => {
  assert.equal(onCharge({ charge: 1 }), true);
  assert.equal(onCharge({ charge: 2 }), true);
  assert.equal(onCharge({ charge: 0 }), false);
  assert.equal(onCharge({ charge: null }), false);
  assert.equal(onCharge(undefined), false);
});

/**
 * 位置时效回归：GPS 有坐标但无定位时间（老数据 gps_info 空）不得装新鲜。
 * 被测＝src/utils/position.ts boxPositions（node type-stripping 直导 .ts）。
 * 钉死：1) gps 无 at + lbs 有 at → gpsStale/gpsTimeUnknown 真、current 信基站；
 *       2) gps 无 at 且无 lbs → current 仍 GPS 但 gpsTimeUnknown 真（界面写「无定位时间/旧」）；
 *       3) 正常 gps 新于 lbs → current GPS、gpsTimeUnknown 假（不回归）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// position.ts 沿用 bundler 风格无扩展名导入（./time）；node 直导 .ts 时补扩展名解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./time" && (context.parentURL || "").endsWith("/position.ts")) {
      return nextResolve("./time.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { boxPositions } = await import("../../src/utils/position.ts");

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace("T", " ").slice(0, 19);

test("GPS 无时间记录＋基站有时间：信基站并标 stale/unknown", () => {
  const p = boxPositions({
    gpsLng: 114.156,
    gpsLat: 22.651,
    gpsAddress: "广东省深圳市龙岗区平湖街道浦田路15号",
    gpsInfo: null,
    lbsLng: 114.116,
    lbsLat: 22.679,
    lbsAt: iso(60_000),
  });
  assert.equal(p.gpsTimeUnknown, true);
  assert.equal(p.gpsStale, true);
  assert.equal(p.current.source, "基站");
  assert.equal(p.lastGpsAt, "");
});

test("GPS 无时间记录且无基站：保留 GPS 但标 unknown，不装新鲜", () => {
  const p = boxPositions({ gpsLng: 114.156, gpsLat: 22.651, gpsInfo: null });
  assert.equal(p.gpsTimeUnknown, true);
  assert.equal(p.current.source, "GPS");
  assert.equal(p.current.at, "");
});

test("GPS 有时间且新于基站：仍信 GPS，不误标 unknown", () => {
  const p = boxPositions({
    gpsLng: 114.156,
    gpsLat: 22.651,
    gpsInfo: { at: iso(60_000) },
    lbsLng: 114.116,
    lbsLat: 22.679,
    lbsAt: iso(3_600_000),
  });
  assert.equal(p.gpsTimeUnknown, false);
  assert.equal(p.gpsStale, false);
  assert.equal(p.current.source, "GPS");
});

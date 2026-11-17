import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { BoxState } from "../src/domain/BoxState.js";
import { Uplink } from "../src/domain/Uplink.js";
import { boxPosition } from "../src/geo/place.js";
import { boxDistances } from "../src/settings/taskPlaces.js";

const GPS = { gps_lng: 114.1169, gps_lat: 22.6784 };
const LBS = { lbs_lng: 114.1177, lbs_lat: 22.6747 };

test("当前位置：基站比最后一次 GPS 新 10 分钟以上就用基站，否则用 GPS", () => {
  // GPS 三天前、基站刚刚：用基站，并带上最后一次 GPS 的时间
  const stale = boxPosition({
    ...GPS,
    ...LBS,
    gps_info: JSON.stringify({ at: "2026-11-02 19:25:28" }),
    lbs_at: "2026-11-05 13:18:34",
  });
  assert.equal(stale.source, "基站");
  assert.equal(stale.at, "2026-11-05 13:18:34");
  assert.equal(stale.gpsAt, "2026-11-02 19:25:28");
  // 相差不到 10 分钟：还是 GPS
  const fresh = boxPosition({
    ...GPS,
    ...LBS,
    gps_info: { at: "2026-11-05 13:10:00" },
    lbs_at: "2026-11-05 13:18:34",
  });
  assert.equal(fresh.source, "GPS");
  assert.equal(fresh.at, "2026-11-05 13:10:00");
  // 不知道时间（老数据）：照旧有 GPS 用 GPS
  assert.equal(boxPosition({ ...GPS, ...LBS }).source, "GPS");
  // BoxState 的字段名也认
  assert.equal(
    boxPosition({
      gpsLng: 114.1,
      gpsLat: 22.6,
      lbsLng: 114.2,
      lbsLat: 22.7,
      gpsInfo: { at: "2026-11-01 08:00:00" },
      lbsAt: "2026-11-05 08:00:00",
    }).source,
    "基站"
  );
  assert.equal(boxPosition({ ...LBS, lbs_at: "2026-11-05 08:00:00" }).at, "2026-11-05 08:00:00");
  assert.equal(boxPosition({}), null);
});

test("基站位置记下更新时间，只在这次上报带了基站坐标时更新", () => {
  const box = BoxState.createPending(
    "864317080992517",
    new Uplink({ imei: "864317080992517" }),
    new Date("2026-11-05T08:00:00")
  );
  box.apply(
    new Uplink({ imei: "864317080992517", lbsLng: 114.1, lbsLat: 22.6 }),
    new Date("2026-11-05T09:00:00")
  );
  assert.match(box.toJSON().lbsAt, /^2026-11-05 09:00:00/);
  box.apply(new Uplink({ imei: "864317080992517" }), new Date("2026-11-05T10:00:00"));
  assert.match(box.toJSON().lbsAt, /^2026-11-05 09:00:00/);
  assert.equal(BoxState.fromRow(box.toRow()).lbsAt, box.lbsAt);
});

test("任务里箱子的距离按新鲜的位置算；迁移 040 给老数据补上基站时间", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "position-fresh-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await db.run(
      "INSERT INTO sample_box (id, name, imei, org, life, activate_step, last_report_at, gps_lng, gps_lat, lbs_lng, lbs_lat, gps_info, lbs_at) VALUES ('B1', 'BOX-1', 'B1', '总公司', '在途', '已确认', '2026-11-05 13:18:34', 113.26, 23.13, 114.1177, 22.6747, ?, '2026-11-05 13:18:34')",
      [JSON.stringify({ at: "2026-11-02 19:25:28" })]
    );
    const [box] = await boxDistances(db, ["B1"], { lng: 114.1177, lat: 22.6747, radiusM: 2000 });
    assert.equal(box.position.source, "基站");
    assert.equal(box.near, true);

    await db.run(
      "INSERT INTO sample_box (id, name, imei, org, life, activate_step, last_report_at, lbs_lng, lbs_lat) VALUES ('B2', 'BOX-2', 'B2', '总公司', '未使用', '已确认', '2026-11-04 10:00:00', 114.1, 22.6)"
    );
    const { up } = await import("../migrations/040_box_lbs_at.js");
    await up(db);
    assert.equal(
      (await db.get("SELECT lbs_at FROM sample_box WHERE id = 'B2'")).lbs_at,
      "2026-11-04 10:00:00"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

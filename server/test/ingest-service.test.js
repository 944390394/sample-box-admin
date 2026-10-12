import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { FixedClock, formatTimestamp } from "../src/domain/Clock.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { MemoryBoxStore } from "../src/store/MemoryBoxStore.js";
import { RealtimeHub } from "../src/transport/RealtimeHub.js";
import { packet } from "./fixture.js";

function createIngest() {
  const when = new Date(2026, 8, 28, 17, 11, 27, 128);
  const boxes = new MemoryBoxStore();
  const cache = new MemoryStateCache();
  const hub = new RealtimeHub();
  const seen = [];
  hub.subscribe((box) => seen.push(box.id));
  const ingest = new IngestService({
    boxes,
    cache,
    hub,
    clock: new FixedClock(when),
    parser: new UplinkParser(),
  });
  return { ingest, boxes, cache, seen, when };
}

test("未知设备上电后成为待激活箱子，日志带服务器时间戳和原始报文", async () => {
  const { ingest, boxes, cache, seen, when } = createIngest();
  const raw = packet({
    uart: "why=boot,aa55=0",
    imei: "864317081000105",
    iccid: "898608911026D0280105",
  });
  const { box, record } = await ingest.accept(raw);
  assert.equal(box.id, "BOX-001");
  assert.equal(box.life, "待激活");
  assert.equal(box.org, "总公司");
  assert.equal(box.activateStep, "等待激活");
  assert.equal(record.receivedAt, formatTimestamp(when));
  assert.match(record.receivedAt, /\.128$/);
  assert.equal(record.raw, raw);
  assert.equal(record.deviceTime, "2026-09-28 17:11:27");
  assert.deepEqual(seen, ["BOX-001"]);
  assert.equal((await cache.get("BOX-001")).imei, "864317081000105");
  assert.equal((await boxes.listLogs("BOX-001"))[0].raw, raw);
});

test("没有 GPS 时保留上一次的 GPS，基站仍单独更新", async () => {
  const { ingest } = createIngest();
  const imei = "864317080991774";
  await ingest.accept(
    packet({
      imei,
      uart: "why=timer,aa55=0",
      gpsfix: 1,
      lng: "120.1551000",
      lat: "030.2741000",
      lbslng: "120.1500000",
      lbslat: "030.2800000",
    })
  );
  const { box } = await ingest.accept(
    packet({
      imei,
      uart: "why=timer,aa55=0",
      gpsfix: 0,
      lbslng: "120.1600000",
      lbslat: "030.2900000",
    })
  );
  assert.equal(box.gpsLng, Number("120.1551000"));
  assert.equal(box.gpsLat, Number("030.2741000"));
  assert.equal(box.lbsLng, Number("120.1600000"));
  assert.equal(box.lbsLat, Number("030.2900000"));
  assert.equal(box.life, "待激活");
});

test("同一台设备并发上报只保留一个箱号", async () => {
  const { ingest, boxes } = createIngest();
  const imei = "864317081000105";
  await Promise.all([
    ingest.accept(packet({ imei, uart: "why=boot,aa55=0" })),
    ingest.accept(packet({ imei, uart: "why=timer,aa55=0", csq: 8 })),
  ]);
  const rows = await boxes.list();
  assert.equal(rows.length, 1);
  assert.equal((await boxes.listLogs(rows[0].id)).length, 2);
});

test("并发上电不会分配到重复箱号", async () => {
  const { ingest, boxes } = createIngest();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      ingest.accept(
        packet({ imei: `864317081100${String(index).padStart(3, "0")}`, uart: "why=boot,aa55=0" })
      )
    )
  );
  const ids = (await boxes.list()).map((box) => box.id);
  assert.equal(new Set(ids).size, 20);
});

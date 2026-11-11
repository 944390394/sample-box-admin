import assert from "node:assert/strict";
import test from "node:test";

import { UplinkRecord } from "../src/domain/UplinkRecord.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { UplinkBatch } from "../src/store/UplinkBatch.js";
import { decompressRaw } from "../src/store/rawCodec.js";

test("上报原文压缩后批量插入，列表语句不读原文", async () => {
  const calls = [];
  const batch = new UplinkBatch(
    {
      async run(sql, params) {
        calls.push({ sql, params });
      },
    },
    { mode: "raw", size: 10, waitMs: 60_000 }
  );
  const records = [1, 2, 3].map(
    (index) =>
      new UplinkRecord({
        boxId: "BOX-001",
        imei: "864317080992517",
        receivedAt: `2026-10-01 00:00:0${index}.000`,
        deviceTime: "",
        kind: "timer",
        summary: "定时上报",
        raw: `{"n":${index},"marker":"PLAINTEXT-MARKER"}`,
        lbsLng: null,
        lbsLat: null,
        gpsLng: null,
        gpsLat: null,
      })
  );
  for (const record of records) batch.add(record);
  await batch.flush();
  assert.equal(calls.length, 1);
  assert.equal((calls[0].sql.match(/\(\?/g) || []).length, 3);
  assert.equal(calls[0].sql.includes("PLAINTEXT-MARKER"), false);
  assert.equal(
    calls[0].params.some((item) => typeof item === "string" && item.includes("PLAINTEXT-MARKER")),
    false
  );
  const blobs = calls[0].params.filter((item) => Buffer.isBuffer(item));
  assert.equal(blobs.length, 3);
  assert.equal(blobs[0][0], 0x1f);
  assert.equal(blobs[0][1], 0x8b);
  assert.equal(decompressRaw(blobs[0]), records[0].raw);

  const listed = [];
  const store = new SqlBoxStore({
    dialect: "sqlite",
    async all(sql) {
      listed.push(sql);
      return [];
    },
    async run() {},
    async get() {
      return undefined;
    },
  });
  await store.listLogs("BOX-001", {
    from: "2026-10-01 00:00:00.000",
    to: "2026-10-07 00:00:00.000",
  });
  assert.match(listed[0], /FROM sample_uplink/);
  assert.equal(/\braw\b/.test(listed[0]), false);
});

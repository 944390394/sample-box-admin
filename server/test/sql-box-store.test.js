import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { mysqlStatements } from "../migrations/002_sample.js";
import { FixedClock } from "../src/domain/Clock.js";
import { BoxState } from "../src/domain/BoxState.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { IngestService } from "../src/service/IngestService.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { RealtimeHub } from "../src/transport/RealtimeHub.js";
import { packet } from "./fixture.js";

test("MySQL 上报表按月分区", () => {
  const ddl = mysqlStatements.find((sql) => sql.includes("sample_uplink"));
  assert.match(ddl, /PARTITION BY RANGE \(TO_DAYS\(received_at\)\)/);
  assert.match(ddl, /PARTITION pmax VALUES LESS THAN MAXVALUE/);
});

test("MySQL 写入把 IMEI 放在参数里", async () => {
  const calls = [];
  const store = new SqlBoxStore({
    dialect: "mysql",
    async run(sql, params) {
      calls.push({ sql, params });
    },
  });
  const box = new BoxState({
    id: "BOX-001",
    imei: "864317080992517' OR '1",
    iccid: "",
    imsi: "",
    firmware: "",
    org: "总公司",
    owner: "—",
    life: "待激活",
    alert: "",
    battery: "3.76 V",
    csq: 19,
    last: "",
    lbs: "",
    lbsLng: null,
    lbsLat: null,
    gps: "未定位",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    activateStep: "等待激活",
    poweredAt: "",
  });
  await store.save(box);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(calls[0].sql.includes(box.imei), false);
  assert.ok(calls[0].params.includes(box.imei));
});

test("SQLite 入库后能按箱号读回原始报文", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    const boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 8, 28, 17, 11, 27, 128)),
      parser: new UplinkParser(),
    });
    const raw = packet({
      uart: "why=boot,aa55=0,lbs=now,lng=114.1172010,lat=022.6790730",
      lbslng: "114.1172010",
      lbslat: "022.6790730",
    });
    await ingest.accept(raw);
    const box = await boxes.findByImei("864317080992517");
    const [log] = await boxes.listLogs(box.id);
    assert.equal(box.life, "待激活");
    assert.equal(box.lbsLng, Number("114.1172010"));
    assert.equal(log.raw, raw);
    assert.match(log.receivedAt, /2026-09-28 17:11:27\.128/);
    const again = await ingest.accept(packet({ uart: "why=timer,aa55=0", csq: 12 }));
    assert.equal(again.box.id, box.id);
    assert.equal(again.box.csq, 12);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("事务失败时写入一起撤销，并发事务都能留下", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-tx-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  try {
    await db.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO note (body) VALUES ('half')");
        throw new Error("boom");
      }),
      /boom/
    );
    const row = await db.get("SELECT COUNT(*) AS total FROM note");
    assert.equal(Number(row.total), 0);
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO note (body) VALUES ('a')");
      }),
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO note (body) VALUES ('b')");
      }),
    ]);
    const saved = await db.all("SELECT body FROM note ORDER BY body");
    assert.deepEqual(
      saved.map((item) => item.body),
      ["a", "b"]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { gzipSync } from "node:zlib";

import { replayFaces } from "../migrations/005_box_lid_charge.js";
import { mysqlStatements } from "../migrations/002_sample.js";
import { FixedClock, formatUnixMs } from "../src/domain/Clock.js";
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
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
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
    const page = await boxes.listLogs(box.id, {
      from: "2026-09-28 00:00:00.000",
      to: "2026-09-28 23:59:59.999",
    });
    const log = page.list[0];
    assert.equal(box.life, "待激活");
    assert.equal(box.lbsLng, Number("114.1172010"));
    assert.equal(log.raw, "");
    assert.equal(Object.hasOwn(log.toListJSON(), "raw"), false);
    assert.equal(await boxes.readRaw(box.id, log.id, log.receivedAt), raw);
    const stored = await db.get("SELECT raw FROM sample_uplink WHERE id = ?", [Number(log.id)]);
    const bytes = Buffer.from(stored.raw);
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
    assert.match(log.receivedAt, /2026-09-28 17:11:27\.128/);
    const again = await ingest.accept(packet({ uart: "why=timer,aa55=0", csq: 12 }));
    assert.equal(again.box.id, box.id);
    assert.equal(again.box.csq, 12);
    // 同一秒内的上电和定时都要留下，不能按上报间隔抽成一条。
    const both = await boxes.listLogs(box.id, {
      from: "2026-09-28 00:00:00.000",
      to: "2026-09-28 23:59:59.999",
      limit: 100,
    });
    assert.deepEqual(both.list.map((item) => item.kind).sort(), ["boot", "timer"]);
    for (const item of both.list) {
      assert.equal(Object.hasOwn(item.toListJSON(), "raw"), false);
    }
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("充电和箱盖写入后重读仍在，没带这些字段的下一包不会清掉", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-face-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 21, 14, 31, 50, 187)),
      parser: new UplinkParser(),
    });
    await ingest.accept(
      packet({
        uart: "why=chg,opens=0,lid=1,chg=1,bat=4155,seq=2",
        vbat: 4155,
        time: "2026-10-21 14:31:49",
      })
    );
    let box = await boxes.findByImei("864317080992517");
    assert.equal(box.lid, 1);
    assert.equal(box.charge, 1);
    assert.equal(box.opens, 0);
    assert.equal(box.lastOpen, "");
    const [log] = (
      await boxes.listLogs(box.id, { from: "2000-01-01 00:00:00", to: "2099-12-31 23:59:59" })
    ).list;
    assert.equal(log.kind, "chg");
    assert.equal(log.summary, "充电上报 · seq 2 · 4.16 V · 开着");

    await ingest.accept(
      packet({
        uart: "why=pad,opens=1,lid=0,openage=30,chg=2",
        time: "2026-10-21 00:00:10",
      })
    );
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.opens, 1);
    assert.equal(box.lid, 0);
    assert.equal(box.charge, 2);
    assert.equal(box.lastOpen, "2026-10-20 23:59:40");

    await ingest.accept(packet({ uart: "114.1176646_022.6746896" }));
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.opens, 1);
    assert.equal(box.lid, 0);
    assert.equal(box.charge, 2);
    assert.equal(box.lastOpen, "2026-10-20 23:59:40");
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("开箱报文用 t 记下上次开箱，关箱时间不覆盖它", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-open-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 21, 14, 32, 0, 0)),
      parser: new UplinkParser(),
    });
    await ingest.accept(
      packet({
        uart: "why=pad,opens=1,lid=1,chg=0,t=1792564309000,seq=2",
        time: "1999-01-01 00:00:00",
      })
    );
    let box = await boxes.findByImei("864317080992517");
    assert.equal(box.opens, 1);
    assert.equal(box.lid, 1);
    assert.equal(box.lastOpen, "2026-10-21 14:31:49");
    assert.equal(box.lastOpen, formatUnixMs(1792564309000));
    const [openLog] = (
      await boxes.listLogs(box.id, { from: "2000-01-01 00:00:00", to: "2099-12-31 23:59:59" })
    ).list;
    assert.equal(openLog.summary, "开箱上报 · seq 2 · 3.76 V · 开着");
    assert.equal(openLog.deviceTime, "2026-10-21 14:31:49");

    await ingest.accept(
      packet({
        uart: "why=shut,opens=1,lid=0,openage=0,chg=1,t=1792564369000,seq=3",
        time: "1999-01-01 00:00:00",
      })
    );
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.lid, 0);
    assert.equal(box.opens, 1);
    assert.equal(box.charge, 1);
    assert.equal(box.lastOpen, "2026-10-21 14:31:49");
    const logs = (
      await boxes.listLogs(box.id, { from: "2000-01-01 00:00:00", to: "2099-12-31 23:59:59" })
    ).list;
    const shutLog = logs.find((item) => item.kind === "shut");
    assert.equal(shutLog.summary, "关箱上报 · seq 3 · 3.76 V · 关着");
    assert.equal(shutLog.deviceTime, formatUnixMs(1792564369000));
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("掉电时间写入后，后面的报文不会把它清掉", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-poff-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 21, 14, 32, 0, 0)),
      parser: new UplinkParser(),
    });
    await ingest.accept(
      packet({
        uart: "why=boot,opens=0,lid=0,chg=0,t=1792564309000,poff=1792564000000,seq=1",
        time: "1999-01-01 00:00:00",
      })
    );
    let box = await boxes.findByImei("864317080992517");
    assert.equal(box.lastPowerOff, formatUnixMs(1792564000000));
    assert.equal(box.bootedAt, "2026-10-21 14:31:49");
    await ingest.accept(packet({ uart: "why=timer,opens=0,lid=0,chg=1,t=1792564369000,seq=2" }));
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.lastPowerOff, formatUnixMs(1792564000000));
    assert.equal(box.bootedAt, "2026-10-21 14:31:49");
    assert.equal(box.toJSON().lastPowerOff, box.lastPowerOff);
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("序号变小就按重启重算连续运行，并记下上一包的时间", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-seq-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 21, 22, 45, 1, 0)),
      parser: new UplinkParser(),
    });
    await ingest.accept(
      packet({
        uart: "why=timer,opens=0,lid=1,chg=0,seq=132",
        time: "2026-10-21 22:44:46",
      })
    );
    let box = await boxes.findByImei("864317080992517");
    const seen = box.last;
    assert.equal(box.bootedAt, "");
    assert.equal(box.lastPowerOff, "");
    await ingest.accept(
      packet({
        uart: "why=timer,opens=0,lid=1,chg=0,seq=2",
        time: "2026-10-21 22:45:01",
      })
    );
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.bootedAt, "2026-10-21 22:45:01");
    assert.equal(box.lastPowerOff, seen);
    assert.equal(box.lastSeq, 2);
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("开箱次数复位后接着累加，不把历史次数清掉", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-opens-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 21, 22, 12, 0, 0)),
      parser: new UplinkParser(),
    });
    await ingest.accept(packet({ uart: "why=pad,opens=11,lid=1,seq=20" }));
    await ingest.accept(packet({ uart: "why=timer,opens=0,lid=1,seq=1" }));
    let box = await boxes.findByImei("864317080992517");
    assert.equal(box.opens, 11);
    await ingest.accept(packet({ uart: "why=pad,opens=1,lid=1,seq=2" }));
    box = await boxes.findByImei("864317080992517");
    assert.equal(box.opens, 12);
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("已入库的套娃报文重读后写回充电和箱盖", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-replay-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    const raw = packet({
      imei: "864317080990009",
      uart: JSON.stringify({
        uart: "why=chg,opens=0,lid=1,chg=1,bat=4155,seq=2",
        chg: 1,
        lid: 1,
        opens: 0,
      }),
      chg: 1,
      lid: 1,
      opens: 0,
    });
    await db.run(
      `INSERT INTO sample_box
        (id, imei, org, life, activate_step)
       VALUES ('BOX-009', '864317080990009', '总公司', '待激活', '等待激活')`
    );
    await db.run(
      `INSERT INTO sample_uplink
        (box_id, imei, received_at, device_time, kind, summary, raw)
       VALUES ('BOX-009', '864317080990009', '2026-10-21 14:31:50.187', '2026-10-21 14:31:49', 'unknown', '设备上报', ?)`,
      [raw]
    );
    await replayFaces(db);
    const box = await db.get(
      "SELECT opens, lid, charge, last_open FROM sample_box WHERE id = 'BOX-009'"
    );
    assert.equal(Number(box.opens), 0);
    assert.equal(Number(box.lid), 1);
    assert.equal(Number(box.charge), 1);
    assert.equal(box.last_open, "");
    const log = await db.get("SELECT kind, summary FROM sample_uplink WHERE box_id = 'BOX-009'");
    assert.equal(log.kind, "chg");
    assert.equal(log.summary, "充电上报");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("压在 raw_gz 里的套娃报文同样能重读", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-gz-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await db.exec("ALTER TABLE sample_uplink ADD COLUMN raw_gz BLOB");
    const raw = packet({
      imei: "864317080990010",
      uart: JSON.stringify({ uart: "why=chg,opens=0,lid=1,chg=1" }),
      lid: 1,
      chg: 1,
      opens: 0,
    });
    await db.run(
      `INSERT INTO sample_box (id, imei, org, life, activate_step)
       VALUES ('BOX-010', '864317080990010', '总公司', '待激活', '等待激活')`
    );
    await db.run(
      `INSERT INTO sample_uplink
        (box_id, imei, received_at, device_time, kind, summary, raw, raw_gz)
       VALUES ('BOX-010', '864317080990010', '2026-10-21 14:31:50.187', '2026-10-21 14:31:49', 'unknown', '设备上报', '', ?)`,
      [gzipSync(Buffer.from(raw))]
    );
    await replayFaces(db);
    const box = await db.get("SELECT lid, charge FROM sample_box WHERE id = 'BOX-010'");
    assert.equal(Number(box.lid), 1);
    assert.equal(Number(box.charge), 1);
    const log = await db.get("SELECT summary FROM sample_uplink WHERE box_id = 'BOX-010'");
    assert.equal(log.summary, "充电上报");
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

test("单箱报文查询带箱号和时间，不用 OFFSET，列表不含原文", async () => {
  const calls = [];
  const store = new SqlBoxStore({
    dialect: "sqlite",
    async all(sql, params) {
      calls.push({ sql, params });
      return [];
    },
  });
  const page = await store.listLogs("BOX-001", {
    from: "2026-10-01 00:00:00.000",
    to: "2026-10-20 23:59:59.999",
    limit: 100,
  });
  assert.equal(page.list.length, 0);
  assert.equal(page.nextCursor, null);
  assert.match(calls[0].sql, /FROM sample_uplink/);
  assert.match(calls[0].sql, /box_id = \?/);
  assert.match(calls[0].sql, /received_at >= \?/);
  assert.match(calls[0].sql, /received_at <= \?/);
  assert.equal(calls[0].sql.includes("OFFSET"), false);
  assert.equal(calls[0].sql.includes("raw"), false);
  assert.deepEqual(calls[0].params, [
    "BOX-001",
    "2026-10-01 00:00:00.000",
    "2026-10-20 23:59:59.999",
  ]);
});

test("箱子列表只查当前状态表", async () => {
  const calls = [];
  const store = new SqlBoxStore({
    async all(sql) {
      calls.push(sql);
      return [];
    },
  });
  await store.list();
  assert.match(calls[0], /FROM sample_box/);
  assert.equal(calls[0].includes("sample_uplink"), false);
  assert.equal(calls[0].includes("raw"), false);
});

test("迁移 038：历史上充电中、已充满来回跳的充电上报改记成充电状态", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "box.db") },
    process.cwd()
  );
  let boxes;
  try {
    await migrate(db);
    boxes = new SqlBoxStore(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 8, 28, 17, 11, 27, 128)),
      parser: new UplinkParser(),
    });
    const lines = [
      "why=boot,chg=0,seq=1",
      "why=chg,chg=1,seq=2",
      "why=chg,chg=2,seq=3",
      "why=timer,chg=2,seq=4",
      "why=chg,chg=1,seq=5",
      "why=chg,chg=0,seq=6",
    ];
    for (const uart of lines) await ingest.accept(packet({ uart }));
    await boxes.flush();
    // 模拟改版前入库的数据：全部还是 chg
    await db.run(
      "UPDATE sample_uplink SET kind = 'chg', summary = REPLACE(summary, '充电状态', '充电上报') WHERE kind = 'chgs'"
    );
    const { up } = await import("../migrations/038_charge_flip_kind.js");
    await up(db);
    const rows = await db.all("SELECT kind, summary FROM sample_uplink ORDER BY id");
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["boot", "chg", "chgs", "timer", "chgs", "chg"]
    );
    assert.match(rows[2].summary, /^充电状态/);
    assert.match(rows[5].summary, /^充电上报/);
  } finally {
    if (boxes) await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { FixedClock } from "../src/domain/Clock.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { IngestService } from "../src/service/IngestService.js";
import { ensureSchema } from "../src/store/schema.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { RealtimeHub } from "../src/transport/RealtimeHub.js";
import { packet } from "./fixture.js";

const KNOWN_COLUMNS = [
  "id",
  "raw",
  "box_id",
  "imei",
  "received_at",
  "device_time",
  "kind",
  "summary",
  "org_id",
  "org_name",
  "actor_id",
  "actor_name",
  "action",
  "target_type",
  "target_id",
  "result",
  "created_at",
  "ip",
  "iccid",
  "imsi",
  "firmware",
  "org",
  "owner",
  "life",
  "alert",
  "battery",
  "csq",
  "last_report_at",
  "lbs",
  "lbs_lng",
  "lbs_lat",
  "gps",
  "gps_lng",
  "gps_lat",
  "opens",
  "activate_step",
  "powered_at",
  "next_no",
  "parent_id",
  "name",
  "code",
  "sort",
  "status",
  "create_time",
  "update_time",
  "username",
  "nickname",
  "password_hash",
  "dept_id",
  "mobile",
  "gender",
  "email",
  "avatar",
  "data_scope",
  "user_id",
  "role_id",
];

function scriptedMysql(present) {
  const tables = new Set(present);
  const created = new Set();
  const execs = [];
  return {
    dialect: "mysql",
    execs,
    async exec(sql) {
      execs.push(sql);
      const creating = sql.match(/CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/);
      if (creating) {
        tables.add(creating[1]);
        created.add(creating[1]);
      }
    },
    async get(sql, params = []) {
      if (!sql.includes("information_schema.TABLES")) return undefined;
      return tables.has(params[0]) ? { name: params[0] } : undefined;
    },
    async all(sql, params = []) {
      if (sql.includes("information_schema.COLUMNS")) {
        const name = params[0];
        if (created.has(name)) {
          return KNOWN_COLUMNS.map((column) => ({
            name: column,
            type: column === "raw" ? "mediumblob" : "varchar",
          }));
        }
        if (name === "sample_uplink") {
          return [
            { name: "id", type: "bigint" },
            { name: "box_id", type: "varchar" },
            { name: "imei", type: "varchar" },
            { name: "received_at", type: "datetime" },
            { name: "device_time", type: "varchar" },
            { name: "kind", type: "varchar" },
            { name: "summary", type: "varchar" },
            { name: "raw", type: "text" },
            { name: "lbs_lng", type: "double" },
            { name: "lbs_lat", type: "double" },
            { name: "gps_lng", type: "double" },
            { name: "gps_lat", type: "double" },
          ];
        }
        if (name === "sample_box") {
          return KNOWN_COLUMNS.map((column) => ({ name: column, type: "varchar" }));
        }
        return KNOWN_COLUMNS.map((column) => ({ name: column, type: "varchar" }));
      }
      return [];
    },
    async run() {},
  };
}

test("空库自动建出操作日志和按月分区的上报流水", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-new-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "new.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const names = tables.map((row) => row.name);
    assert.ok(names.includes("sample_box"));
    assert.ok(names.includes("sample_uplink"));
    assert.ok(names.includes("sys_operation_log"));
    const columns = await db.all("PRAGMA table_info(sample_uplink)");
    assert.equal(columns.find((column) => column.name === "raw").type, "BLOB");
    const boxes = new SqlBoxStore(db);
    const raw = packet({ uart: "why=boot,aa55=0" });
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: new RealtimeHub(),
      clock: new FixedClock(new Date(2026, 9, 14, 8, 0, 0, 0)),
      parser: new UplinkParser(),
    });
    await ingest.accept(raw);
    const page = await boxes.listLogs("BOX-001", {
      from: "2026-10-14 00:00:00.000",
      to: "2026-10-14 23:59:59.999",
    });
    assert.equal(page.list.length, 1);
    assert.equal(await boxes.readRaw("BOX-001", page.list[0].id, page.list[0].receivedAt), raw);
    const calls = [];
    const probe = new SqlBoxStore({
      dialect: "sqlite",
      async all(sql) {
        calls.push(sql);
        return [];
      },
      async run() {},
      async get() {
        return undefined;
      },
    });
    await probe.list();
    assert.match(calls[0], /FROM sample_box/);
    assert.equal(calls[0].includes("sample_uplink"), false);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧库只补缺的结构，原有箱子和明文上报都还在", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-old-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "old.db") },
    process.cwd()
  );
  try {
    await db.exec(`CREATE TABLE sample_box (
      id TEXT PRIMARY KEY,
      imei TEXT NOT NULL UNIQUE,
      org TEXT NOT NULL,
      life TEXT NOT NULL,
      activate_step TEXT NOT NULL
    )`);
    await db.exec(
      `INSERT INTO sample_box (id, imei, org, life, activate_step)
       VALUES ('BOX-009', '864317080900009', '华南分公司', '在途', '已确认')`
    );
    await db.exec(`CREATE TABLE sample_uplink (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id TEXT NOT NULL,
      imei TEXT NOT NULL,
      received_at TEXT NOT NULL,
      device_time TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      raw TEXT NOT NULL,
      lbs_lng REAL,
      lbs_lat REAL,
      gps_lng REAL,
      gps_lat REAL
    )`);
    await db.exec(
      `INSERT INTO sample_uplink (box_id, imei, received_at, kind, summary, raw)
       VALUES ('BOX-009', '864317080900009', '2026-08-01 08:00:00.000', 'timer', '定时上报', '{"keep":1}')`
    );
    await migrate(db);
    await migrate(db);
    const box = await db.get("SELECT id, imei, org, life, iccid FROM sample_box WHERE id = ?", [
      "BOX-009",
    ]);
    assert.equal(box.imei, "864317080900009");
    assert.equal(box.org, "华南分公司");
    assert.equal(box.life, "在途");
    assert.equal(box.iccid, "");
    const oldRow = await db.get("SELECT id, raw, raw_gz FROM sample_uplink WHERE box_id = ?", [
      "BOX-009",
    ]);
    assert.equal(oldRow.raw, '{"keep":1}');
    assert.equal(oldRow.raw_gz, null);
    const boxes = new SqlBoxStore(db);
    assert.equal(
      await boxes.readRaw("BOX-009", oldRow.id, "2026-08-01 08:00:00.000"),
      '{"keep":1}'
    );
    const logTable = await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["sys_operation_log"]
    );
    assert.equal(logTable.name, "sys_operation_log");
    const index = await db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [
      "idx_box_org_last",
    ]);
    assert.equal(index.name, "idx_box_org_last");
    const kept = await db.get("SELECT COUNT(*) AS total FROM sample_uplink");
    assert.equal(Number(kept.total), 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MySQL 空库建分区表，旧库不重建上报流水", async () => {
  const fresh = scriptedMysql([]);
  await ensureSchema(fresh);
  const created = fresh.execs.find((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS sample_uplink")
  );
  assert.match(created, /PARTITION BY RANGE \(TO_DAYS\(received_at\)\)/);
  assert.equal(
    fresh.execs.some((sql) => /\bDROP\b/i.test(sql)),
    false
  );

  const old = scriptedMysql([
    "sys_dept",
    "sys_role",
    "sys_user",
    "sys_user_role",
    "sample_box",
    "sample_uplink",
    "sample_box_seq",
    "sys_operation_log",
  ]);
  await ensureSchema(old);
  const text = old.execs.join("\n");
  assert.equal(text.includes("CREATE TABLE IF NOT EXISTS sample_uplink"), false);
  assert.match(text, /ADD COLUMN raw_gz/);
  assert.equal(/\bDROP\b/i.test(text), false);
  assert.equal(/\bDELETE\b/i.test(text), false);
  assert.equal(/\bTRUNCATE\b/i.test(text), false);
});

test("没有日志全表统计接口", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  assert.equal(source.includes("/api/v1/logs/analytics"), false);
  assert.equal(source.includes("COUNT(*)"), false);
});

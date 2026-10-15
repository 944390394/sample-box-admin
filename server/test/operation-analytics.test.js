import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import {
  dailyStatsSql,
  queryVisitOverview,
  queryVisitTrend,
  resolveTrendDates,
  totalStatsSql,
} from "../src/log/operationAnalytics.js";

const NOW = new Date(2026, 9, 15, 12, 0, 0, 0);

function at(day, hour) {
  return formatTimestamp(new Date(2026, 9, day, hour, 0, 0, 0));
}

test("统计语句只读操作日志，并且趋势带时间", () => {
  const daily = dailyStatsSql("sqlite", { kind: "all" });
  assert.match(daily.sql, /FROM sys_operation_log/);
  assert.match(daily.sql, /created_at >= \?/);
  assert.match(daily.sql, /created_at <= \?/);
  assert.match(daily.sql, /COUNT\(\*\)/);
  assert.match(daily.sql, /COUNT\(DISTINCT actor_id\)/);
  assert.equal(daily.sql.includes("sample_uplink"), false);

  const mysql = dailyStatsSql("mysql", { kind: "depts", ids: ["21", "2"] });
  assert.match(mysql.sql, /DATE_FORMAT\(created_at, '%Y-%m-%d'\)/);
  assert.match(mysql.sql, /org_id IN \(\?, \?\)/);
  assert.equal(mysql.sql.includes("sample_uplink"), false);

  const total = totalStatsSql({ kind: "depts", ids: ["21"] });
  assert.match(total.sql, /FROM sys_operation_log/);
  assert.match(total.sql, /org_id IN \(\?\)/);
  assert.equal(total.sql.includes("sample_uplink"), false);
  assert.deepEqual(total.params, ["21"]);

  const range = resolveTrendDates({ startDate: "2026-10-01", endDate: "2026-10-31" });
  assert.equal(range.dates.length, 31);
  assert.equal(range.dates[0], "2026-10-01");
  assert.equal(range.dates[30], "2026-10-31");
  assert.equal(range.from.endsWith("00:00:00.000"), true);
  assert.equal(range.to.endsWith("23:59:59.999"), true);
  assert.equal(
    resolveTrendDates({ startDate: "2026-01-01", endDate: "2026-02-01" }).error,
    "一次最长查询 31 天"
  );
  assert.equal(resolveTrendDates({}).error, "请填写开始和结束日期");
  assert.equal(
    resolveTrendDates({ startDate: "2026-13-01", endDate: "2026-10-15" }).error,
    "时间格式不正确"
  );
  assert.equal(
    resolveTrendDates({ startDate: "2026-10-15", endDate: "2026-10-01" }).error,
    "开始时间不能晚于结束时间"
  );
});

test("按组织和日期汇总操作条数与不重复操作者", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-analytics-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "analytics.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    const rows = [
      ["11", "2", at(15, 8)],
      ["11", "2", at(15, 9)],
      ["21", "6", at(15, 10)],
      ["2", "20", at(15, 11)],
      ["11", "2", at(14, 8)],
      ["511", "7", at(1, 8)],
      ["31", "30", at(1, 9)],
    ];
    for (const [orgId, actorId, createdAt] of rows) {
      await db.run(
        `INSERT INTO sys_operation_log
          (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orgId, orgId, actorId, actorId, "登录", "user", actorId, "成功", createdAt, "10.0.0.1"]
      );
    }

    const admin = await db.get("SELECT * FROM sys_user WHERE username = ?", ["admin"]);
    const branch = await db.get("SELECT * FROM sys_user WHERE username = ?", ["chen.ke"]);
    const partner = await db.get("SELECT * FROM sys_user WHERE username = ?", ["lin.xia"]);
    const overview = await queryVisitOverview(db, admin, NOW);
    assert.equal(overview.todayPvCount, 4);
    assert.equal(overview.todayUvCount, 3);
    assert.equal(overview.totalPvCount, 7);
    assert.equal(overview.totalUvCount, 5);
    assert.equal(overview.pvGrowthRate, 3);
    assert.equal(overview.uvGrowthRate, 2);

    const own = await queryVisitOverview(db, branch, NOW);
    assert.equal(own.todayPvCount, 2);
    assert.equal(own.todayUvCount, 2);
    assert.equal(own.totalPvCount, 2);
    assert.equal(own.totalUvCount, 2);
    assert.equal(own.pvGrowthRate, 0);
    assert.equal(own.uvGrowthRate, 0);

    const agency = await queryVisitOverview(db, partner, NOW);
    assert.equal(agency.todayPvCount, 0);
    assert.equal(agency.todayUvCount, 0);
    assert.equal(agency.pvGrowthRate, 0);
    assert.equal(agency.uvGrowthRate, 0);
    assert.equal(agency.totalPvCount, 1);
    assert.equal(agency.totalUvCount, 1);

    const east = await queryVisitOverview(db, { dept_id: "31" }, NOW);
    assert.equal(east.totalPvCount, 1);
    assert.equal(east.todayPvCount, 0);
    assert.equal(east.pvGrowthRate, 0);

    const blank = await queryVisitOverview(db, { dept_id: "" }, NOW);
    assert.equal(blank.totalPvCount, 0);
    assert.equal(blank.todayUvCount, 0);

    const trend = await queryVisitTrend(db, admin, {
      startDate: "2026-10-14",
      endDate: "2026-10-15",
    });
    assert.deepEqual(trend.dates, ["2026-10-14", "2026-10-15"]);
    assert.deepEqual(trend.pvList, [1, 4]);
    assert.deepEqual(trend.uvList, [1, 3]);

    const branchTrend = await queryVisitTrend(db, branch, {
      startDate: "2026-10-01",
      endDate: "2026-10-15",
    });
    assert.equal(branchTrend.dates.length, 15);
    assert.equal(branchTrend.pvList[0], 0);
    assert.equal(branchTrend.pvList[13], 0);
    assert.equal(branchTrend.pvList[14], 2);
    assert.equal(branchTrend.uvList[14], 2);
    assert.equal(
      branchTrend.pvList.reduce((sum, value) => sum + value, 0),
      2
    );

    const month = await queryVisitTrend(db, admin, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    assert.equal(month.dates.length, 31);
    assert.deepEqual(month.pvList, Array(31).fill(0));
    assert.equal(
      await queryVisitTrend(db, admin, { endDate: "2026-10-15" }).then((item) => item.error),
      "请填写开始和结束日期"
    );

    const indexes = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sys_operation_log'"
    );
    assert.deepEqual(indexes.map((item) => item.name).sort(), [
      "idx_op_actor_time",
      "idx_op_org_time",
      "idx_op_target_time",
      "idx_op_time",
    ]);
    const uplink = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sample_uplink' AND name NOT LIKE 'sqlite_%'"
    );
    assert.deepEqual(
      uplink.map((item) => item.name),
      ["idx_uplink_box"]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧库只补操作日志的时间索引，原有行还在", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-analytics-old-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "old.db") },
    process.cwd()
  );
  try {
    await db.exec(`CREATE TABLE sys_operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL DEFAULT '',
      org_name TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT ''
    )`);
    await db.run(
      `INSERT INTO sys_operation_log
        (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
       VALUES ('11', '系统管理', '2', '系统管理员', '登录', 'user', '2', '成功', '2026-10-14 08:00:00.000', '10.0.0.1')`
    );
    await db.exec("CREATE INDEX idx_op_org_time ON sys_operation_log (org_id, created_at, id)");
    await db.exec("CREATE INDEX idx_op_actor_time ON sys_operation_log (actor_id, created_at, id)");
    await db.exec(
      "CREATE INDEX idx_op_target_time ON sys_operation_log (target_id, created_at, id)"
    );
    await db.exec(`CREATE TABLE sample_uplink (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    await db.exec("CREATE INDEX idx_uplink_box ON sample_uplink (box_id, received_at)");
    await db.run(
      "INSERT INTO sample_uplink (box_id, received_at) VALUES ('BOX-009', '2026-08-01 08:00:00.000')"
    );
    const uplinkBefore = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sample_uplink' ORDER BY name"
    );
    await migrate(db);
    const indexes = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sys_operation_log' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    assert.deepEqual(
      indexes.map((item) => item.name),
      ["idx_op_actor_time", "idx_op_org_time", "idx_op_target_time", "idx_op_time"]
    );
    const kept = await db.get("SELECT COUNT(*) AS total FROM sys_operation_log");
    assert.equal(Number(kept.total), 1);
    const uplink = await db.get("SELECT COUNT(*) AS total FROM sample_uplink");
    assert.equal(Number(uplink.total), 1);
    const uplinkAfter = await db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sample_uplink' ORDER BY name"
    );
    assert.deepEqual(
      uplinkAfter.map((item) => item.name),
      uplinkBefore.map((item) => item.name)
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

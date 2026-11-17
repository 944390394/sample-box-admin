import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { audit } from "../src/log/audit.js";
import { operationLogQuery, queryOperationLogs } from "../src/log/operationLog.js";

test("操作日志按组织隔离，查询带时间且不做总行数统计", async () => {
  const built = operationLogQuery({ kind: "all" }, { from: "2026-10-01", to: "2026-10-08" });
  assert.equal(built.sql.includes("COUNT"), false);
  assert.equal(built.sql.includes("sample_uplink"), false);
  assert.match(built.sql, /created_at >= \?/);
  assert.match(built.sql, /ORDER BY created_at DESC, id DESC/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-box-log-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "log.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    await db.run(
      `INSERT INTO sys_operation_log
        (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "11",
        "系统管理",
        "2",
        "系统管理员",
        "登录",
        "user",
        "2",
        "成功",
        "2026-10-14 08:00:00.000",
        "10.0.0.1",
      ]
    );
    await db.run(
      `INSERT INTO sys_operation_log
        (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "21",
        "调度室",
        "6",
        "陈可",
        "新增用户",
        "user",
        "30",
        "成功",
        "2026-10-14 09:00:00.000",
        "10.0.0.2",
      ]
    );
    const admin = await db.get("SELECT * FROM sys_user WHERE username = ?", ["admin"]);
    const branch = await db.get("SELECT * FROM sys_user WHERE username = ?", ["chen.ke"]);
    const all = await queryOperationLogs(db, admin, { from: "2026-10-08", to: "2026-10-14" });
    assert.equal(all.list.length, 2);
    const own = await queryOperationLogs(db, branch, { from: "2026-10-08", to: "2026-10-14" });
    assert.deepEqual(
      own.list.map((item) => item.orgId),
      ["21"]
    );
    const tooLong = await queryOperationLogs(db, admin, { from: "2026-01-01", to: "2026-03-01" });
    assert.equal(tooLong.error, "一次最长查询 31 天");
    const broken = {
      async run() {
        throw new Error("disk full");
      },
    };
    await assert.doesNotReject(audit(broken, { action: "登录", result: "成功" }));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * #26 B1：统计 scope 收敛（R4）。analyticsScope 废弃「按顶级公司子树」口径，
 * 改与操作日志同一 resolveAccess.scope：分公司角色不再统计到兄弟分公司的人数/操作。
 * 组织简化（B1b）：机构层删除、AGENCY_LEAD 并入 BRANCH_ADMIN，本文件按分公司管理员口径重写。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { seedRolePerms } from "../src/auth/boxAccess.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import {
  queryOnlineActors,
  queryUserStats,
  queryVisitOverview,
  queryVisitTrend,
} from "../src/log/operationAnalytics.js";

const NOW = new Date(2026, 9, 15, 12, 0, 0, 0);
const at = (day, hour, minute = 0) => formatTimestamp(new Date(2026, 9, day, hour, minute, 0, 0));

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analytics-scope-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  await seedOrg(db);
  await seedRolePerms(db);
  return {
    db,
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function person(db, id, username, deptId, roleIds) {
  await db.run(
    "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, create_time) VALUES (?, ?, ?, 'x', ?, 1, '2026-09-26 09:00:00')",
    [id, username, username, deptId]
  );
  for (const roleId of roleIds)
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, roleId]);
  return db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
}

async function log(db, orgId, actorId, createdAt) {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
     VALUES (?, ?, ?, ?, '登录', 'user', ?, '成功', ?, '10.0.0.1')`,
    [orgId, orgId, actorId, actorId, actorId, createdAt]
  );
}

test("分公司管理员统计只算本单位及下级，不再按顶级公司子树泄露兄弟分公司（R4）", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 组织简化（B1b）：12=BRANCH_ADMIN(scope2)；lead 挂华南 2（下级 21），boss 挂华东 3（下级 31）
    const lead = await person(db, "90", "branch.lead", "2", ["12"]);
    const boss = await person(db, "92", "east.boss", "3", ["12"]);
    // 今天：2/21 各一条（华南），3 两条（华东，lead 的兄弟），11 一条（总部）；昨天 21 一条
    await log(db, "2", "90", at(15, 9));
    await log(db, "21", "7", at(15, 10));
    await log(db, "3", "91", at(15, 11));
    await log(db, "3", "92", at(15, 11, 30));
    await log(db, "11", "2", at(15, 8));
    await log(db, "21", "7", at(14, 9));

    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    const all = await queryVisitOverview(db, admin, NOW);
    assert.equal(all.totalPvCount, 6);
    assert.equal(all.todayPvCount, 5);

    // 分公司管理员（华南）：只算 2+21（修复前按顶级子树会算进兄弟华东）
    const agency = await queryVisitOverview(db, lead, NOW);
    assert.equal(agency.totalPvCount, 3);
    assert.equal(agency.totalUvCount, 2);
    assert.equal(agency.todayPvCount, 2);
    assert.equal(agency.todayUvCount, 2);

    // 华东管理员（dept 3，scope2）：本单位及下级 3+31，不含总部/兄弟分公司
    const branch = await queryVisitOverview(db, boss, NOW);
    assert.equal(branch.totalPvCount, 2);
    assert.equal(branch.todayPvCount, 2);

    // 采样员（仅本人）：只算自己的操作
    const sampler = await db.get("SELECT * FROM sys_user WHERE username = 'lin.xia'");
    const own = await queryVisitOverview(db, sampler, NOW);
    assert.equal(own.totalPvCount, 2);
    assert.equal(own.totalUvCount, 1);

    // 趋势同口径（在追加在线测试行之前断言）
    const trend = await queryVisitTrend(db, lead, {
      startDate: "2026-10-14",
      endDate: "2026-10-15",
    });
    assert.deepEqual(trend.pvList, [1, 2]);
    assert.deepEqual(trend.uvList, [1, 2]);

    // 在线人数同口径：最近 15 分钟
    await log(db, "2", "90", at(15, 11, 50));
    await log(db, "3", "91", at(15, 11, 55));
    assert.equal((await queryOnlineActors(db, lead, NOW)).count, 1);
    assert.equal((await queryOnlineActors(db, admin, NOW)).count, 2);

    // 人数统计：华南管理员只数 2/21 的人（lead+chen.ke+lin.xia，采样员组织简化后挂分公司），不数华东的人
    const heads = await queryUserStats(db, lead, NOW);
    assert.equal(heads.total, 3);
    const adminHeads = await queryUserStats(db, admin, NOW);
    assert.equal(adminHeads.total, 8); // 种子 6 + lead + boss
    const samplerHeads = await queryUserStats(db, sampler, NOW);
    assert.equal(samplerHeads.total, 1);
  } finally {
    await env.close();
  }
});

test("无生效角色/无部门的人统计为空，不再按部门所在顶级公司放行", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await log(db, "31", "30", at(15, 9));
    // 旧口径：dept_id=31 会按华东分公司子树统计；新口径：没有角色就没有范围
    const ghost = { id: "999", dept_id: "31" };
    const overview = await queryVisitOverview(db, ghost, NOW);
    assert.equal(overview.totalPvCount, 0);
    assert.deepEqual(await queryUserStats(db, ghost, NOW), { total: 0, growthRate: null });
    assert.equal((await queryOnlineActors(db, ghost, NOW)).count, 0);
    const trend = await queryVisitTrend(db, ghost, {
      startDate: "2026-10-14",
      endDate: "2026-10-15",
    });
    assert.deepEqual(trend.pvList, [0, 0]);
  } finally {
    await env.close();
  }
});

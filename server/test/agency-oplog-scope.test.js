/**
 * #26 B1：操作日志 scope 收敛（D1 actor 口径）。
 * operationScope 改由 resolveAccess.scope 派生：含角色 status、部门上限、ADMIN 短路、自定义 5。
 * 组织简化（B1b）：机构层删除、AGENCY_LEAD 并入 BRANCH_ADMIN——本文件按分公司管理员口径重写：
 * 分公司管理员只看本单位及下级（manageOrgIds）的日志，不再按顶级公司子树泄露兄弟分公司。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { up as up055a } from "../migrations/055a_oplog_detail_orgname.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { operationScope, queryOperationLogs } from "../src/log/operationLog.js";
import { listColumns } from "../src/store/schema.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agency-oplog-"));
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
    "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES (?, ?, ?, 'x', ?, 1)",
    [id, username, username, deptId]
  );
  for (const roleId of roleIds)
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, roleId]);
  return db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
}

async function log(db, orgId, actorId, createdAt, orgName = "") {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
     VALUES (?, ?, ?, ?, '登录', 'user', ?, '成功', ?, '10.0.0.1')`,
    [orgId, orgName, actorId, actorId, actorId, createdAt]
  );
}

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const AT = "2026-10-15 09:00:00.000";

test("分公司管理员只看本单位及下级日志（D1），兄弟分公司/上级单位不泄露，org_name 非空", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 组织简化（B1b）：种子角色 12 = BRANCH_ADMIN（data_scope=2）；2 华南分公司（下级 21 调度室），3 华东分公司（下级 31）
    const lead = await person(db, "90", "branch.lead", "2", ["12"]);
    await log(db, "2", "90", AT, "华南分公司");
    await log(db, "21", "7", AT, "调度室");
    await log(db, "3", "91", AT, "华东分公司");
    await log(db, "31", "8", AT, "华东调度室");
    await log(db, "11", "2", AT, "系统管理");

    const mine = await queryOperationLogs(db, lead, RANGE);
    assert.deepEqual(mine.list.map((item) => item.orgId).sort(), ["2", "21"]);
    assert.ok(
      mine.list.every((item) => item.orgName),
      "范围内日志 org_name 都要非空"
    );

    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    assert.equal((await queryOperationLogs(db, admin, RANGE)).list.length, 5);

    // 采样员（仅本人）：只看自己的 actor 行
    const sampler = await db.get("SELECT * FROM sys_user WHERE username = 'lin.xia'");
    const own = await queryOperationLogs(db, sampler, RANGE);
    assert.deepEqual(
      own.list.map((item) => item.actorId),
      ["7"]
    );

    // 越界 orgId 筛选返空；范围内 orgId 筛选只给该单位
    assert.deepEqual((await queryOperationLogs(db, lead, { ...RANGE, orgId: "3" })).list, []);
    assert.deepEqual(
      (await queryOperationLogs(db, lead, { ...RANGE, orgId: "21" })).list.map((i) => i.orgId),
      ["21"]
    );
  } finally {
    await env.close();
  }
});

test("operationScope 由 resolveAccess 派生：角色停用、部门上限、ADMIN 短路都生效", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const lead = await person(db, "90", "branch.lead", "2", ["12"]);
    await log(db, "2", "90", AT, "华南分公司");
    await log(db, "21", "7", AT, "调度室");

    const access = await resolveAccess(db, lead);
    assert.deepEqual([...access.scope.manageOrgIds].sort(), ["2", "21"]);
    const scope = await operationScope(db, lead);
    assert.equal(scope.kind, "depts");
    assert.deepEqual([...scope.ids].sort(), ["2", "21"]);

    // 角色停用：旧 operationScope 只看 data_scope 不看 status，修复后无生效角色→空范围
    await db.run("UPDATE sys_role SET status = 0 WHERE id = '12'");
    const disabled = await operationScope(db, lead);
    assert.ok(disabled.kind === "none" || (disabled.ids || []).length === 0);
    assert.deepEqual((await queryOperationLogs(db, lead, RANGE)).list, []);
    await db.run("UPDATE sys_role SET status = 1 WHERE id = '12'");

    // 部门上限封顶到「本单位」：21 不再可见
    await db.run("UPDATE sys_dept SET max_data_scope = 3 WHERE id = '2'");
    const capped = await operationScope(db, lead);
    assert.deepEqual(capped.ids, ["2"]);
    assert.deepEqual(
      (await queryOperationLogs(db, lead, RANGE)).list.map((item) => item.orgId),
      ["2"]
    );
    await db.run("UPDATE sys_dept SET max_data_scope = NULL WHERE id = '2'");

    // ADMIN 短路：不受部门上限影响
    await db.run("UPDATE sys_dept SET perm_limited = 1, max_data_scope = 4 WHERE id = '11'");
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    assert.equal((await operationScope(db, admin)).kind, "all");
  } finally {
    await env.close();
  }
});

test("055a：detail/target_org_id 自愈补齐，org_name 按 org_id→部门名、actor→部门名回填，幂等", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const columns = (await listColumns(db, "sys_operation_log")).map((column) => column.name);
    assert.ok(columns.includes("detail"), "detail 列要在");
    assert.ok(columns.includes("target_org_id"), "target_org_id 预留列要在");

    // 旧数据：org_name 空。org_id 在的按 org_id 取名；org_id 空的按 actor 当前部门补 org_id 和名
    await log(db, "3", "999", AT); // actor 已不存在，但 org_id 可查
    await log(db, "", "7", AT); // 林夏在 2（组织简化后采样员挂分公司）
    await log(db, "", "", AT); // 无 actor 无 org：留空
    await up055a(db);
    const byActor = await db.get(
      "SELECT org_id, org_name FROM sys_operation_log WHERE actor_id = '7'"
    );
    assert.equal(byActor.org_id, "2");
    assert.equal(byActor.org_name, "华南分公司");
    const byOrg = await db.get("SELECT org_name FROM sys_operation_log WHERE actor_id = '999'");
    assert.equal(byOrg.org_name, "华东分公司");
    const blank = await db.get(
      "SELECT org_id, org_name FROM sys_operation_log WHERE actor_id = '' AND org_id = ''"
    );
    assert.equal(blank.org_name, "");

    // 幂等：再跑一次不报错、值不变
    await up055a(db);
    assert.equal(
      (await db.get("SELECT org_name FROM sys_operation_log WHERE actor_id = '7'")).org_name,
      "华南分公司"
    );
  } finally {
    await env.close();
  }
});

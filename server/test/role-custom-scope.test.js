/**
 * #26 B1：自定义数据范围（data_scope=5）实装。
 * sys_role_dept 子树并集 ∩ 部门上限；/roles/:id/dept-ids 读表；updateRole 收 body.deptIds；
 * D3：自定义 orgIds ⊆ 自己 manageOrgIds，仅 scope≤2 的角色可授 5。055b 补码幂等、旧 5→3。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { up as up055b } from "../migrations/055b_perm_grant_custom_scope.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "role-custom-scope-"));
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

async function call(fn, ctx) {
  let out;
  await fn({
    query: {},
    params: {},
    body: {},
    ...ctx,
    ok: (data, message) => (out = { ok: true, data, message }),
    fail: (message, code, status) => (out = { ok: false, error: message, code, status }),
  });
  return out;
}

async function ctxOf(db, username) {
  const user = await db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
  return { db, user, access: await resolveAccess(db, user) };
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

async function role(db, id, code, scope, perms = []) {
  await db.run(
    "INSERT INTO sys_role (id, name, code, data_scope, sort, status) VALUES (?, ?, ?, ?, 90, 1)",
    [id, `角色${code}`, code, scope]
  );
  for (const perm of perms)
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, 1)", [
      id,
      perm,
    ]);
}

const deptIdsOf = async (db, roleId) =>
  (
    await db.all("SELECT dept_id FROM sys_role_dept WHERE role_id = ? ORDER BY dept_id", [roleId])
  ).map((row) => String(row.dept_id));

test("自定义范围 5 = sys_role_dept 子树并集，部门上限封顶；dept-ids 读表", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    await role(db, "80", "CUSTOM", 4);
    const saved = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: ["2", "31"] },
    });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(await deptIdsOf(db, "80"), ["2", "31"]);
    const read = await call(org.roleDeptIds, { ...admin, params: { id: "80" } });
    assert.equal(read.ok, true, read.error);
    assert.deepEqual([...read.data].sort(), ["2", "31"]);

    // 2 的子树含 21；31 是叶子。u95 挂在 21，祖先 2 进看箱范围
    await person(db, "95", "custom.user", "21", ["80"]);
    const user = await db.get("SELECT * FROM sys_user WHERE id = '95'");
    let access = await resolveAccess(db, user);
    assert.deepEqual([...access.scope.manageOrgIds].sort(), ["2", "21", "31"]);
    assert.ok(access.scope.orgIds.includes("2"));
    assert.ok(!access.scope.orgIds.includes("3"));

    // 部门上限「本单位及下级」：只保留 21 子树里的部分
    await db.run("UPDATE sys_dept SET max_data_scope = 2 WHERE id = '21'");
    access = await resolveAccess(db, user);
    assert.deepEqual(access.scope.manageOrgIds, ["21"]);
    // 「本单位」同样只剩 21；「仅本人」退化成 ownerIds
    await db.run("UPDATE sys_dept SET max_data_scope = 3 WHERE id = '21'");
    access = await resolveAccess(db, user);
    assert.deepEqual(access.scope.manageOrgIds, ["21"]);
    await db.run("UPDATE sys_dept SET max_data_scope = 4 WHERE id = '21'");
    access = await resolveAccess(db, user);
    assert.deepEqual(access.scope.manageOrgIds, []);
    assert.deepEqual(access.scope.ownerIds, ["95"]);
    await db.run("UPDATE sys_dept SET max_data_scope = NULL WHERE id = '21'");

    // 清空自定义部门 = 没有数据范围
    const cleared = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: [] },
    });
    assert.equal(cleared.ok, true, cleared.error);
    assert.deepEqual(await deptIdsOf(db, "80"), []);
    access = await resolveAccess(db, user);
    assert.deepEqual(access.scope.manageOrgIds, []);

    // 改回非自定义：sys_role_dept 残留清掉
    await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: ["2"] },
    });
    await call(org.updateRole, { ...admin, params: { id: "80" }, body: { dataScope: 3 } });
    assert.deepEqual(await deptIdsOf(db, "80"), []);
  } finally {
    await env.close();
  }
});

test("D3：自定义部门只能选自己 manage 内的；仅 scope≤2 的角色可授 5；分配同样过边界", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const grantPerms = [
      "sys:role:view",
      "sys:role:update",
      "sys:role:scope",
      "sys:user:view",
      "sys:user:role",
    ];
    await role(db, "81", "GRANT2", 2, grantPerms);
    await role(db, "82", "GRANT3", 3, grantPerms);
    await role(db, "83", "TARGET", 4);
    await person(db, "96", "grant2", "2", ["81"]);
    await person(db, "97", "grant3", "2", ["82"]);
    await person(db, "98", "staff", "21", []);
    const grant2 = await ctxOf(db, "grant2");
    const grant3 = await ctxOf(db, "grant3");
    const admin = await ctxOf(db, "admin");

    // manage=[2,21]：31 超出 → A0301
    const beyond = await call(org.updateRole, {
      ...grant2,
      params: { id: "83" },
      body: { dataScope: 5, deptIds: ["21", "31"] },
    });
    assert.equal(beyond.ok, false);
    assert.equal(beyond.code, "A0301");
    assert.equal(beyond.status, 403);
    // 范围内的可以
    const ok = await call(org.updateRole, {
      ...grant2,
      params: { id: "83" },
      body: { dataScope: 5, deptIds: ["21"] },
    });
    assert.equal(ok.ok, true, ok.error);

    // scope3 的角色不能授 5（D3），哪怕部门在自己 manage 里
    const narrow = await call(org.updateRole, {
      ...grant3,
      params: { id: "83" },
      body: { dataScope: 5, deptIds: ["2"] },
    });
    assert.equal(narrow.ok, false);
    assert.equal(narrow.code, "A0301");

    // 管理员不受 manage 限制
    const wide = await call(org.updateRole, {
      ...admin,
      params: { id: "83" },
      body: { dataScope: 5, deptIds: ["31"] },
    });
    assert.equal(wide.ok, true, wide.error);

    // 把自定义部门超出自己 manage 的角色分给别人：拒
    const denied = await call(org.updateUser, {
      ...grant2,
      params: { id: "98" },
      body: { roleIds: ["83"] },
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /自定义|管理范围/);
    // 管理员可以分
    const assigned = await call(org.updateUser, {
      ...admin,
      params: { id: "98" },
      body: { roleIds: ["83"] },
    });
    assert.equal(assigned.ok, true, assigned.error);
  } finally {
    await env.close();
  }
});

test("055b：GRANT_055 补角色和部门上限的导出码、旧 5→3、AGENCY_LEAD 补码，幂等", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 迁移后才造旧形态：只有 read 的角色、只有 read 的部门上限、旧 data_scope=5
    await role(db, "84", "OLD_READ", 3, ["sys:oplog:read"]);
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', 'sys:oplog:read')");
    await db.run(
      "INSERT INTO sys_role (id, name, code, data_scope, sort, status) VALUES ('85', '旧自定义', 'OLD5', 5, 95, 1)"
    );
    // 模拟管理员曾收回机构负责人的日志码（R3：一次性补回）
    await db.run(
      "DELETE FROM sys_role_perm WHERE role_id = '14' AND perm IN ('sys:oplog:read', 'sys:oplog:export', 'sys:user:create')"
    );

    await up055b(db);
    const permsOf = async (id) =>
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ? ORDER BY perm", [id])).map(
        (row) => row.perm
      );
    assert.ok((await permsOf("84")).includes("sys:oplog:export"));
    const deptPerms = (
      await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = '2' ORDER BY perm")
    ).map((row) => row.perm);
    assert.deepEqual(deptPerms, ["sys:oplog:export", "sys:oplog:read"]);
    assert.equal(
      Number((await db.get("SELECT data_scope FROM sys_role WHERE id = '85'")).data_scope),
      3
    );
    const lead = await permsOf("14");
    for (const code of [
      "sys:oplog:read",
      "sys:oplog:export",
      "sys:user:create",
      "sys:user:update",
      "sys:user:disable",
      "sys:user:enable",
      "sys:dept:view",
    ])
      assert.ok(lead.includes(code), `AGENCY_LEAD 缺 ${code}`);

    // 幂等：再跑一次行数不变
    const count = async () => Number((await db.get("SELECT COUNT(*) AS n FROM sys_role_perm")).n);
    const before = await count();
    await up055b(db);
    assert.equal(await count(), before);
    assert.deepEqual(await deptIdsOf(db, "85"), []);
  } finally {
    await env.close();
  }
});

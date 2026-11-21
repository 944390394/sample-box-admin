/**
 * 角色列表拖拽排序（PUT /api/v1/roles/reorder → org.reorderRoles）：
 * 合法排列（启用＋停用全部 id，不缺不重不外来）事务内写 sort=10,20,…；
 * 缺 id / 外来 id / 重复 / 非数组整体拒绝且 sort 不动、失败留痕；
 * 无「编辑角色」权限 → 403 A0301（handler 兜底＋路由声明 sys:role:update 且排在 /roles/:id 前）；
 * 审计「调整角色顺序」detail={before,after} 落 sys_operation_log；
 * listRoles / roleOptions / reorder 响应同序（ORDER BY sort, id；sort 平手按 id）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "role-reorder-"));
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

const idsOf = async (db) =>
  (await db.all("SELECT id FROM sys_role ORDER BY sort, id")).map((row) => String(row.id));

test("reorder：合法排列事务内写 sort=10,20,…（含停用角色）；响应/列表/options 同序；审计落库", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    // 停用一个角色：排列必须连它一起给，排序后仍在列表里（off 标记）
    await db.run("UPDATE sys_role SET status = 0 WHERE code = 'HOME_SWITCH'");
    const before = await idsOf(db);
    const wanted = [...before].reverse();

    const out = await call(org.reorderRoles, { ...admin, body: { ids: wanted } });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.message, "角色顺序已保存");
    assert.deepEqual(out.data.ids, wanted);

    // sort 按序写 10,20,…，update_time 一并刷新
    const rows = await db.all("SELECT id, sort, update_time FROM sys_role ORDER BY sort, id");
    assert.deepEqual(
      rows.map((row) => String(row.id)),
      wanted
    );
    assert.deepEqual(
      rows.map((row) => Number(row.sort)),
      wanted.map((_, i) => (i + 1) * 10)
    );
    assert.ok(rows.every((row) => row.update_time));

    // 角色页左列表（GET /roles）与角色下拉（GET /roles/options）同序
    const page = await call(org.listRoles, { ...admin, query: { pageNum: 1, pageSize: 200 } });
    assert.equal(page.ok, true, page.error);
    assert.deepEqual(
      page.data.list.map((item) => String(item.id)),
      wanted
    );
    const options = await call(org.roleOptions, { ...admin });
    assert.equal(options.ok, true, options.error);
    assert.deepEqual(
      options.data.map((item) => String(item.value)),
      wanted
    );
    const off = page.data.list.find((item) => item.code === "HOME_SWITCH");
    assert.equal(off.status, 0);

    // 审计：action/target/detail 前后顺序都落库
    const log = await db.get(
      "SELECT * FROM sys_operation_log WHERE action = '调整角色顺序' ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    assert.ok(log, "调整角色顺序审计未落库");
    assert.equal(log.target_type, "role");
    assert.equal(log.result, "成功");
    assert.equal(log.actor_id, String(admin.user.id));
    const detail = JSON.parse(log.detail);
    assert.deepEqual(detail.before, before);
    assert.deepEqual(detail.after, wanted);

    // 再排一次（幂等口径：同样排列再写一遍不报错）
    const again = await call(org.reorderRoles, { ...admin, body: { ids: wanted } });
    assert.equal(again.ok, true, again.error);
    assert.deepEqual(again.data.ids, wanted);
  } finally {
    await env.close();
  }
});

test("reorder：缺 id / 外来 id / 重复 / 非数组整体拒绝，sort 不动，失败留痕", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    const before = await idsOf(db);
    const sortsBefore = await db.all("SELECT id, sort FROM sys_role ORDER BY id");

    const missing = await call(org.reorderRoles, { ...admin, body: { ids: before.slice(1) } });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "A0400");
    assert.equal(missing.status, 400);

    const foreign = await call(org.reorderRoles, {
      ...admin,
      body: { ids: [...before.slice(0, -1), "99999"] },
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "A0400");
    assert.equal(foreign.status, 400);

    // 长度对但重复（等价于缺了最后一个）：重复校验先命中
    const dup = await call(org.reorderRoles, {
      ...admin,
      body: { ids: [before[0], ...before.slice(1, -1), before[0]] },
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, "A0400");

    const notArray = await call(org.reorderRoles, { ...admin, body: { ids: "2,8" } });
    assert.equal(notArray.ok, false);
    assert.equal(notArray.code, "A0400");
    const absent = await call(org.reorderRoles, { ...admin, body: {} });
    assert.equal(absent.ok, false);
    assert.equal(absent.code, "A0400");

    // 整体拒绝：一行 sort 都没动，顺序不变
    assert.deepEqual(await db.all("SELECT id, sort FROM sys_role ORDER BY id"), sortsBefore);
    assert.deepEqual(await idsOf(db), before);
    // 失败也留痕（与新增/修改角色同口径）
    const logs = await db.all(
      "SELECT result, detail FROM sys_operation_log WHERE action = '调整角色顺序'"
    );
    assert.equal(logs.length, 5);
    assert.ok(logs.every((row) => row.result === "失败"));
  } finally {
    await env.close();
  }
});

test("reorder：无「编辑角色」权限 → 403 A0301；有权限的非管理员可排；路由声明与注册顺序", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await role(db, "80", "VIEWONLY", 1, ["sys:role:view"]);
    await role(db, "81", "EDITOR", 1, ["sys:role:view", "sys:role:update"]);
    await person(db, "96", "viewonly", "1", ["80"]);
    await person(db, "97", "editor", "1", ["81"]);
    const viewer = await ctxOf(db, "viewonly");
    const editor = await ctxOf(db, "editor");
    const before = await idsOf(db);

    const denied = await call(org.reorderRoles, {
      ...viewer,
      body: { ids: [...before].reverse() },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    assert.equal(denied.status, 403);
    assert.deepEqual(await idsOf(db), before);

    // 有 sys:role:update 的非管理员也能排（排序是展示口径，不是授权）
    const wanted = [...before].reverse();
    const allowed = await call(org.reorderRoles, { ...editor, body: { ids: wanted } });
    assert.equal(allowed.ok, true, allowed.error);
    assert.deepEqual(await idsOf(db), wanted);

    // 路由声明：perm=sys:role:update；注册在 PUT /roles/:id 之前（matchRoute 首个命中即返回）
    const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
    const block = routes.match(/\{[^{}]*path: "\/api\/v1\/roles\/reorder"[^{}]*\}/);
    assert.ok(block, "PUT /api/v1/roles/reorder 路由未注册");
    assert.match(block[0], /method: "PUT"/);
    assert.match(block[0], /auth: true/);
    assert.match(block[0], /perm: "sys:role:update"/);
    assert.match(block[0], /handler: org\.reorderRoles/);
    assert.ok(
      routes.indexOf('path: "/api/v1/roles/reorder"') < routes.indexOf('path: "/api/v1/roles/:id"'),
      "reorder 必须注册在 /roles/:id 之前，否则被当成 :id 吞掉"
    );
    // dispatcher 统一权限门：缺 perm → 403 A0301（路由层兜住无权限请求）
    assert.match(routes, /return ctx\.fail\("没有这项操作权限", "A0301", 403\)/);
  } finally {
    await env.close();
  }
});

test("listRoles/roleOptions：sort 平手按 id 裁决（ORDER BY sort, id），两处同序", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    // 种子 8(sort2)/9(sort3)：把 9 也改成 2 → 平手组 {8,9}，id 小的在前
    await db.run("UPDATE sys_role SET sort = 2 WHERE id = '9'");
    const expected = ["2", "8", "9", "10", "11", "12", "13", "15", "16"];
    assert.deepEqual(await idsOf(db), expected);
    const page = await call(org.listRoles, { ...admin, query: { pageNum: 1, pageSize: 200 } });
    assert.deepEqual(
      page.data.list.map((item) => String(item.id)),
      expected
    );
    const options = await call(org.roleOptions, { ...admin });
    assert.deepEqual(
      options.data.map((item) => String(item.value)),
      expected
    );
    // 关键字过滤不改变相对顺序
    const filtered = await call(org.listRoles, { ...admin, query: { keywords: "管理" } });
    assert.deepEqual(
      filtered.data.list.map((item) => String(item.id)),
      ["2", "8", "12"]
    );
  } finally {
    await env.close();
  }
});

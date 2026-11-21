/**
 * R26 权限颗粒度 P0（任务 #60）：部门/角色启停拆码（061）的定向测试。
 * - upgradeCodes 并集守恒：持 update 者获 update+disable+enable，不丢能力；未持有者不补；幂等。
 * - 061 迁移：双表 expand（sys_role_perm grantable 沿旧 update 行取 max；sys_dept_perm 同拆）、
 *   _bak_061 备份先于改动且重跑不覆盖、ADMIN 短路、未持 update 的角色不动（不强制补默认）。
 * - handler 门禁：dept/role 状态变更按目标状态查 disable/enable；资料编辑/改名/排序仍查 update；
 *   旧客户端只持 update 调启停 → 403 A0301；新码启停 → 200；审计 action 区分启用/停用。
 * - 部门上限交集：新码被上限裁掉时启停不生效（061 双表同拆的必要性）；角色停用后持有者随即失权。
 * - 菜单单源：仅持启停码（+view 前置）也能看到对应菜单（menusFor/preview 自动随码表）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { up as up061 } from "../migrations/061_perm_status_split.js";
import * as org from "../org-api.js";
import { resolveAccess } from "../src/auth/boxAccess.js";
import { menusFor, menuPreviewFor } from "../menus.js";
import { SPLIT_061, upgradeCodes } from "../src/auth/permCatalog.js";

const NOW = "2026-11-22 10:00:00";
async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "perm-status-split-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
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
async function dept(db, id, parent, name) {
  await db.run(
    "INSERT INTO sys_dept (id, parent_id, name, code, sort, status, type) VALUES (?, ?, ?, ?, 1, 1, '公司')",
    [id, parent, name, `D${id}`]
  );
}
async function role(db, id, code, scope, perms, grantable = 0) {
  await db.run(
    "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
    [id, `角色${code}`, code, scope, NOW, NOW]
  );
  for (const perm of perms)
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
      id,
      perm,
      grantable,
    ]);
}
async function user(db, id, username, deptId, roles) {
  await db.run(
    "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES (?, ?, ?, 'x', ?, 1)",
    [id, username, username, deptId]
  );
  for (const r of roles)
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, r]);
}
async function ctxOf(db, id) {
  const row = await db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
  return { db, user: row, access: await resolveAccess(db, row) };
}
const adminCtx = (db) => ({
  db,
  user: { id: "1", dept_id: "1" },
  access: {
    roles: ["ADMIN"],
    perms: new Set(),
    grantable: new Set(),
    scope: { all: true, orgIds: [], ownerIds: [] },
  },
});
const permsOf = async (db, id) =>
  (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ? ORDER BY perm", [id])).map(
    (r) => r.perm
  );
const auditsOf = async (db, type, id) =>
  db.all(
    "SELECT action, result FROM sys_operation_log WHERE target_type = ? AND target_id = ? ORDER BY id",
    [type, String(id)]
  );

test("upgradeCodes 并集守恒：持 update 获 disable+enable 并集且保留 update；未持有者不补；幂等", () => {
  const deptUp = upgradeCodes(["sys:dept:view", "sys:dept:update"]);
  for (const code of ["sys:dept:update", "sys:dept:disable", "sys:dept:enable"])
    assert.ok(deptUp.includes(code), code);
  const roleUp = upgradeCodes(["sys:role:view", "sys:role:update"]);
  for (const code of ["sys:role:update", "sys:role:disable", "sys:role:enable"])
    assert.ok(roleUp.includes(code), code);
  // 未持 update 的角色不补启停码（不强制补默认，区别于 056/058）
  const plain = upgradeCodes(["sys:dept:view", "sys:role:view", "device:box:list"]);
  for (const code of ["sys:dept:disable", "sys:dept:enable", "sys:role:disable", "sys:role:enable"])
    assert.ok(!plain.includes(code), code);
  // 幂等：升级两次结果一致；SPLIT_061 老码都在 parts 里（只补不删）
  assert.deepEqual(upgradeCodes(deptUp).sort(), [...deptUp].sort());
  for (const [old, parts] of Object.entries(SPLIT_061)) assert.ok(parts.includes(old), old);
});

test("061 迁移：双表 expand＋grantable 沿旧 update 行＋_bak 留底；重跑幂等、备份不覆盖", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 角色 60：持 dept:update（可转授）＋role:update（不可转授）；角色 61：无 update；ADMIN 短路
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "60", "OLD", 3, []);
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('60', 'sys:dept:view', 1)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('60', 'sys:dept:update', 1)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('60', 'sys:role:view', 0)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('60', 'sys:role:update', 0)"
    );
    await role(db, "61", "PLAIN", 3, ["device:box:list"]);
    // 部门上限：dept 2 持 dept:update；dept 3 无
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', 'sys:dept:view')");
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', 'sys:dept:update')");
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('3', 'device:box:list')");
    const before60 = await permsOf(db, "60");
    const before61 = await permsOf(db, "61");

    // migrate 已在空表上建过 _bak_061（空壳）；删掉再跑，验证「改动前备份」语义（沿 three-kinds/org-b1b 先例）
    await db.run("DROP TABLE IF EXISTS _bak_061_perm_granularity_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_061_perm_granularity_sys_dept_perm");
    await up061(db);

    const after60 = await permsOf(db, "60");
    assert.deepEqual(
      after60,
      [
        ...new Set([
          ...before60,
          "sys:dept:disable",
          "sys:dept:enable",
          "sys:role:disable",
          "sys:role:enable",
        ]),
      ].sort()
    );
    // grantable 继承：dept:update=1 → dept:disable/enable=1；role:update=0 → role:disable/enable=0
    const flags = Object.fromEntries(
      (await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = '60'")).map((r) => [
        r.perm,
        Number(r.grantable),
      ])
    );
    assert.equal(flags["sys:dept:disable"], 1);
    assert.equal(flags["sys:dept:enable"], 1);
    assert.equal(flags["sys:role:disable"], 0);
    assert.equal(flags["sys:role:enable"], 0);
    assert.deepEqual(await permsOf(db, "61"), before61, "未持 update 的角色不动");
    assert.deepEqual(await permsOf(db, "1"), [], "ADMIN 短路不落行");
    // 部门上限同拆
    const dept2 = (
      await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = '2' ORDER BY perm")
    ).map((r) => r.perm);
    assert.deepEqual(dept2, [
      "sys:dept:disable",
      "sys:dept:enable",
      "sys:dept:update",
      "sys:dept:view",
    ]);
    const dept3 = (await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = '3'")).map(
      (r) => r.perm
    );
    assert.deepEqual(dept3, ["device:box:list"]);
    // 备份留底＝改动前
    const bak = await db.all(
      "SELECT perm FROM _bak_061_perm_granularity_sys_role_perm WHERE role_id = '60' ORDER BY perm"
    );
    assert.deepEqual(
      bak.map((r) => r.perm),
      before60
    );
    const bakDept = await db.all(
      "SELECT perm FROM _bak_061_perm_granularity_sys_dept_perm WHERE dept_id = '2' ORDER BY perm"
    );
    assert.deepEqual(
      bakDept.map((r) => r.perm),
      ["sys:dept:update", "sys:dept:view"]
    );

    // 重跑：行数/flag 不变，备份不覆盖（先改一行再重跑，_bak 仍是首次备份）
    const countBefore = (await db.get("SELECT COUNT(*) AS n FROM sys_role_perm")).n;
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('61', 'device:box:detail', 0)"
    );
    await up061(db);
    assert.equal(
      (await db.get("SELECT COUNT(*) AS n FROM sys_role_perm")).n,
      Number(countBefore) + 1
    );
    assert.deepEqual(await permsOf(db, "60"), after60);
    const bakAfter = await db.all(
      "SELECT perm FROM _bak_061_perm_granularity_sys_role_perm WHERE role_id = '60' ORDER BY perm"
    );
    assert.deepEqual(
      bakAfter.map((r) => r.perm),
      before60,
      "_bak 不被重跑覆盖"
    );
    assert.ok(
      !(
        await db.all(
          "SELECT perm FROM _bak_061_perm_granularity_sys_role_perm WHERE role_id = '61'"
        )
      ).some((r) => r.perm === "device:box:detail"),
      "备份仍是首次留底"
    );
  } finally {
    await env.close();
  }
});

test("部门启停门禁：update 只管资料；停用/启用各查各码；旧 update 客户端调启停 403；审计区分", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await dept(db, "2", "1", "华南分公司");
    await role(db, "1", "ADMIN", 1, []);
    // 资料编辑员：view+update，无启停码（061 后管理员显式收回启停的形态）
    await role(db, "10", "EDITOR", 1, ["sys:dept:view", "sys:dept:update"]);
    // 停用员/启用员：各持一码
    await role(db, "11", "STOPPER", 1, ["sys:dept:view", "sys:dept:disable"]);
    await role(db, "12", "STARTER", 1, ["sys:dept:view", "sys:dept:enable"]);
    await user(db, "1", "admin", "1", ["1"]);
    await user(db, "10", "editor", "1", ["10"]);
    await user(db, "11", "stopper", "1", ["11"]);
    await user(db, "12", "starter", "1", ["12"]);
    const editor = await ctxOf(db, "10");
    const stopper = await ctxOf(db, "11");
    const starter = await ctxOf(db, "12");
    const admin = adminCtx(db);

    // 资料编辑员：改名可以；启停都不行（旧客户端只持 update 调启停 → 403 A0301）
    assert.equal(
      (await call(org.updateDept, { ...editor, params: { id: "2" }, body: { name: "华南一" } })).ok,
      true
    );
    const off = await call(org.updateDept, { ...editor, params: { id: "2" }, body: { status: 0 } });
    assert.equal(off.ok, false);
    assert.equal(off.code, "A0301");
    assert.equal(off.status, 403);
    assert.match(off.error, /停用部门/);
    // 状态没变（回显原值）不查启停码：资料编辑员带 status=1 保存改名仍成功
    assert.equal(
      (
        await call(org.updateDept, {
          ...editor,
          params: { id: "2" },
          body: { name: "华南二", status: 1 },
        })
      ).ok,
      true
    );
    // 停用员：停用成功＋审计「停用部门」；改名不行（资料仍要 update）
    const stopped = await call(org.updateDept, {
      ...stopper,
      params: { id: "2" },
      body: { status: 0 },
    });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(Number((await db.get("SELECT status FROM sys_dept WHERE id = '2'")).status), 0);
    const renameDenied = await call(org.updateDept, {
      ...stopper,
      params: { id: "2" },
      body: { name: "x" },
    });
    assert.equal(renameDenied.ok, false);
    assert.match(renameDenied.error, /编辑部门基本信息/);
    // 停用员再点停用（0→0 no-op）不报错；启用不行（要 enable 码）
    assert.equal(
      (await call(org.updateDept, { ...stopper, params: { id: "2" }, body: { status: 0 } })).ok,
      true
    );
    const onDenied = await call(org.updateDept, {
      ...stopper,
      params: { id: "2" },
      body: { status: 1 },
    });
    assert.equal(onDenied.ok, false);
    assert.match(onDenied.error, /启用部门/);
    // 启用员：启用成功＋审计「启用部门」
    const started = await call(org.updateDept, {
      ...starter,
      params: { id: "2" },
      body: { status: 1 },
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(Number((await db.get("SELECT status FROM sys_dept WHERE id = '2'")).status), 1);
    // ADMIN 不受码门限制
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: "2" }, body: { status: 0 } })).ok,
      true
    );
    await call(org.updateDept, { ...admin, params: { id: "2" }, body: { status: 1 } });

    // 审计 action 区分：停用/启用各自留痕（含失败意图），资料变更仍是「修改部门」
    const audits = await auditsOf(db, "dept", "2");
    const seq = audits.map((a) => `${a.action}:${a.result}`);
    assert.ok(seq.includes("停用部门:成功"), JSON.stringify(seq));
    assert.ok(seq.includes("启用部门:成功"), JSON.stringify(seq));
    assert.ok(seq.includes("停用部门:失败"), "旧 update 客户端试停用被拒也留痕");
    assert.ok(seq.includes("修改部门:成功"), JSON.stringify(seq));
  } finally {
    await env.close();
  }
});

test("角色启停门禁：update 只管改名/排序；启停各查各码；审计区分；停用后持有者随即失权", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "10", "EDITOR", 1, ["sys:role:view", "sys:role:update"]);
    await role(db, "11", "STOPPER", 1, ["sys:role:view", "sys:role:disable"]);
    await role(db, "12", "STARTER", 1, ["sys:role:view", "sys:role:enable"]);
    // 目标角色：带一项业务权限，给「停用即失权」断言用
    await role(db, "20", "TARGET", 3, ["device:box:list"]);
    await user(db, "1", "admin", "1", ["1"]);
    await user(db, "10", "editor", "1", ["10"]);
    await user(db, "11", "stopper", "1", ["11"]);
    await user(db, "12", "starter", "1", ["12"]);
    await user(db, "20", "holder", "1", ["20"]);
    const editor = await ctxOf(db, "10");
    const stopper = await ctxOf(db, "11");
    const starter = await ctxOf(db, "12");
    const admin = adminCtx(db);

    // 资料编辑员：改名可以；停用 403（旧客户端只持 update）；排序仍要 update（reorder 不受拆码影响）
    assert.equal(
      (await call(org.updateRole, { ...editor, params: { id: "20" }, body: { name: "目标一" } }))
        .ok,
      true
    );
    const off = await call(org.updateRole, {
      ...editor,
      params: { id: "20" },
      body: { status: 0 },
    });
    assert.equal(off.ok, false);
    assert.equal(off.code, "A0301");
    assert.equal(off.status, 403);
    assert.match(off.error, /停用角色/);
    assert.equal(
      (
        await call(org.reorderRoles, {
          ...editor,
          body: { ids: ["1", "10", "11", "12", "20"] },
        })
      ).ok,
      true
    );
    // 停用员：停用成功＋审计「停用角色」；改名不行；启用不行
    const stopped = await call(org.updateRole, {
      ...stopper,
      params: { id: "20" },
      body: { status: 0 },
    });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(Number((await db.get("SELECT status FROM sys_role WHERE id = '20'")).status), 0);
    assert.match(
      (await call(org.updateRole, { ...stopper, params: { id: "20" }, body: { name: "x" } })).error,
      /编辑角色/
    );
    assert.match(
      (await call(org.updateRole, { ...stopper, params: { id: "20" }, body: { status: 1 } })).error,
      /启用角色/
    );
    // 停用即失权：持有者下一次解析权限就没有 device:box:list 了（activeRoles 过滤 status=1）
    const holder = await ctxOf(db, "20");
    assert.ok(!holder.access.perms.has("device:box:list"), "角色停用后持有者随即失权");
    // 启用员：启用成功＋审计「启用角色」；持有者权限恢复
    const started = await call(org.updateRole, {
      ...starter,
      params: { id: "20" },
      body: { status: 1 },
    });
    assert.equal(started.ok, true, started.error);
    const back = await ctxOf(db, "20");
    assert.ok(back.access.perms.has("device:box:list"));
    // ADMIN 角色谁也不能停用（既有守卫不回归）
    assert.match(
      (await call(org.updateRole, { ...admin, params: { id: "1" }, body: { status: 0 } })).error,
      /不能停用/
    );
    const audits = await auditsOf(db, "role", "20");
    const seq = audits.map((a) => `${a.action}:${a.result}`);
    assert.ok(seq.includes("停用角色:成功"), JSON.stringify(seq));
    assert.ok(seq.includes("启用角色:成功"), JSON.stringify(seq));
    assert.ok(seq.includes("停用角色:失败"), JSON.stringify(seq));
    assert.ok(seq.includes("修改角色:成功"), JSON.stringify(seq));
  } finally {
    await env.close();
  }
});

test("部门上限交集：新码被上限裁掉时启停不生效；061 双表同拆保存量能力", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await dept(db, "2", "1", "华南分公司");
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "10", "STOPPER", 1, ["sys:dept:view", "sys:dept:disable"]);
    await user(db, "1", "admin", "1", ["1"]);
    await user(db, "10", "stopper", "2", ["10"]);
    // 华南上限只给 view：disable 被交集裁掉 → 停用 403
    await db.run("UPDATE sys_dept SET perm_limited = 1 WHERE id = '2'");
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', 'sys:dept:view')");
    let stopper = await ctxOf(db, "10");
    assert.ok(!stopper.access.perms.has("sys:dept:disable"));
    const denied = await call(org.updateDept, {
      ...stopper,
      params: { id: "2" },
      body: { status: 0 },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    // 上限补上 disable（061 对持 update 的上限行自动做的事）→ 生效
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', 'sys:dept:disable')");
    stopper = await ctxOf(db, "10");
    assert.equal(
      (await call(org.updateDept, { ...stopper, params: { id: "2" }, body: { status: 0 } })).ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("菜单单源随码表：仅持启停码（+view）也看得到部门/角色菜单；预览=menusFor", () => {
  const deptOnly = new Set(["sys:dept:view", "sys:dept:disable"]);
  const roleOnly = new Set(["sys:role:view", "sys:role:enable"]);
  const deptNames = menusFor(deptOnly).flatMap((g) => g.children.map((c) => c.name));
  const roleNames = menusFor(roleOnly).flatMap((g) => g.children.map((c) => c.name));
  assert.ok(deptNames.includes("Dept"), "仅停用码可见部门菜单");
  assert.ok(!deptNames.includes("Role"));
  assert.ok(roleNames.includes("Role"), "仅启用码可见角色菜单");
  assert.ok(!roleNames.includes("Dept"));
  const preview = menuPreviewFor(deptOnly);
  assert.equal(preview.find((m) => m.title === "组织管理 · 部门").on, true);
  assert.equal(preview.find((m) => m.title === "组织管理 · 角色与权限").on, false);
});

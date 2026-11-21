/**
 * #26 B4：授权 UI 增量的后端契约——
 * 菜单预览单源（roleMenuPreview/draftMenuPreview 与 menusFor 同一实现）；
 * 授权审计（grant/scope 变更写 sys_operation_log.detail，抽屉按日志范围裁剪 + grantable 现状）；
 * permCatalog.myScope（D3 前端预校验）；createRole 自定义范围落 sys_role_dept。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { menuRoutes, menusFor, menuPreviewFor } from "../menus.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { permLabelOf } from "../src/auth/permCatalog.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "role-grant-ui-"));
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

/** 用 menusFor 的裁剪结果独立重算每个菜单项的 on/off，钉死「预览=menusFor」。
 * 功能常开（无开关）：local-menus 调拨单组恒镜像（R12 on 按 some(新建划拨, 撤销划拨)），插在任务单组之后。 */
function expectedPreview(perms) {
  const visible = new Set(menusFor(perms).flatMap((g) => g.children.map((c) => c.name)));
  const canTransfer = perms.has("task:create:transfer") || perms.has("task:transfer:revoke");
  const local = [
    { title: "调拨单", on: canTransfer, hidden: false },
    { title: "调拨单 · 划拨单详情", on: canTransfer, hidden: true },
  ];
  return menuRoutes.flatMap((group) => {
    const items = group.children.map((item) => ({
      title:
        item.meta.title === group.meta.title
          ? item.meta.title
          : `${group.meta.title} · ${item.meta.title}`,
      on: visible.has(item.name),
      hidden: Boolean(item.meta.hidden),
    }));
    return group.path === "/task" ? [...items, ...local] : items;
  });
}

test("菜单预览单源：已保存/草稿预览都与 menusFor 一致；ADMIN 全亮；未知码丢掉", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    const codes = ["device:box:list", "device:box:task", "sys:oplog:read"];
    await role(db, "80", "CUSTOM", 4, codes);

    const saved = await call(org.roleMenuPreview, { ...admin, params: { id: "80" } });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(saved.data.menus, expectedPreview(new Set(codes)));
    assert.deepEqual(saved.data.menus, menuPreviewFor(new Set(codes)));
    const byTitle = new Map(saved.data.menus.map((m) => [m.title, m.on]));
    assert.equal(byTitle.get("工作台"), true); // 无 perm 门，人人可见
    assert.equal(byTitle.get("采样箱"), true);
    assert.equal(byTitle.get("任务单"), true);
    assert.equal(byTitle.get("系统管理 · 操作日志"), true);
    assert.equal(byTitle.get("总览"), false); // 缺 monitor:overview
    assert.equal(byTitle.get("组织管理 · 部门"), false);
    // IA 迁移：采样箱组新增「默认策略」项，缺三码时 off（预览单源自动含新项）
    assert.equal(byTitle.get("采样箱 · 默认策略"), false);

    // ADMIN 固定全部权限 → 全部菜单亮
    const adminPreview = await call(org.roleMenuPreview, { ...admin, params: { id: "2" } });
    assert.equal(adminPreview.ok, true, adminPreview.error);
    assert.ok(adminPreview.data.menus.every((m) => m.on));

    // 草稿预览：未保存勾选的纯函数，同一实现；未知码丢掉
    const draft = await call(org.draftMenuPreview, {
      ...admin,
      body: { codes: ["monitor:overview", "bogus:code"] },
    });
    assert.equal(draft.ok, true, draft.error);
    assert.deepEqual(draft.data.menus, expectedPreview(new Set(["monitor:overview"])));
    const draftByTitle = new Map(draft.data.menus.map((m) => [m.title, m.on]));
    assert.equal(draftByTitle.get("总览"), true);
    assert.equal(draftByTitle.get("采样箱"), false);

    // 三码 some：只授电量预留一项，「默认策略」也亮（组内其余可见项仍按各自权限 off）
    const policyDraft = await call(org.draftMenuPreview, {
      ...admin,
      body: { codes: ["sys:settings:battery-reserve"] },
    });
    assert.equal(policyDraft.ok, true, policyDraft.error);
    const policyByTitle = new Map(policyDraft.data.menus.map((m) => [m.title, m.on]));
    assert.equal(policyByTitle.get("采样箱 · 默认策略"), true);
    assert.equal(policyByTitle.get("采样箱"), false); // 缺 device:box:list
    assert.equal(policyByTitle.get("采样箱 · 上报记录"), false);

    // 不存在的角色 → A0404
    const missing = await call(org.roleMenuPreview, { ...admin, params: { id: "999" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "A0404");
  } finally {
    await env.close();
  }
});

test("授权审计：grant/scope 变更写明细；现状含可转授；按日志范围裁剪（D1）", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const grantPerms = [
      "sys:role:view",
      "sys:role:update",
      "sys:role:scope",
      "sys:role:grant",
      "device:box:list",
      "device:box:task",
    ];
    await role(db, "80", "TARGET", 4);
    await role(db, "81", "GRANT2", 2, grantPerms); // 华南分公司（dept 2）
    await role(db, "82", "GRANT3", 3, grantPerms); // 同部门但 scope3
    await role(db, "83", "AGENCY", 2, ["sys:role:view"]); // 华东调度室（dept 31，组织简化后无机构层）
    await role(db, "84", "SELF4", 4, ["sys:role:view", "sys:role:grant", "device:box:list"]);
    await person(db, "96", "grant2", "2", ["81"]);
    await person(db, "97", "grant3", "2", ["82"]);
    await person(db, "98", "agency", "31", ["83"]);
    await person(db, "99", "self4", "21", ["84"]);
    const admin = await ctxOf(db, "admin");
    const grant2 = await ctxOf(db, "grant2");
    const grant3 = await ctxOf(db, "grant3");
    const agency = await ctxOf(db, "agency");
    const self4 = await ctxOf(db, "self4");

    // admin：授两项（一项可转授）→ 改自定义范围 5（dept 2）
    const saved = await call(org.saveRolePerms, {
      ...admin,
      params: { id: "80" },
      body: { codes: ["device:box:list", "device:box:task"], grantOption: ["device:box:list"] },
    });
    assert.equal(saved.ok, true, saved.error);
    const scoped = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: ["2"] },
    });
    assert.equal(scoped.ok, true, scoped.error);
    // grant2：开关可转授（list 关、task 开）
    const toggled = await call(org.saveRolePerms, {
      ...grant2,
      params: { id: "80" },
      body: { codes: ["device:box:list", "device:box:task"], grantOption: ["device:box:task"] },
    });
    assert.equal(toggled.ok, true, toggled.error);
    // grant3（scope3）想授 5 → 拒，失败也留痕
    const denied = await call(org.updateRole, {
      ...grant3,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: ["2"] },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    // self4（仅本人）：授自己可转授的一项
    const selfSave = await call(org.saveRolePerms, {
      ...self4,
      params: { id: "80" },
      body: { codes: ["device:box:list", "device:box:task"], grantOption: ["device:box:task"] },
    });
    assert.equal(selfSave.ok, true, selfSave.error);

    // admin 全量： newest first —— self4 的保存 → grant3 失败 → grant2 开关 → admin 改范围 → admin 授权
    const audit = await call(org.roleGrantAudit, { ...admin, params: { id: "80" } });
    assert.equal(audit.ok, true, audit.error);
    assert.equal(audit.data.role.dataScope, 5);
    assert.deepEqual(audit.data.role.deptIds, [{ id: "2", name: "华南分公司" }]);
    assert.equal(audit.data.current.total, 2);
    assert.deepEqual(audit.data.current.grantable, [
      { code: "device:box:task", label: permLabelOf("device:box:task") },
    ]);
    const actions = audit.data.entries.map((e) => `${e.actorName}:${e.action}:${e.result}`);
    assert.deepEqual(actions, [
      "self4:分配角色权限:成功",
      "grant3:修改角色:失败",
      "grant2:分配角色权限:成功",
      "系统管理员:修改角色:成功",
      "系统管理员:分配角色权限:成功",
    ]);
    const [selfEntry, failedEntry, toggleEntry, scopeEntry, grantEntry] = audit.data.entries;
    // 授权明细：加了哪两项、哪项开了可转授
    assert.deepEqual(
      grantEntry.detail.added.map((p) => p.code),
      ["device:box:list", "device:box:task"]
    );
    assert.deepEqual(
      grantEntry.detail.grantOn.map((p) => p.code),
      ["device:box:list"]
    );
    assert.deepEqual(grantEntry.detail.removed, []);
    // 范围明细：4→5 + 自定义部门
    assert.equal(scopeEntry.detail.scopeBefore, 4);
    assert.equal(scopeEntry.detail.scopeAfter, 5);
    assert.deepEqual(scopeEntry.detail.deptBefore, []);
    assert.deepEqual(scopeEntry.detail.deptAfter, [{ id: "2", name: "华南分公司" }]);
    // 可转授开关明细
    assert.deepEqual(
      toggleEntry.detail.grantOff.map((p) => p.code),
      ["device:box:list"]
    );
    assert.deepEqual(
      toggleEntry.detail.grantOn.map((p) => p.code),
      ["device:box:task"]
    );
    // 失败留痕、无明细
    assert.equal(failedEntry.detail, null);
    assert.equal(selfEntry.actorId, "99");

    // grant2（manage=[2,21]）：只看到 org 2/21 的——grant3 失败、自己的开关、self4 的保存；看不到 admin（org 11）
    const branchAudit = await call(org.roleGrantAudit, { ...grant2, params: { id: "80" } });
    assert.equal(branchAudit.ok, true, branchAudit.error);
    assert.deepEqual(
      branchAudit.data.entries.map((e) => e.actorName),
      ["self4", "grant3", "grant2"]
    );
    // agency（manage=[31]）：这个角色的授权都不在自己范围 → 空
    const agencyAudit = await call(org.roleGrantAudit, { ...agency, params: { id: "80" } });
    assert.equal(agencyAudit.ok, true, agencyAudit.error);
    assert.deepEqual(agencyAudit.data.entries, []);
    assert.equal(agencyAudit.data.current.total, 2); // 现状仍可读（角色读全局，设计内）
    // self4（仅本人）：只看到自己那条
    const selfAudit = await call(org.roleGrantAudit, { ...self4, params: { id: "80" } });
    assert.equal(selfAudit.ok, true, selfAudit.error);
    assert.deepEqual(
      selfAudit.data.entries.map((e) => e.actorId),
      ["99"]
    );
  } finally {
    await env.close();
  }
});

test("permCatalog.myScope：自己最宽范围（部门上限封顶）；createRole 自定义 5 落表且过 D3", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const grantPerms = ["sys:role:create", "sys:role:scope", "sys:role:view"];
    await role(db, "81", "GRANT2", 2, grantPerms);
    await role(db, "82", "GRANT3", 3, grantPerms);
    await person(db, "96", "grant2", "2", ["81"]);
    await person(db, "97", "grant3", "2", ["82"]);
    const admin = await ctxOf(db, "admin");
    const grant2 = await ctxOf(db, "grant2");
    const grant3 = await ctxOf(db, "grant3");

    assert.equal((await call(org.permCatalog, admin)).data.myScope, 1);
    assert.equal((await call(org.permCatalog, grant2)).data.myScope, 2);
    assert.equal((await call(org.permCatalog, grant3)).data.myScope, 3);
    // 部门上限封顶：dept 2 最大「本单位」→ grant2 的 myScope 变 3
    await db.run("UPDATE sys_dept SET max_data_scope = 3 WHERE id = '2'");
    const capped = await ctxOf(db, "grant2");
    assert.equal((await call(org.permCatalog, capped)).data.myScope, 3);
    await db.run("UPDATE sys_dept SET max_data_scope = NULL WHERE id = '2'");

    // createRole：自定义 5 建角色即落 sys_role_dept
    const created = await call(org.createRole, {
      ...admin,
      body: { name: "自定义新", code: "NEW5", dataScope: 5, deptIds: ["2", "31"] },
    });
    assert.equal(created.ok, true, created.error);
    const row = await db.get("SELECT id, data_scope FROM sys_role WHERE code = 'NEW5'");
    assert.equal(Number(row.data_scope), 5);
    const deptIds = (
      await db.all("SELECT dept_id FROM sys_role_dept WHERE role_id = ? ORDER BY dept_id", [
        String(row.id),
      ])
    ).map((r) => String(r.dept_id));
    assert.deepEqual(deptIds, ["2", "31"]);

    // D3：manage=[2,21] 的 grant2 建 5 选 31 → A0301；scope3 的 grant3 建 5 → A0301
    const beyond = await call(org.createRole, {
      ...grant2,
      body: { name: "越权", code: "BAD5A", dataScope: 5, deptIds: ["31"] },
    });
    assert.equal(beyond.ok, false);
    assert.equal(beyond.code, "A0301");
    const narrow = await call(org.createRole, {
      ...grant3,
      body: { name: "越权", code: "BAD5B", dataScope: 5, deptIds: ["2"] },
    });
    assert.equal(narrow.ok, false);
    assert.equal(narrow.code, "A0301");
    // 范围内可以
    const ok = await call(org.createRole, {
      ...grant2,
      body: { name: "范围内", code: "OK5", dataScope: 5, deptIds: ["21"] },
    });
    assert.equal(ok.ok, true, ok.error);
    // 没有 sys:role:scope 的角色建出来固定仅本人（既有口径不变）
    await role(db, "85", "NOSCOPE", 2, ["sys:role:create"]);
    await person(db, "95", "noscope", "2", ["85"]);
    const noScope = await ctxOf(db, "noscope");
    const forced = await call(org.createRole, {
      ...noScope,
      body: { name: "无范围权", code: "PLAIN", dataScope: 1 },
    });
    assert.equal(forced.ok, true, forced.error);
    assert.equal(
      Number((await db.get("SELECT data_scope FROM sys_role WHERE code = 'PLAIN'")).data_scope),
      4
    );
    // 审计里能看到新建角色的初始范围明细
    const audit = await call(org.roleGrantAudit, { ...admin, params: { id: String(row.id) } });
    assert.equal(audit.ok, true, audit.error);
    const createEntry = audit.data.entries.find((e) => e.action === "新增角色");
    assert.ok(createEntry);
    assert.equal(createEntry.detail.scope, 5);
    assert.deepEqual(createEntry.detail.deptIds, [
      { id: "2", name: "华南分公司" },
      { id: "31", name: "调度室" },
    ]);
  } finally {
    await env.close();
  }
});

/**
 * #26 review-26 minor 修复的行为断言（m-01/m-03/m-06/m-07）：
 * - m-01：isAdmin fail-closed——ctx 缺 access 不再恒真当管理员（直调 handler 也被拒）；
 * - m-03：deleteDepts 同步清 sys_role_dept，自定义范围不留悬空部门引用；
 * - m-06：menuPreviewFor 镜像前端 local-menus 注入——功能常开（无开关）+ R12/R24 仅「新建划拨」码时预览含调拨单
 *   （R24 #70 撤销下线：撤销码退出门禁，仅撤销码不再可见；组织简化 B4a/P9：送检单退役不镜像），
 *   预览可见项 = 真实侧栏（menusFor + local 注入）；旧 off 配置写入被忽略、恒列出；
 * - m-07：saveDeptLimit 成功审计写 detail（limited/maxScope 前后 + perms diff），无变化不写空明细。
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口。
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
import { ALL_PERMS } from "../src/auth/permCatalog.js";
import { applyBoxSettings, transferInspectEnabled } from "../src/settings/boxConfig.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review26-minors-"));
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

test("m-01 isAdmin fail-closed：缺 access 的直调不再当管理员，带 access 照常", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const adminUser = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await role(db, "80", "CUSTOM", 4);
    // 旧兜底 !ctx.access 恒真会全量放行：无 access 给角色授权现在必须拒（A0301/403），且权限没落库
    const denied = await call(org.saveRolePerms, {
      db,
      user: adminUser,
      params: { id: "80" },
      body: { codes: ["device:box:list"] },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    assert.equal(denied.status, 403);
    assert.equal((await db.all("SELECT perm FROM sys_role_perm WHERE role_id = '80'")).length, 0);
    // 免除改密只有管理员能做：无 access 同样拒
    const skip = await call(org.skipPasswordChange, {
      db,
      user: adminUser,
      params: { id: "2" },
    });
    assert.equal(skip.ok, false);
    assert.equal(skip.code, "A0301");
    // 解绑管理员账号的微信：无 access 时 guardUser 按非管理员拒（旧兜底会放行）
    const unbind = await call(org.unbindWechat, { db, user: adminUser, params: { id: "2" } });
    assert.equal(unbind.ok, false);
    assert.equal(unbind.code, "A0301");
    // 对照：dispatcher requireAccess 解析后的同一调用成功（HTTP 路径行为不变）
    const admin = await ctxOf(db, "admin");
    const ok = await call(org.saveRolePerms, {
      ...admin,
      params: { id: "80" },
      body: { codes: ["device:box:list"] },
    });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(await deptIdsOf(db, "80"), []); // 顺带确认非自定义角色没有 sys_role_dept 行
  } finally {
    await env.close();
  }
});

test("m-03 删除部门同步清 sys_role_dept：自定义范围不留悬空引用，既有守卫不变", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    // 两个叶子部门（无子级、无用户），分别被两个角色的自定义范围引用
    for (const [id, name] of [
      ["91", "临时一室"],
      ["92", "临时二室"],
    ])
      await db.run(
        "INSERT INTO sys_dept (id, parent_id, name, code, sort, status, type) VALUES (?, '2', ?, ?, 1, 1, '公司')",
        [id, name, `D${id}`]
      );
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('91', 'device:box:list')");
    await role(db, "80", "CUSTOM", 4);
    await role(db, "81", "CUSTOM2", 4);
    assert.equal(
      (
        await call(org.updateRole, {
          ...admin,
          params: { id: "80" },
          body: { dataScope: 5, deptIds: ["91", "2"] },
        })
      ).ok,
      true
    );
    assert.equal(
      (
        await call(org.updateRole, {
          ...admin,
          params: { id: "81" },
          body: { dataScope: 5, deptIds: ["92"] },
        })
      ).ok,
      true
    );
    assert.deepEqual(await deptIdsOf(db, "80"), ["2", "91"]);

    // 批量删除两个部门：sys_role_dept / sys_dept_perm / sys_dept 一起清
    const del = await call(org.deleteDepts, { ...admin, params: { id: "91,92" } });
    assert.equal(del.ok, true, del.error);
    assert.deepEqual(await deptIdsOf(db, "80"), ["2"]);
    assert.deepEqual(await deptIdsOf(db, "81"), []);
    assert.equal(
      (await db.all("SELECT * FROM sys_role_dept WHERE dept_id IN ('91', '92')")).length,
      0
    );
    assert.equal((await db.all("SELECT * FROM sys_dept_perm WHERE dept_id = '91'")).length, 0);
    assert.equal(await db.get("SELECT * FROM sys_dept WHERE id = '91'"), undefined);

    // resolveScope 不再把已删 id 纳入范围（引用 80 的人只剩 2 子树）
    await person(db, "95", "custom.user", "21", ["80"]);
    const access = await resolveAccess(db, await db.get("SELECT * FROM sys_user WHERE id = '95'"));
    assert.deepEqual([...access.scope.manageOrgIds].sort(), ["2", "21"]);
    assert.ok(access.scope.orgIds.includes("2"));
    assert.ok(!access.scope.orgIds.includes("91"));
    assert.ok(!access.scope.manageOrgIds.includes("91"));

    // 既有守卫不变：有用户的部门仍拒删
    const refused = await call(org.deleteDepts, { ...admin, params: { id: "21" } });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /用户/);
  } finally {
    await env.close();
  }
});

/** 用 menusFor 的裁剪结果独立重算每个菜单项的 on/off（同 role-grant-ui.test.js 口径）。
 * 功能常开：local-menus 调拨单组恒镜像（R12/R24 on 只看新建划拨——撤销码随功能下线退出），插在任务单组之后。 */
function expectedPreview(perms) {
  const visible = new Set(menusFor(perms).flatMap((g) => g.children.map((c) => c.name)));
  const canTransfer = perms.has("task:create:transfer");
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

/** 预览里「侧栏实际可见」的项（on 且非隐藏），保序。 */
const visibleTitles = (menus) => menus.filter((m) => m.on && !m.hidden).map((m) => m.title);

/**
 * 真实侧栏 = menusFor 裁剪 + local-menus 注入。
 * 镜像 src/router/local-menus.ts：功能常开（无开关），R12/R24 gate = 仅「新建划拨」码（撤销码已下线退出），
 * 调拨单组插在「任务单」组之后（mergeLocalMenus），隐藏详情不进侧栏。
 * 组织简化（B4a/P9）：送检单独立页退役——local-menus 不再注入送检单组，
 * 旧链接 /sample/inspections 只是隐藏重定向（不是侧栏项），预览也不列。
 */
function expectedSidebar(perms) {
  const out = [];
  const canTransfer = perms.has("task:create:transfer");
  for (const g of menusFor(perms)) {
    for (const c of g.children)
      if (!c.meta.hidden)
        out.push(
          c.meta.title === g.meta.title ? c.meta.title : `${g.meta.title} · ${c.meta.title}`
        );
    if (g.path === "/task" && canTransfer) out.push("调拨单");
  }
  return out;
}

const setFlag = (enabled) =>
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      batteryReserve: 20,
      arriveRadiusM: 2000,
      enableTransferInspect: enabled,
    },
  });

test("m-06 菜单预览镜像 local-menus：常开+新建划拨码含调拨单（R24 撤销码退出；送检单退役不列），预览=真实侧栏；旧 off 配置忽略、无建单码（含仅 box:task/仅撤销码）列出但 off", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    const codes = ["device:box:list", "device:box:task", "task:create:transfer"];
    await role(db, "80", "CUSTOM", 4, codes);
    const perms = new Set(codes);

    // 旧 off 配置（写入被忽略）：功能常开，预览恒含调拨单组（R12/R24 on 只看新建划拨码）
    setFlag(false);
    assert.equal(transferInspectEnabled(), true, "常开：off 配置不改守卫");
    const off = await call(org.roleMenuPreview, { ...admin, params: { id: "80" } });
    assert.equal(off.ok, true, off.error);
    assert.deepEqual(off.data.menus, expectedPreview(perms));
    assert.deepEqual(off.data.menus, menuPreviewFor(perms));
    assert.ok(!off.data.menus.some((m) => m.title.includes("送检")), "送检单退役，预览不镜像");
    assert.deepEqual(visibleTitles(off.data.menus), expectedSidebar(perms));

    // 旧 on 配置：同一结论（常开与配置值无关）；调拨单组两项列入（详情隐藏但可达），位置在任务单组之后
    setFlag(true);
    const on = await call(org.roleMenuPreview, { ...admin, params: { id: "80" } });
    assert.equal(on.ok, true, on.error);
    assert.deepEqual(on.data.menus, off.data.menus);
    const byTitle = new Map(on.data.menus.map((m) => [m.title, m]));
    assert.deepEqual(byTitle.get("调拨单"), { title: "调拨单", on: true, hidden: false });
    assert.deepEqual(byTitle.get("调拨单 · 划拨单详情"), {
      title: "调拨单 · 划拨单详情",
      on: true,
      hidden: true,
    });
    const titles = on.data.menus.map((m) => m.title);
    assert.ok(titles.indexOf("调拨单") > titles.indexOf("任务单"));
    assert.ok(titles.indexOf("调拨单") < titles.indexOf("采样箱"));
    // 预览可见项 = 真实侧栏（menusFor + local 注入，同 gate 同顺序）
    assert.deepEqual(visibleTitles(on.data.menus), expectedSidebar(perms));
    // 草稿预览同一实现
    const draft = await call(org.draftMenuPreview, { ...admin, body: { codes } });
    assert.equal(draft.ok, true, draft.error);
    assert.deepEqual(draft.data.menus, on.data.menus);

    // 常开但无两码：列出但全 off（侧栏确实不注入）
    const noTask = await call(org.draftMenuPreview, {
      ...admin,
      body: { codes: ["device:box:list"] },
    });
    assert.equal(noTask.ok, true, noTask.error);
    assert.equal(noTask.data.menus.find((m) => m.title === "调拨单").on, false);
    assert.equal(noTask.data.menus.find((m) => m.title === "调拨单 · 划拨单详情").on, false);
    assert.deepEqual(
      visibleTitles(noTask.data.menus),
      expectedSidebar(new Set(["device:box:list"]))
    );

    // R12 收紧：仅 device:box:task（值守/核验/只读领导模板）无两码 → 调拨单 off
    const dutyLike = await call(org.draftMenuPreview, {
      ...admin,
      body: { codes: ["device:box:list", "device:box:task"] },
    });
    assert.equal(dutyLike.ok, true, dutyLike.error);
    assert.equal(dutyLike.data.menus.find((m) => m.title === "调拨单").on, false);
    assert.equal(dutyLike.data.menus.find((m) => m.title === "调拨单 · 划拨单详情").on, false);
    assert.ok(!visibleTitles(dutyLike.data.menus).includes("调拨单"));

    // R24（#70）撤销下线：仅撤销码（无新建码）不再可见——撤销码退出门禁（原 R12 some 口径作废）
    const revokeOnly = await call(org.draftMenuPreview, {
      ...admin,
      body: { codes: ["device:box:list", "task:transfer:revoke"] },
    });
    assert.equal(revokeOnly.ok, true, revokeOnly.error);
    assert.equal(revokeOnly.data.menus.find((m) => m.title === "调拨单").on, false);

    // 再写 off：仍常开列出（写入被忽略，不是标 off、也不是不列）
    setFlag(false);
    const offAgain = await call(org.draftMenuPreview, { ...admin, body: { codes } });
    assert.deepEqual(offAgain.data.menus, expectedPreview(perms));
  } finally {
    setFlag(false);
    await env.close();
  }
});

test("m-07 部门上限变更审计写 detail：limited/maxScope 前后 + perms diff；无变化不写、失败无明细", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    const latest = async (targetId) =>
      db.get(
        "SELECT detail, result FROM sys_operation_log WHERE action = '设置部门权限上限' AND target_id = ? ORDER BY id DESC LIMIT 1",
        [targetId]
      );

    // 不限 → 受限 2 项 + maxScope 2：顶级部门无上级，不限=全部 → 收紧的 removed 是其余全部项
    const first = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: { limited: true, perms: ["device:box:list", "device:box:task"], maxScope: 2 },
    });
    assert.equal(first.ok, true, first.error);
    const row = await latest("2");
    assert.equal(row.result, "成功");
    let d = JSON.parse(row.detail);
    assert.equal(d.limitedBefore, false);
    assert.equal(d.limitedAfter, true);
    assert.equal(d.maxScopeBefore, null);
    assert.equal(d.maxScopeAfter, 2);
    assert.deepEqual(d.added, []);
    assert.ok(d.removed.includes("device:box:export"));
    assert.ok(!d.removed.includes("device:box:list"));
    assert.equal(d.removed.length, ALL_PERMS.length - 2);

    // 加一项 + 放宽范围：diff 只记这次变的
    const second = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: {
        limited: true,
        perms: ["device:box:list", "device:box:task", "device:box:detail"],
        maxScope: 3,
      },
    });
    assert.equal(second.ok, true, second.error);
    d = JSON.parse((await latest("2")).detail);
    assert.deepEqual(d, {
      limitedBefore: true,
      limitedAfter: true,
      maxScopeBefore: 2,
      maxScopeAfter: 3,
      added: ["device:box:detail"],
      removed: [],
    });

    // 失败留痕但无明细（没改成）：下级勾上级没有的项 → A0301
    const denied = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "21" },
      body: { limited: true, perms: ["device:box:export"] },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    const failRow = await latest("21");
    assert.equal(failRow.result, "失败");
    assert.equal(failRow.detail, "");

    // 改回跟上级一样（放开）：added = 上级允许的全部 − 原来勾的
    const third = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: { limited: false },
    });
    assert.equal(third.ok, true, third.error);
    d = JSON.parse((await latest("2")).detail);
    assert.equal(d.limitedBefore, true);
    assert.equal(d.limitedAfter, false);
    assert.equal(d.maxScopeBefore, 3);
    assert.equal(d.maxScopeAfter, null);
    assert.equal(d.added.length, ALL_PERMS.length - 3);
    assert.ok(d.added.includes("device:box:export"));
    assert.deepEqual(d.removed, []);

    // 无任何变化再存一次：不写空明细（同 saveRolePerms 口径）
    const again = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: { limited: false },
    });
    assert.equal(again.ok, true, again.error);
    assert.equal((await latest("2")).detail, "");
  } finally {
    await env.close();
  }
});

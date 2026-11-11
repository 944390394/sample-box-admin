import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { up as splitMigration } from "../migrations/039_split_perms.js";
import { up as pointsMigration } from "../migrations/043_perm_points_grant_option.js";
import * as org from "../org-api.js";
import { resolveAccess } from "../src/auth/boxAccess.js";
import {
  ALL_PERMS,
  PERM_GROUPS,
  grantsAll,
  split043,
  splitPerms,
} from "../src/auth/permCatalog.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "perm-grant-"));
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
    ...ctx,
    ok: (data) => (out = { ok: true, data }),
    fail: (message) => (out = { ok: false, error: message }),
  });
  return out;
}

const NOW = "2026-11-05 10:00:00";
async function role(db, id, code, scope, perms) {
  await db.run(
    "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
    [id, `角色${code}`, code, scope, NOW, NOW]
  );
  // 和升级、新库一样：能授权的角色自己的权限默认都可转授
  for (const perm of perms)
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
      id,
      perm,
      grantsAll(perms) ? 1 : 0,
    ]);
}
async function user(db, id, username, dept, roles) {
  await db.run(
    "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES (?, ?, ?, 'x', ?, 1)",
    [id, username, username, dept]
  );
  for (const r of roles)
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, r]);
}
async function ctxOf(db, id) {
  const row = await db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
  return { db, user: row, access: await resolveAccess(db, row) };
}
const rolesOf = async (db, id) =>
  (await db.all("SELECT role_id FROM sys_user_role WHERE user_id = ? ORDER BY role_id", [id])).map(
    (r) => String(r.role_id)
  );
const permsOf = async (db, id) =>
  (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ? ORDER BY perm", [id])).map(
    (r) => r.perm
  );

test("权限目录：每项都在某一组里（两个不起作用的工作台项除外），前置条件都是认识的码，授权单独一组", () => {
  const shown = new Set(PERM_GROUPS.flatMap((g) => g.items.map((i) => i.code)));
  const hidden = ALL_PERMS.map((p) => p.code).filter((code) => !shown.has(code));
  assert.deepEqual(hidden, []);
  // 名称和说明不用「等」带过
  for (const perm of ALL_PERMS) assert.ok(!/等/.test(perm.label + perm.hint), perm.code);
  // 每项都在一个模块、一个分段里
  for (const perm of ALL_PERMS) assert.ok(["enter", "see", "do"].includes(perm.tier), perm.code);
  const known = new Set(ALL_PERMS.map((p) => p.code));
  for (const item of PERM_GROUPS.flatMap((g) => g.items)) {
    assert.ok(item.label, item.code);
    for (const need of item.needs || []) assert.ok(known.has(need), `${item.code} needs ${need}`);
  }
  const grant = PERM_GROUPS.find((g) => g.key === "grant");
  assert.deepEqual(
    grant.items.map((i) => i.code),
    [
      "sys:role:view",
      "sys:role:create",
      "sys:role:update",
      "sys:role:delete",
      "sys:role:grant",
      "sys:role:scope",
      "sys:user:role",
      "sys:dept:limit",
    ]
  );
  // 一个动作一个权限：不再有合在一起的老码
  for (const old of ["sys:dept:write", "sys:user:write", "sys:user:security", "sys:role:write"])
    assert.ok(!known.has(old), old);
});

test("迁移 039：原来有位置、编辑角色、编辑人员的角色补上历史轨迹、分配权限、分配角色，行为不变", async () => {
  assert.deepEqual(splitPerms(["device:box:location", "sys:role:write", "sys:user:write"]), [
    "device:box:track",
    "sys:role:grant",
    "sys:user:role",
  ]);
  assert.deepEqual(splitPerms(["device:box:location", "device:box:track"]), []);
  const env = await fresh();
  try {
    await role(env.db, "50", "OLD", 3, ["device:box:location", "sys:user:write"]);
    await role(env.db, "51", "PLAIN", 3, ["device:box:list"]);
    await splitMigration(env.db);
    assert.deepEqual(await permsOf(env.db, "50"), [
      "device:box:location",
      "device:box:track",
      "sys:user:role",
      "sys:user:write",
    ]);
    assert.deepEqual(await permsOf(env.db, "51"), ["device:box:list"]);
  } finally {
    await env.close();
  }
});

test("给人员分配角色：要单独的权限，只能分配权限和数据范围都不超过自己的角色", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await db.run(
      "INSERT INTO sys_dept (id, parent_id, name, code, sort, status) VALUES ('2', '0', '华南', 'S', 1, 1)"
    );
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "2", "HR", 2, ["sys:user:view", "sys:user:update", "device:box:list"]);
    await role(db, "3", "BIG", 3, ["device:box:list", "device:box:export"]);
    await role(db, "4", "SMALL", 3, ["device:box:list"]);
    await role(db, "5", "WIDE", 1, ["device:box:list"]);
    await role(db, "6", "OK", 3, []);
    await user(db, "10", "hr", "2", ["2"]);
    await user(db, "11", "staff", "2", ["4"]);

    let hr = await ctxOf(db, "10");
    // 没有「给人员分配角色」：改资料可以，改角色不行
    const rename = await call(org.updateUser, {
      ...hr,
      params: { id: "11" },
      body: { nickname: "新名字", deptId: "2", roleIds: ["4"] },
    });
    assert.equal(rename.ok, true, rename.error);
    const denied = await call(org.updateUser, {
      ...hr,
      params: { id: "11" },
      body: { roleIds: ["4", "6"] },
    });
    assert.match(denied.error, /给人员分配角色/);
    assert.match(
      (
        await call(org.createUser, {
          ...hr,
          body: { username: "new.one", nickname: "新人", deptId: "2", roleIds: ["6"] },
        })
      ).error,
      /给人员分配角色/
    );

    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('2', 'sys:user:role')");
    await db.run("UPDATE sys_role_perm SET grantable = 1 WHERE role_id = '2'");
    hr = await ctxOf(db, "10");
    assert.match(
      (await call(org.updateUser, { ...hr, params: { id: "11" }, body: { roleIds: ["4", "3"] } }))
        .error,
      /不能转授的权限/
    );
    assert.match(
      (await call(org.updateUser, { ...hr, params: { id: "11" }, body: { roleIds: ["4", "5"] } }))
        .error,
      /数据范围比你的宽/
    );
    assert.match(
      (await call(org.updateUser, { ...hr, params: { id: "11" }, body: { roleIds: ["1"] } })).error,
      /系统管理员/
    );
    const ok = await call(org.updateUser, {
      ...hr,
      params: { id: "11" },
      body: { roleIds: ["4", "6"] },
    });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(await rolesOf(db, "11"), ["4", "6"]);

    // 表单里的角色选项：不能分配的灰掉并说明原因
    const options = (await call(org.roleOptions, hr)).data;
    const byCode = Object.fromEntries(options.map((o) => [o.label.replace("角色", ""), o]));
    assert.equal(byCode.SMALL.disabled, undefined);
    assert.equal(byCode.BIG.disabled, true);
    assert.match(byCode.WIDE.reason, /数据范围/);
    assert.equal(byCode.ADMIN.disabled, true);
  } finally {
    await env.close();
  }
});

test("给角色分配权限：要单独的权限，只能授予或收回自己有的；数据范围也算授权", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await db.run(
      "INSERT INTO sys_dept (id, parent_id, name, code, sort, status) VALUES ('2', '0', '华南', 'S', 1, 1)"
    );
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "2", "GRANTER", 2, [
      "sys:role:view",
      "sys:role:create",
      "sys:role:update",
      "sys:role:delete",
      "sys:role:grant",
      "sys:role:scope",
      "device:box:list",
      "device:box:detail",
    ]);
    await role(db, "3", "EDITOR", 2, [
      "sys:role:view",
      "sys:role:create",
      "sys:role:update",
      "sys:role:delete",
    ]);
    await role(db, "4", "TARGET", 3, ["device:box:list", "device:box:export"]);
    await user(db, "10", "granter", "2", ["2"]);
    await user(db, "11", "editor", "2", ["3"]);
    const granter = await ctxOf(db, "10");
    const editor = await ctxOf(db, "11");

    // 能改哪些：有分配权限的给自己有的码，没有的给空
    assert.ok(
      (await call(org.rolePerms, { ...granter, params: { id: "4" } })).data.assignable.includes(
        "device:box:detail"
      )
    );
    assert.deepEqual(
      (await call(org.rolePerms, { ...editor, params: { id: "4" } })).data.assignable,
      []
    );

    // 角色上原来就有、自己没有的（导出）不动，加自己有的（详情）可以
    const added = await call(org.saveRolePerms, {
      ...granter,
      params: { id: "4" },
      body: { codes: ["device:box:list", "device:box:export", "device:box:detail"] },
    });
    assert.equal(added.ok, true, added.error);
    // 收回自己没有的不行，授予自己没有的也不行
    assert.match(
      (
        await call(org.saveRolePerms, {
          ...granter,
          params: { id: "4" },
          body: { codes: ["device:box:list"] },
        })
      ).error,
      /导出采样箱清单/
    );
    assert.match(
      (
        await call(org.saveRolePerms, {
          ...granter,
          params: { id: "4" },
          body: {
            codes: [
              "device:box:list",
              "device:box:export",
              "device:box:detail",
              "device:box:delete",
            ],
          },
        })
      ).error,
      /删除采样箱档案/
    );
    assert.deepEqual(await permsOf(db, "4"), [
      "device:box:detail",
      "device:box:export",
      "device:box:list",
    ]);

    // 数据范围：没有分配权限不能改，有也不能比自己宽；改名不受影响
    assert.match(
      (
        await call(org.updateRole, {
          ...editor,
          params: { id: "4" },
          body: { name: "改名", dataScope: 2 },
        })
      ).error,
      /设置角色数据范围/
    );
    assert.equal(
      (
        await call(org.updateRole, {
          ...editor,
          params: { id: "4" },
          body: { name: "改名", dataScope: 3, code: "HACK" },
        })
      ).ok,
      true
    );
    const renamed = await db.get("SELECT name, code, data_scope FROM sys_role WHERE id = '4'");
    assert.deepEqual(
      [renamed.name, renamed.code, Number(renamed.data_scope)],
      ["改名", "TARGET", 3]
    );
    assert.match(
      (await call(org.updateRole, { ...granter, params: { id: "4" }, body: { dataScope: 1 } }))
        .error,
      /比你自己的宽/
    );
    assert.equal(
      (await call(org.updateRole, { ...granter, params: { id: "4" }, body: { dataScope: 2 } })).ok,
      true
    );

    // 系统管理员角色：非管理员不能改，谁也不能停用
    assert.match(
      (await call(org.updateRole, { ...granter, params: { id: "1" }, body: { name: "x" } })).error,
      /只有系统管理员/
    );
    assert.match(
      (await call(org.updateRole, { db, params: { id: "1" }, body: { status: 0 } })).error,
      /不能停用/
    );

    // 没有分配权限时新建的角色只看本人；有也不能比自己宽
    await call(org.createRole, { ...editor, body: { name: "新角色", code: "NEW1", dataScope: 1 } });
    assert.equal(
      Number((await db.get("SELECT data_scope FROM sys_role WHERE code = 'NEW1'")).data_scope),
      4
    );
    assert.match(
      (
        await call(org.createRole, {
          ...granter,
          body: { name: "新角色2", code: "NEW2", dataScope: 1 },
        })
      ).error,
      /比你自己的宽/
    );

    // 删角色等于收回：权限比自己多的角色删不了
    assert.match(
      (await call(org.deleteRoles, { ...editor, params: { id: "4" } })).error,
      /不能删除/
    );
  } finally {
    await env.close();
  }
});

test("迁移 043：合在一起的老码拆成一个动作一个权限；能授权的角色自己的权限全部可转授", async () => {
  assert.deepEqual(split043(["sys:user:security", "device:box:list"]), {
    add: [
      "sys:user:reset-password",
      "sys:user:force-password",
      "sys:user:unlock",
      "sys:user:kick",
      "sys:user:unbind-wechat",
    ],
    remove: ["sys:user:security"],
  });
  const env = await fresh();
  const { db } = env;
  try {
    const raw = async (id, code, perms) => {
      await db.run(
        "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, ?, 3, 1, 1, ?, ?)",
        [id, code, code, NOW, NOW]
      );
      for (const perm of perms)
        await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES (?, ?)", [id, perm]);
    };
    await raw("60", "OLD_HR", [
      "sys:user:view",
      "sys:user:write",
      "sys:user:security",
      "sys:dept:write",
    ]);
    await raw("61", "OLD_GRANT", [
      "sys:role:view",
      "sys:role:write",
      "sys:role:grant",
      "device:box:list",
    ]);
    await pointsMigration(db);
    assert.deepEqual(await permsOf(db, "60"), [
      "sys:dept:create",
      "sys:dept:delete",
      "sys:dept:update",
      "sys:user:create",
      "sys:user:delete",
      "sys:user:disable",
      "sys:user:force-password",
      "sys:user:kick",
      "sys:user:reset-password",
      "sys:user:unbind-wechat",
      "sys:user:unlock",
      "sys:user:update",
      "sys:user:view",
    ]);
    const passed = async (id) =>
      (
        await db.all(
          "SELECT perm FROM sys_role_perm WHERE role_id = ? AND grantable = 1 ORDER BY perm",
          [id]
        )
      ).map((r) => r.perm);
    assert.deepEqual(await passed("60"), []);
    assert.deepEqual(await passed("61"), [
      "device:box:list",
      "sys:role:create",
      "sys:role:delete",
      "sys:role:grant",
      "sys:role:update",
      "sys:role:view",
    ]);
    // 再跑一次不重复
    await pointsMigration(db);
    assert.equal((await permsOf(db, "61")).length, 6);
  } finally {
    await env.close();
  }
});

test("可转授：自己有但没开「可转授」的权限不能授给别人，也不能把含它的角色分给别人；开关本身也只能改自己可转授的", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await db.run(
      "INSERT INTO sys_dept (id, parent_id, name, code, sort, status) VALUES ('2', '0', '华南', 'S', 1, 1)"
    );
    await role(db, "2", "GRANTER", 2, [
      "sys:role:view",
      "sys:role:grant",
      "sys:user:view",
      "sys:user:role",
      "device:box:list",
      "device:box:detail",
      "device:box:export",
    ]);
    // 导出清单：自己能用，但没有转授权
    await db.run(
      "UPDATE sys_role_perm SET grantable = 0 WHERE role_id = '2' AND perm = 'device:box:export'"
    );
    await role(db, "4", "TARGET", 3, ["device:box:list"]);
    await role(db, "5", "EXPORTER", 3, ["device:box:list", "device:box:export"]);
    await user(db, "10", "granter", "2", ["2"]);
    await user(db, "11", "staff", "2", ["4"]);
    const granter = await ctxOf(db, "10");
    assert.ok(granter.access.perms.has("device:box:export"));
    assert.ok(!granter.access.grantable.has("device:box:export"));

    const view = (await call(org.rolePerms, { ...granter, params: { id: "4" } })).data;
    assert.ok(view.assignable.includes("device:box:detail"));
    assert.ok(!view.assignable.includes("device:box:export"));
    assert.deepEqual(view.grantOption, []);

    assert.match(
      (
        await call(org.saveRolePerms, {
          ...granter,
          params: { id: "4" },
          body: { codes: ["device:box:list", "device:box:export"] },
        })
      ).error,
      /不能转授.*导出采样箱清单/
    );
    // 能转授的可以授，还能连同可转授一起给
    const ok = await call(org.saveRolePerms, {
      ...granter,
      params: { id: "4" },
      body: { codes: ["device:box:list", "device:box:detail"], grantOption: ["device:box:detail"] },
    });
    assert.equal(ok.ok, true, ok.error);
    const after = (await call(org.rolePerms, { ...granter, params: { id: "4" } })).data;
    assert.deepEqual(after.grantOption, ["device:box:detail"]);
    // 不传 grantOption 时保留原来的开关
    await call(org.saveRolePerms, {
      ...granter,
      params: { id: "4" },
      body: { codes: ["device:box:list", "device:box:detail"] },
    });
    assert.deepEqual(
      (await call(org.rolePerms, { ...granter, params: { id: "4" } })).data.grantOption,
      ["device:box:detail"]
    );

    // 角色 EXPORTER 里有导出：自己能用也不能分给别人
    assert.match(
      (
        await call(org.updateUser, {
          ...granter,
          params: { id: "11" },
          body: { roleIds: ["4", "5"] },
        })
      ).error,
      /不能转授的权限/
    );
    // 系统管理员不受限
    const admin = {
      db,
      user: { id: "1" },
      access: {
        roles: ["ADMIN"],
        perms: new Set(ALL_PERMS.map((p) => p.code)),
        grantable: new Set(ALL_PERMS.map((p) => p.code)),
        scope: { all: true, orgIds: [], ownerIds: [] },
      },
    };
    assert.equal(
      (
        await call(org.saveRolePerms, {
          ...admin,
          params: { id: "5" },
          body: {
            codes: ["device:box:list", "device:box:export"],
            grantOption: ["device:box:export"],
          },
        })
      ).ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("人员：改资料、停用、分配角色各要各的权限", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await db.run(
      "INSERT INTO sys_dept (id, parent_id, name, code, sort, status) VALUES ('2', '0', '华南', 'S', 1, 1)"
    );
    await role(db, "2", "STOPPER", 2, ["sys:user:view", "sys:user:disable"]);
    await role(db, "4", "SMALL", 3, ["device:box:list"]);
    await user(db, "10", "stopper", "2", ["2"]);
    await user(db, "11", "staff", "2", ["4"]);
    const stopper = await ctxOf(db, "10");
    assert.match(
      (await call(org.updateUser, { ...stopper, params: { id: "11" }, body: { nickname: "改名" } }))
        .error,
      /编辑人员资料/
    );
    const off = await call(org.updateUser, {
      ...stopper,
      params: { id: "11" },
      body: { status: 0, roleIds: ["4"] },
    });
    assert.equal(off.ok, true, off.error);
    assert.equal(Number((await db.get("SELECT status FROM sys_user WHERE id = '11'")).status), 0);
  } finally {
    await env.close();
  }
});

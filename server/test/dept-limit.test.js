import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { up as detailMigration } from "../migrations/045_perm_points_detail.js";
import * as org from "../org-api.js";
import { BOX, maskBox, resolveAccess } from "../src/auth/boxAccess.js";
import { ALL_PERMS, cardsFor, grantsAll, upgradeCodes } from "../src/auth/permCatalog.js";
import { receiveCheck } from "../src/settings/receiveCheck.js";
import { filterEvents } from "../src/http/SampleController.js";

const NOW = "2026-11-06 10:00:00";
async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dept-limit-"));
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
    ...ctx,
    ok: (data, message) => (out = { ok: true, data, message }),
    fail: (message) => (out = { ok: false, error: message }),
  });
  return out;
}
async function dept(db, id, parent, name, type = "公司") {
  await db.run(
    "INSERT INTO sys_dept (id, parent_id, name, code, sort, status, type) VALUES (?, ?, ?, ?, 1, 1, ?)",
    [id, parent, name, `D${id}`, type]
  );
}
async function role(db, id, code, scope, perms) {
  await db.run(
    "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
    [id, `角色${code}`, code, scope, NOW, NOW]
  );
  for (const perm of perms)
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
      id,
      perm,
      grantsAll(perms) ? 1 : 0,
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

test("部门权限上限：实际权限 = 角色 ∩ 每一级上限；下级不能超过上级；上级收紧后下级多出的部分不生效；数据范围也封顶", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await dept(db, "2", "0", "华南分公司");
    await dept(db, "21", "2", "调度室");
    await role(db, "1", "ADMIN", 1, []);
    await role(db, "5", "WIDE", 1, [
      "device:box:list",
      "device:box:detail",
      "device:box:export",
      "sys:user:view",
      "sys:user:delete",
    ]);
    await user(db, "1", "admin", "1", ["1"]);
    await user(db, "10", "south", "21", ["5"]);
    const admin = await ctxOf(db, "1");

    // 不限时角色给什么就有什么
    let south = await ctxOf(db, "10");
    assert.ok(south.access.perms.has("sys:user:delete"));
    assert.equal(south.access.scope.all, true);

    // 华南分公司：最多 4 项，最大数据范围「本单位及下级」
    const saved = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: {
        limited: true,
        perms: ["device:box:list", "device:box:detail", "sys:user:view", "sys:user:delete"],
        maxScope: 2,
      },
    });
    assert.equal(saved.ok, true, saved.error);
    south = await ctxOf(db, "10");
    assert.ok(!south.access.perms.has("device:box:export"), "上级没给导出，角色里有也不生效");
    assert.ok(south.access.perms.has("sys:user:delete"));
    assert.equal(south.access.scope.all, false, "角色是全部数据，被部门封顶到本单位及下级");
    assert.deepEqual(south.access.scope.manageOrgIds.sort(), ["21"]);

    // 下级（调度室）只能在上级范围里勾
    const beyond = await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "21" },
      body: { limited: true, perms: ["device:box:list", "device:box:export"] },
    });
    assert.match(beyond.error, /上级部门没有这几项.*导出采样箱清单/);
    assert.match(
      (
        await call(org.saveDeptLimit, {
          ...admin,
          params: { id: "21" },
          body: { limited: true, perms: ["device:box:list"], maxScope: 1 },
        })
      ).error,
      /不能比上级部门/
    );
    assert.equal(
      (
        await call(org.saveDeptLimit, {
          ...admin,
          params: { id: "21" },
          body: {
            limited: true,
            perms: ["device:box:list", "sys:user:view", "sys:user:delete"],
            maxScope: 3,
          },
        })
      ).ok,
      true
    );

    // 上级收紧：收回「删除人员」，下级存着的不删，但不生效
    await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "2" },
      body: {
        limited: true,
        perms: ["device:box:list", "device:box:detail", "sys:user:view"],
        maxScope: 2,
      },
    });
    south = await ctxOf(db, "10");
    assert.ok(!south.access.perms.has("sys:user:delete"));
    const view = (await call(org.deptLimit, { ...admin, params: { id: "21" } })).data;
    assert.ok(view.perms.includes("sys:user:delete"), "下级存着的还在");
    assert.ok(!view.effective.perms.includes("sys:user:delete"), "但实际上限里没有");
    assert.equal(view.effective.maxScope, 3);

    // 实际权限：逐项说明来源和被谁挡住
    const eff = (await call(org.effectivePerms, { ...admin, params: { id: "10" } })).data;
    const del = eff.items.find((item) => item.code === "sys:user:delete");
    assert.deepEqual([del.has, del.roles, del.cutBy], [false, ["角色WIDE"], "华南分公司"]);
    const list = eff.items.find((item) => item.code === "device:box:list");
    assert.deepEqual([list.has, list.cutBy], [true, ""]);
    assert.equal(eff.scope.effective, "本单位");
    assert.deepEqual(
      eff.chain.map((d) => [d.name, d.limited]),
      [
        ["华南分公司", true],
        ["调度室", true],
      ]
    );

    // 改回跟上级一样
    await call(org.saveDeptLimit, { ...admin, params: { id: "21" }, body: { limited: false } });
    south = await ctxOf(db, "10");
    assert.equal(south.access.limit.chain.find((d) => d.id === "21").limited, false);

    // 系统管理员不受部门上限约束
    await call(org.saveDeptLimit, {
      ...admin,
      params: { id: "1" },
      body: { limited: true, perms: [] },
    });
    const again = await ctxOf(db, "1");
    assert.equal(again.access.perms.size, ALL_PERMS.length);
  } finally {
    await env.close();
  }
});

test("部门上限的非管理员规则：只能设管理范围里的部门、只能动自己可转授的；可转授也被上限裁掉", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "2", "0", "华南分公司");
    await dept(db, "21", "2", "调度室");
    await dept(db, "3", "0", "华东分公司");
    await role(db, "6", "BRANCH", 2, [
      "sys:dept:view",
      "sys:dept:limit",
      "sys:user:view",
      "sys:user:role",
      "device:box:list",
      "device:box:detail",
    ]);
    await user(db, "10", "boss", "2", ["6"]);
    let boss = await ctxOf(db, "10");
    assert.match(
      (
        await call(org.saveDeptLimit, {
          ...boss,
          params: { id: "3" },
          body: { limited: true, perms: [] },
        })
      ).error,
      /管理范围/
    );
    // 收紧可以：调度室从不限改成只能看清单
    const ok = await call(org.saveDeptLimit, {
      ...boss,
      params: { id: "21" },
      body: { limited: true, perms: ["device:box:list"], maxScope: 3 },
    });
    assert.equal(ok.ok, true, ok.error);
    // 放开要自己可转授：再加「导出」不行（分公司管理员自己没有导出）
    assert.match(
      (
        await call(org.saveDeptLimit, {
          ...boss,
          params: { id: "21" },
          body: { limited: true, perms: ["device:box:list", "device:box:export"] },
        })
      ).error,
      /不能转授.*导出采样箱清单/
    );
    // 改回跟上级一样等于放开到上级的范围（不限 = 全部），自己转授不了全部
    assert.match(
      (await call(org.saveDeptLimit, { ...boss, params: { id: "21" }, body: { limited: false } }))
        .error,
      /不能转授/
    );
    // 加自己能转授的可以
    assert.equal(
      (
        await call(org.saveDeptLimit, {
          ...boss,
          params: { id: "21" },
          body: { limited: true, perms: ["device:box:list", "device:box:detail"], maxScope: 3 },
        })
      ).ok,
      true
    );
    assert.match(
      (
        await call(org.saveDeptLimit, {
          ...boss,
          params: { id: "21" },
          body: { limited: true, perms: ["device:box:list"], maxScope: 1 },
        })
      ).error,
      /比你自己的宽/
    );

    // 可转授叠加上限：华南被限制后，分公司管理员自己也转授不了被裁掉的项
    await db.run("UPDATE sys_dept SET perm_limited = 1 WHERE id = '2'");
    for (const perm of [
      "sys:dept:view",
      "sys:dept:limit",
      "sys:user:view",
      "sys:user:role",
      "device:box:list",
    ])
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', ?)", [perm]);
    boss = await ctxOf(db, "10");
    assert.ok(!boss.access.perms.has("device:box:detail"));
    assert.ok(!boss.access.grantable.has("device:box:detail"));
    assert.ok(boss.access.grantable.has("device:box:list"));

    // 授权界面上灰掉的项写清原因：被部门上限挡住、自己没有
    const limit = await call(org.deptLimit, { ...boss, params: { id: "21" } });
    assert.equal(limit.data.editable, true);
    assert.match(limit.data.reasons["device:box:detail"], /华南分公司.*上限挡住/);
    assert.match(limit.data.reasons["device:box:export"], /你自己没有/);
    assert.equal(limit.data.reasons["device:box:list"], undefined);
  } finally {
    await env.close();
  }
});

test("管人范围不含上级部门；部门的类型、地址、监控、负责人各要各的权限，顺手建负责人账号要过人员和角色检查", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await dept(db, "2", "0", "华南分公司");
    await dept(db, "21", "2", "调度室");
    await role(db, "7", "DESK", 3, [
      "sys:user:view",
      "sys:user:update",
      "sys:dept:view",
      "sys:dept:update",
      "sys:dept:create",
    ]);
    await role(db, "8", "BIG", 1, ["device:box:list", "device:box:export"]);
    await user(db, "10", "desk", "21", ["7"]);
    await user(db, "11", "upper", "2", []);
    await user(db, "12", "peer", "21", []);
    const desk = await ctxOf(db, "10");
    // 看箱子含上级单位，管人只有本部门
    assert.ok(desk.access.scope.orgIds.includes("2"));
    assert.deepEqual(desk.access.scope.manageOrgIds, ["21"]);
    assert.match(
      (
        await call(org.updateUser, {
          ...desk,
          params: { id: "11" },
          body: { nickname: "改上级的人" },
        })
      ).error,
      /管理范围|数据范围/
    );
    assert.equal(
      (await call(org.updateUser, { ...desk, params: { id: "12" }, body: { nickname: "同部门" } }))
        .ok,
      true
    );

    // 部门：只有「编辑部门基本信息」，改类型、地址不行；改名可以
    assert.match(
      (await call(org.updateDept, { ...desk, params: { id: "21" }, body: { type: "采样机构" } }))
        .error,
      /设置部门类型/
    );
    assert.match(
      (
        await call(org.updateDept, {
          ...desk,
          params: { id: "21" },
          body: { address: "深圳某路", lng: 114.1, lat: 22.6 },
        })
      ).error,
      /设置部门地址和联系人/
    );
    assert.equal(
      (await call(org.updateDept, { ...desk, params: { id: "21" }, body: { name: "调度一室" } }))
        .ok,
      true
    );
    // 上级部门改不了
    assert.match(
      (await call(org.updateDept, { ...desk, params: { id: "2" }, body: { name: "改上级" } }))
        .error,
      /管理范围/
    );
    // 新建部门时顺手建负责人账号：要「指定部门负责人」「新增人员」，给角色还要过可转授
    const leader = { create: { nickname: "新负责人", username: "new.lead", roleIds: ["8"] } };
    assert.match(
      (
        await call(org.createDept, {
          ...desk,
          body: { name: "二室", code: "D2X", parentId: "21", leader },
        })
      ).error,
      /指定部门负责人/
    );
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('7', 'sys:dept:leader')");
    let desk2 = await ctxOf(db, "10");
    assert.match(
      (
        await call(org.createDept, {
          ...desk2,
          body: { name: "二室", code: "D2X", parentId: "21", leader },
        })
      ).error,
      /新增人员/
    );
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('7', 'sys:user:create')");
    desk2 = await ctxOf(db, "10");
    assert.match(
      (
        await call(org.createDept, {
          ...desk2,
          body: { name: "二室", code: "D2X", parentId: "21", leader },
        })
      ).error,
      /给人员分配角色/
    );
  } finally {
    await env.close();
  }
});

test("迁移 045：每个角色拆开后的权限正好等于老码换算的结果，工作台卡片按原来能看的补上，可转授跟着老码", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const old = [
      "device:box:list",
      "device:box:detail",
      "device:box:status",
      "device:box:identity",
      "device:box:event",
      "device:box:log",
      "device:box:task",
      "device:box:assign",
      "device:box:policyTask",
      "task:sign",
      "task:video",
      "monitor:view:duty",
      "sys:settings:integration",
      "sys:user:role",
    ];
    await db.run(
      "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES ('60', 'OLD', 'OLD', 3, 1, 1, ?, ?)",
      [NOW, NOW]
    );
    for (const perm of old)
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('60', ?, 1)", [
        perm,
      ]);
    await detailMigration(db);
    const rows = await db.all(
      "SELECT perm, grantable FROM sys_role_perm WHERE role_id = '60' ORDER BY perm"
    );
    assert.deepEqual(
      rows.map((r) => r.perm),
      upgradeCodes(old).sort()
    );
    assert.ok(
      rows.every((r) => Number(r.grantable) === 1),
      "能授权的角色：新码继承可转授"
    );
    for (const gone of [
      "device:box:status",
      "device:box:identity",
      "device:box:event",
      "device:box:assign",
      "device:box:policyTask",
      "monitor:view:duty",
      "sys:settings:integration",
    ]) {
      assert.ok(!rows.some((r) => r.perm === gone), gone);
    }
    for (const card of cardsFor(upgradeCodes(old).filter((c) => !c.startsWith("monitor:card:"))))
      assert.ok(
        rows.some((r) => r.perm === card),
        card
      );
    // 再跑一次不变
    await detailMigration(db);
    assert.equal(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = '60'")).length,
      rows.length
    );
  } finally {
    await env.close();
  }
});

test("字段级遮挡：签收核验、轨迹事件按看的人的权限给；工况各项分开", async () => {
  // 轨迹事件按类别过滤
  const events = [{ kind: "pad" }, { kind: "boot" }, { kind: "chg" }, { kind: "gap" }];
  assert.deepEqual(
    filterEvents(events, new Set([BOX.eventLid])).map((e) => e.kind),
    ["pad", "gap"]
  );
  assert.deepEqual(
    filterEvents(events, new Set([BOX.task])).map((e) => e.kind),
    []
  );
  // 签收核验：没有箱盖、开箱次数权限时只说异常，不给数值
  const boxes = {
    findById: async () => ({
      toJSON: () => ({ lid: 1, alert: "", battery: "3.9V", batteryUsable: 50, charge: 0 }),
    }),
  };
  const db = {
    all: async (sql) =>
      sql.includes("sample_task_box")
        ? [{ box_id: "A", opens_start: 0, opens_end: null, opens: 3 }]
        : [
            {
              id: "A",
              name: "A",
              org: "",
              life: "在途",
              last_report_at: "",
              gps_lng: null,
              gps_lat: null,
              lbs_lng: null,
              lbs_lat: null,
              gps_info: null,
              lbs_at: null,
            },
          ],
  };
  const task = { kind: "调拨", boxIds: ["A"], maxOpens: 1 };
  const blind = await receiveCheck(db, boxes, task, "T", "待签收", { perms: new Set([BOX.task]) });
  assert.deepEqual(
    blind.problems.map((p) => p.text),
    ["开箱次数超过上限", "箱盖状态异常"]
  );
  assert.deepEqual(
    [blind.boxes[0].lid, blind.boxes[0].opensDuring, blind.boxes[0].battery],
    [null, null, ""]
  );
  const full = await receiveCheck(db, boxes, task, "T", "待签收", {
    perms: new Set([BOX.task, BOX.lid, BOX.opens, BOX.power]),
  });
  assert.deepEqual(
    full.problems.map((p) => p.text),
    ["开箱 3 次，超过上限 1 次", "箱盖开着"]
  );
  assert.deepEqual(
    [full.boxes[0].lid, full.boxes[0].opensDuring, full.boxes[0].battery],
    [1, 3, "3.9V"]
  );
  // 工况分开：只有信号强度
  const masked = maskBox(
    { id: "A", battery: "3.9V", csq: 20, lid: 0, firmware: "1.0.16" },
    new Set([BOX.list, BOX.signal])
  );
  assert.deepEqual(
    [masked.csq, masked.battery, masked.lid, masked.firmware],
    [20, undefined, undefined, undefined]
  );
  assert.equal(masked.remote, true);
});

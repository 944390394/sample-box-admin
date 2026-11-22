/**
 * 任务 #87（安全相邻小批）：建单「采样单位」下拉不得显示其他公司信息。
 *
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口、不重启任何服务。守住：
 * 1. taskOptions orgs：分公司管理员（BRANCH_ADMIN scope2）只回本单位子树（无华东/西南/总公司，
 *    不再全量＋inScope=false 灰显泄露名称层级）；ADMIN 与 scope.all 非 ADMIN 读可见全量保持；
 *    scope4（仅本人）orgIds 空→orgs 空；检测站固定接收方字段（station/stationDeptId/myOrgId）不变。
 * 2. taskOptions users：越权 orgId（总公司/检测站/兄弟分公司）回空数组，不给他单位人员名单；
 *    范围内 orgId 只回子树人员；ADMIN 全量保持。
 * 3. taskOptions 权限门口径不变：event-only/无建单码 403 A0301；inspect-only/transfer-only 可达（R21/062）。
 * 4. createTask 合并种：采样单位（客户端 orgId/fromOrgId）越权→403 A0301 且不落库、箱仍可绑
 *    （原 OR 口径「采样单位或寄出方任一在范围」让分公司拿自己的箱把采样单位写成兄弟公司）；
 *    范围内建单 200 不回归；双向不回归（ADMIN 任意采样单位；站侧角色采样单位＝总公司根＝inScope 祖先）。
 * 5. createTask localOnly/送检：箱归属越权（保管人 ownerIds 逃逸可见）既有 inScope(from) 400 口径保持。
 * 6. 065（上行日志补码）与本批无关：migrate 全量跑过、uplink-log-grant.test.js 在全量套件另行守住。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";

const NOW = "2026-11-22 10:00:00";
const FULL_ORG_IDS = ["1", "11", "12", "13", "14", "2", "21", "22", "3", "31", "4", "41"].sort();
const HQ_NAMES = ["系统管理员", "周宁", "吴迪", "监测值班员"];

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "13" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "create-options-scope-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  await seedOrg(db);
  // 夹具同形：分公司现场组 22（acceptance-setup FIELD_DEPT）；华东补一个在职人员（越权 users 探针才有料）
  await db.run(
    "INSERT INTO sys_dept (id, parent_id, name, code, type, sort, status) VALUES ('22', '2', '现场一组', 'SOUTH_FIELD1', '公司', 2, 1)"
  );
  await seedRolePerms(db);
  const user = async (id, username, deptId, roles, status = 1) => {
    await db.run(
      "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, create_time, update_time) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
      [id, username, username, deptId, status, NOW, NOW]
    );
    for (const r of roles)
      await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, r]);
  };
  const role = async (id, code, scope, perms) => {
    await db.run(
      "INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
      [id, `角色${code}`, code, scope, NOW, NOW]
    );
    for (const perm of perms)
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, 0)", [
        id,
        perm,
      ]);
  };
  // 种子角色：12 BRANCH_ADMIN(scope2)、13 DISPATCH(scope2)、2 ADMIN(scope1)；自定义角色从 90 起
  await user("9103", "accept.branch", "2", ["12"]);
  await user("9102", "accept.agency", "22", ["12"]);
  await user("9403", "east.sender", "3", []);
  await role("90", "EVENT_ONLY", 2, ["device:box:event"]);
  await user("9400", "event.only", "2", ["90"]);
  await role("91", "NO_CREATE", 2, ["device:box:task", "device:box:list"]);
  await user("9404", "no.create", "2", ["91"]);
  await role("92", "INSPECT_ONLY", 2, [
    "device:box:task",
    "device:box:list",
    "task:create:inspect",
  ]);
  await user("9405", "inspect.only", "2", ["92"]);
  await role("93", "TRANSFER_ONLY", 2, ["task:create:transfer"]);
  await user("9406", "transfer.only", "2", ["93"]);
  await role("94", "ALL_CREATE", 1, ["device:box:task", "device:box:list", "task:create:sample"]);
  await user("9407", "all.create", "2", ["94"]);
  await role("95", "SCOPE4_CREATE", 4, [
    "device:box:task",
    "device:box:list",
    "task:create:sample",
    "task:create:inspect",
  ]);
  await user("9401", "scope4.create", "2", ["95"]);
  await role("96", "STATION_CREATE", 2, [
    "device:box:task",
    "device:box:list",
    "task:create:sample",
  ]);
  await user("9402", "station.create", "13", ["96"]);
  const ctxOf = async (id) => {
    const row = await db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
    return { db, user: row, access: await resolveAccess(db, row), query: {}, ip: "127.0.0.1" };
  };
  const box = async (id, orgId, extra = {}) => {
    await db.run(
      "INSERT INTO sample_box (id, imei, name, life, org, org_id, owner_id, activate_step, firmware) VALUES (?, ?, ?, ?, ?, ?, ?, '已确认', '1.0.17')",
      [id, id, extra.name ?? "", extra.life || "未使用", `单位${orgId}`, orgId, extra.ownerId ?? ""]
    );
  };
  const controller = new ReportPolicyController(new SqlBoxStore(db), new ReportPolicy(db));
  const call = async (fn, ctx, extra = {}) => {
    let out;
    try {
      await fn({
        query: {},
        params: {},
        body: {},
        ...ctx,
        ...extra,
        ok: (data, message) => (out = { ok: true, data, message }),
        fail: (message, code, status) => (out = { ok: false, error: message, code, status }),
      });
    } catch (e) {
      out = { ok: false, error: e.message, code: e.publicCode, status: e.httpStatus };
    }
    return out;
  };
  const options = (ctx, orgId) =>
    call(controller.taskOptions.bind(controller), ctx, orgId ? { query: { orgId } } : {});
  const teardown = async () => {
    applyBoxSettings({});
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, controller, call, options, ctxOf, box, teardown };
}

test("taskOptions orgs：分公司 scope2 仅本单位子树（无华东/西南/总公司），ADMIN/scope.all 全量，scope4 空", async () => {
  const s = await setup();
  try {
    const branch = await s.ctxOf("9103");
    const res = await s.options(branch);
    assert.ok(res.ok, res.error);
    const orgs = res.data.orgs;
    assert.deepEqual(orgs.map((o) => o.id).sort(), ["2", "21", "22"], "仅华南分公司子树");
    assert.ok(
      orgs.every((o) => o.inScope === true),
      "保留行全部 inScope，无灰显行"
    );
    const text = orgs.map((o) => `${o.name} ${o.path}`).join("|");
    for (const word of ["华东", "西南", "总公司"])
      assert.ok(!text.includes(word), `不得出现他公司 ${word}：${text}`);
    assert.deepEqual(
      orgs.map((o) => o.path),
      ["华南分公司", "华南分公司 / 调度室", "华南分公司 / 现场一组"]
    );
    // 检测站固定接收方字段不回归：station 仍回唯一检测站（全建单方可见属既有口径）
    assert.equal(res.data.station?.id, "13");
    assert.equal(res.data.station?.name, "总部检测站");
    assert.equal(res.data.stationDeptId, "13");
    assert.equal(res.data.myOrgId, "2");
    // 现场一组管理员（dept22）：祖先 2＋本部门 22
    const agency = await s.options(await s.ctxOf("9102"));
    assert.deepEqual(agency.data.orgs.map((o) => o.id).sort(), ["2", "22"]);
    // 调度员（DISPATCH scope2 dept21）：祖先 2＋本部门 21
    const dispatch = await s.options(await s.ctxOf("6"));
    assert.deepEqual(dispatch.data.orgs.map((o) => o.id).sort(), ["2", "21"]);
    // ADMIN 全量
    const admin = await s.options(await s.ctxOf("2"));
    assert.deepEqual(admin.data.orgs.map((o) => o.id).sort(), FULL_ORG_IDS);
    // scope.all 非 ADMIN（全部数据范围＋建单码）：读可见全量保持（inScope 对 scope.all 恒真）
    const allCreate = await s.options(await s.ctxOf("9407"));
    assert.deepEqual(allCreate.data.orgs.map((o) => o.id).sort(), FULL_ORG_IDS);
    // scope4 仅本人：orgIds 空 → orgs 空（修前是全量灰显，修后不泄露）
    const scope4 = await s.options(await s.ctxOf("9401"));
    assert.deepEqual(scope4.data.orgs, []);
  } finally {
    await s.teardown();
  }
});

test("taskOptions users：越权 orgId 空数组，范围内仅子树人员，ADMIN 全量保持", async () => {
  const s = await setup();
  try {
    const branch = await s.ctxOf("9103");
    // 越权：总公司（1）/检测站（13）/华东（3）都有在职人员，修前会取回，修后一律空
    for (const orgId of ["1", "13", "3"]) {
      const res = await s.options(branch, orgId);
      assert.ok(res.ok, res.error);
      assert.deepEqual(res.data.users, [], `orgId=${orgId} 越权应空数组`);
    }
    // 范围内 orgId=2：仅华南子树人员（含种子林夏/陈可＋本测试账号），无总部/华东人员
    const own = await s.options(branch, "2");
    const names = own.data.users.map((u) => u.name);
    for (const n of ["林夏", "陈可", "accept.branch", "accept.agency"])
      assert.ok(names.includes(n), `子树人员 ${n} 应在候选：${names}`);
    assert.ok(
      !names.some((n) => [...HQ_NAMES, "east.sender"].includes(n)),
      `不得含他单位人员：${names}`
    );
    assert.ok(
      own.data.users.every((u) => u.dept.startsWith("华南分公司")),
      "人员部门路径均在华南子树"
    );
    // 范围内 orgId=21：仅调度室人员
    const desk = await s.options(branch, "21");
    assert.deepEqual(
      desk.data.users.map((u) => u.name),
      ["陈可"]
    );
    // ADMIN 全量保持：华东/总公司人员照取
    const admin = await s.ctxOf("2");
    const east = await s.options(admin, "3");
    assert.deepEqual(
      east.data.users.map((u) => u.name),
      ["east.sender"]
    );
    const hq = await s.options(admin, "1");
    assert.ok(hq.data.users.some((u) => u.name === "系统管理员"));
    // scope4：orgIds 空 → 任何 orgId 都空
    const scope4 = await s.options(await s.ctxOf("9401"), "2");
    assert.deepEqual(scope4.data.users, []);
  } finally {
    await s.teardown();
  }
});

test("taskOptions 权限门口径不变：event-only/无建单码 403，inspect-only/transfer-only 可达且 orgs 随范围", async () => {
  const s = await setup();
  try {
    for (const id of ["9400", "9404"]) {
      const res = await s.options(await s.ctxOf(id));
      assert.equal(res.ok, false);
      assert.equal(res.code, "A0301");
      assert.equal(res.status, 403);
    }
    const inspect = await s.options(await s.ctxOf("9405"));
    assert.ok(inspect.ok, inspect.error);
    assert.deepEqual(
      inspect.data.orgs.map((o) => o.id).sort(),
      ["2", "21", "22"],
      "inspect-only 可达且 orgs 仍按范围收敛"
    );
    const transfer = await s.options(await s.ctxOf("9406"));
    assert.ok(transfer.ok, transfer.error);
    assert.deepEqual(transfer.data.orgs.map((o) => o.id).sort(), ["2", "21", "22"]);
  } finally {
    await s.teardown();
  }
});

test("createTask 合并种：越权采样单位 403 不落库；范围内 200 不回归；双向 ADMIN/站侧总公司根不回归", async () => {
  const s = await setup();
  try {
    const branch = await s.ctxOf("9103");
    await s.box("864317080990001", "21");
    await s.box("864317080990002", "21");
    await s.box("864317080990003", "21");
    await s.box("864317080990004", "13");
    const base = {
      boxIds: ["864317080990001"],
      senderId: "6",
      signerId: "5",
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    };
    // 越权：自己的箱（org21）＋采样单位＝华东（3）→ 403 A0301（原 OR 口径会放行）
    const neg = await s.call(s.controller.createTask.bind(s.controller), branch, {
      body: { ...base, name: "越权采样单位", kind: "采样后送检", fromOrgId: "3", orgId: "3" },
    });
    assert.equal(neg.ok, false);
    assert.equal(neg.code, "A0301");
    assert.equal(neg.status, 403);
    assert.match(neg.error, /采样单位不在你的管理范围内/);
    // 旧合并别名 kind=采样（不带 localOnly）同口径
    const alias = await s.call(s.controller.createTask.bind(s.controller), branch, {
      body: { ...base, name: "越权别名", kind: "采样", fromOrgId: "3", orgId: "3" },
    });
    assert.equal(alias.code, "A0301");
    // 不落库：无任务行、箱仍可绑
    assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM sample_task")).n, 0);
    assert.equal(
      (await s.db.get("SELECT life FROM sample_box WHERE id='864317080990001'")).life,
      "未使用"
    );
    // 范围内：采样单位＝华南（2）200，寄出方＝箱归属 21（只读派生），单向
    const pos = await s.call(s.controller.createTask.bind(s.controller), branch, {
      body: { ...base, name: "范围内建单", kind: "采样后送检", fromOrgId: "2", orgId: "2" },
    });
    assert.ok(pos.ok, pos.error);
    assert.match(pos.data.id, /^TK-/);
    const body = JSON.parse(
      (await s.db.get("SELECT body FROM sample_task WHERE id=?", [pos.data.id])).body
    );
    assert.equal(body.orgId, "2");
    assert.equal(body.fromOrgId, "21", "寄出方＝箱当前归属（不被客户端 fromOrgId 改写）");
    assert.equal(body.trip, "单向");
    // 采样单位＝本部门（21，公司类型）也在范围内
    const desk = await s.call(s.controller.createTask.bind(s.controller), branch, {
      body: {
        ...base,
        boxIds: ["864317080990002"],
        name: "部门建单",
        kind: "采样后送检",
        fromOrgId: "21",
        orgId: "21",
      },
    });
    assert.ok(desk.ok, desk.error);
    // 双向不回归①：ADMIN 箱在检测站＋采样单位＝华南 → 双向 200
    const admin = await s.ctxOf("2");
    const round = await s.call(s.controller.createTask.bind(s.controller), admin, {
      body: {
        ...base,
        boxIds: ["864317080990004"],
        name: "管理员双向",
        kind: "采样后送检",
        fromOrgId: "2",
        orgId: "2",
        senderId: "5",
      },
    });
    assert.ok(round.ok, round.error);
    const roundBody = JSON.parse(
      (await s.db.get("SELECT body FROM sample_task WHERE id=?", [round.data.id])).body
    );
    assert.equal(roundBody.trip, "双向");
    assert.equal(roundBody.fromOrgId, "13");
    // 双向不回归②：站侧角色（scope2 dept13，orgIds=[1,13]）采样单位＝总公司根（inScope 祖先，UI 修后默认候选）→ 200
    await s.box("864317080990005", "13");
    const stationCtx = await s.ctxOf("9402");
    const stationRound = await s.call(s.controller.createTask.bind(s.controller), stationCtx, {
      body: {
        ...base,
        boxIds: ["864317080990005"],
        name: "站侧双向",
        kind: "采样后送检",
        fromOrgId: "1",
        orgId: "1",
        senderId: "5",
      },
    });
    assert.ok(stationRound.ok, stationRound.error);
    assert.equal(
      JSON.parse(
        (await s.db.get("SELECT body FROM sample_task WHERE id=?", [stationRound.data.id])).body
      ).trip,
      "双向"
    );
    // 站侧角色把采样单位写成范围外分公司（2）→ 403（与 UI 修后候选一致：站侧只见总公司根）
    await s.box("864317080990006", "13");
    const stationNeg = await s.call(s.controller.createTask.bind(s.controller), stationCtx, {
      body: {
        ...base,
        boxIds: ["864317080990006"],
        name: "站侧越权",
        kind: "采样后送检",
        fromOrgId: "2",
        orgId: "2",
        senderId: "5",
      },
    });
    assert.equal(stationNeg.code, "A0301");
  } finally {
    await s.teardown();
  }
});

test("createTask localOnly/送检：箱归属越权（保管人逃逸可见）既有 inScope(from) 400 口径保持", async () => {
  const s = await setup();
  try {
    // scope4 仅本人：orgIds 空、ownerIds=[9401]；箱挂华南（2）但保管人是他 → targets 可见、from 越权
    const scope4 = await s.ctxOf("9401");
    await s.box("864317080990011", "2", { ownerId: "9401" });
    await s.box("864317080990012", "2", { ownerId: "9401" });
    const local = await s.call(s.controller.createTask.bind(s.controller), scope4, {
      body: {
        name: "本地越权",
        kind: "采样",
        localOnly: true,
        boxIds: ["864317080990011"],
        placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
      },
    });
    assert.equal(local.ok, false);
    assert.equal(local.code, "A0400");
    assert.equal(local.status, 400);
    assert.match(local.error, /采样单位不在你的管理范围内/);
    const inspect = await s.call(s.controller.createTask.bind(s.controller), scope4, {
      body: {
        name: "送检越权",
        kind: "送检",
        boxIds: ["864317080990012"],
        senderId: "7",
        signerId: "5",
      },
    });
    assert.equal(inspect.ok, false);
    assert.equal(inspect.code, "A0400");
    assert.match(inspect.error, /寄出方不在你的管理范围内/);
    assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM sample_task")).n, 0);
  } finally {
    await s.teardown();
  }
});

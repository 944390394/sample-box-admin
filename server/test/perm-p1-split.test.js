/**
 * R21 权限颗粒度 P1（任务 #64，用户全选四项）＋迁移 062 的定向测试。
 * 守住：
 * 1. upgradeCodes 三组并集守恒（policyCompany→+judge；policyDefault→+station；create:sample→+inspect），
 *    老码保留、未持有者不补、幂等；默认角色实测码集钉死（DISPATCH/BRANCH_ADMIN 得 judge+inspect，
 *    station 默认角色无人持 policyDefault 故不补——仅 ADMIN 全码）。
 * 2. 062 迁移：双表 expand（sys_role_perm grantable 沿旧码取 max；sys_dept_perm 同拆）、
 *    _bak_062 备份先于改动且重跑不覆盖、ADMIN 短路、未持老码的角色不动、重跑幂等。
 * 3. 建单子类型 strict：送检无 create:inspect 码 403（持 create:sample 也不兜底）、有码 200；
 *    采样/采样后送检仍 create:sample；inspect-only 角色 taskOptions 可达、采样被拒。
 * 4. 公司判定阈值拆码：阈值三列变更无 judge 码 403、有码 200；judge-only 可存阈值、改 idle/task 403；
 *    未变更回显不查码；companyPolicyRead can.judge 按码＋manage 闸门。
 * 5. 唯一检测站拆码：boxSettingsDenied 行为（station 变更查 sys:settings:station，policyDefault 不再放行）
 *    ＋index.js saveBox/路由/systemSettings 接线源码断言（仓库惯例，settings-secret-flags 同款）。
 * 6. 上报记录菜单门 some 口径：持 log 无 list 菜单可见＋reportOptions/logs 200；持 list 无 log/event
 *    菜单不可见；event-only 角色事件种类 200、全量 403（内容鉴权 #logPerm 一律不动）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase } from "../db.js";
import { up as up062 } from "../migrations/062_perm_p1_split.js";
import { menusFor, menuPreviewFor, SETTINGS } from "../menus.js";
import { DEFAULT_ROLE_PERMS, SPLIT_062, upgradeCodes } from "../src/auth/permCatalog.js";
import { resolveAccess } from "../src/auth/boxAccess.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { SampleController } from "../src/http/SampleController.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { applyBoxSettings, boxSettingsDenied, publicBox } from "../src/settings/boxConfig.js";

const NOW = "2026-11-22 10:00:00";
async function fresh(prefix = "perm-p1-split-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
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
/** 控制器抛 AppError（noPermission/badRequest），映射成 {ok,code,status} 供断言。 */
async function call(fn, ctx) {
  let out;
  try {
    await fn({
      query: {},
      params: {},
      body: {},
      ...ctx,
      ok: (data, message) => (out = { ok: true, data, message }),
      fail: (message, code, status) => (out = { ok: false, error: message, code, status }),
    });
  } catch (e) {
    out = { ok: false, error: e.message, code: e.publicCode, status: e.httpStatus };
  }
  return out;
}
async function dept(db, id, parent, name, type = "公司") {
  await db.run(
    "INSERT INTO sys_dept (id, parent_id, name, code, sort, status, type) VALUES (?, ?, ?, ?, 1, 1, ?)",
    [id, parent, name, `D${id}`, type]
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
  return { db, user: row, access: await resolveAccess(db, row), query: {}, ip: "127.0.0.1" };
}
/** 箱子当前行（company-policy.test.js 同款最小列）。 */
async function box(db, id, orgId, extra = {}) {
  await db.run(
    "INSERT INTO sample_box (id,imei,name,life,org,org_id,activate_step,firmware) VALUES (?,?,?,?,?,?,?,?)",
    [
      id,
      id,
      extra.name ?? "",
      extra.life || "未使用",
      `单位${orgId}`,
      orgId || "",
      "已确认",
      "1.0.17",
    ]
  );
}
function controllerOf(db) {
  const policies = new ReportPolicy(db);
  const controller = new ReportPolicyController({ summaryCache: null }, policies);
  for (const key of Object.getOwnPropertyNames(ReportPolicyController.prototype)) {
    if (key !== "constructor" && typeof controller[key] === "function")
      controller[key] = controller[key].bind(controller);
  }
  return { policies, controller };
}
const permsOf = async (db, id) =>
  (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ? ORDER BY perm", [id])).map(
    (r) => r.perm
  );
const p = (n) => ({ reportPeriodSec: n, reportOnlyWhenCharging: false });

test("upgradeCodes 三组并集守恒：老码保留、未持有者不补、幂等；默认角色码集钉死", () => {
  const company = upgradeCodes(["device:box:policyRead", "device:box:policyCompany"]);
  assert.ok(company.includes("device:box:policyCompany"));
  assert.ok(company.includes("device:box:policyCompanyJudge"));
  const defaults = upgradeCodes(["sys:settings:view", "device:box:policyDefault"]);
  assert.ok(defaults.includes("device:box:policyDefault"));
  assert.ok(defaults.includes("sys:settings:station"));
  const sample = upgradeCodes(["device:box:task", "task:create:sample"]);
  assert.ok(sample.includes("task:create:sample"));
  assert.ok(sample.includes("task:create:inspect"));
  // 未持老码不补（不强制补默认，区别于 056/058）
  const plain = upgradeCodes(["device:box:list", "device:box:task", "sys:settings:view"]);
  for (const code of [
    "device:box:policyCompanyJudge",
    "sys:settings:station",
    "task:create:inspect",
  ])
    assert.ok(!plain.includes(code), code);
  // 幂等：升级两次结果一致；SPLIT_062 老码都在 parts 里（只补不删）
  for (const set of [company, defaults, sample])
    assert.deepEqual(upgradeCodes(set).sort(), [...set].sort());
  for (const [old, parts] of Object.entries(SPLIT_062)) assert.ok(parts.includes(old), old);
  // 默认角色实测（node 核对写进报告）：持 policyCompany/create:sample 的 DISPATCH/BRANCH_ADMIN
  // 经 upgradeCodes 自动得 judge+inspect；无默认角色持 policyDefault → station 不补（仅 ADMIN 全码）
  for (const key of ["DISPATCH", "BRANCH_ADMIN"]) {
    assert.ok(DEFAULT_ROLE_PERMS[key].includes("device:box:policyCompanyJudge"), key);
    assert.ok(DEFAULT_ROLE_PERMS[key].includes("task:create:inspect"), key);
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes("sys:settings:station"), key);
  }
  assert.ok(DEFAULT_ROLE_PERMS.ADMIN.includes("sys:settings:station"));
  assert.ok(DEFAULT_ROLE_PERMS.ADMIN.includes("device:box:policyCompanyJudge"));
  for (const key of ["SAMPLER", "DUTY", "VERIFY", "ASSET", "LEADER"]) {
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes("device:box:policyCompanyJudge"), key);
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes("sys:settings:station"), key);
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes("task:create:inspect"), key);
  }
});

test("062 迁移：双表 expand＋grantable 沿旧码取 max＋_bak 留底；重跑幂等、备份不覆盖", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    await role(db, "1", "ADMIN", 1, []);
    // 角色 70：持三组旧码（grantable 各不同）；角色 71：无旧码；角色 72：已持 inspect=0，sample=1 → 取 max
    await role(db, "70", "OLD", 3, []);
    for (const [perm, flag] of [
      ["device:box:policyRead", 0],
      ["device:box:policyCompany", 1],
      ["sys:settings:view", 0],
      ["device:box:policyDefault", 0],
      ["device:box:task", 0],
      ["task:create:sample", 1],
    ])
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('70', ?, ?)", [
        perm,
        flag,
      ]);
    await role(db, "71", "PLAIN", 3, ["device:box:list"]);
    await role(db, "72", "HALF", 3, []);
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('72', 'task:create:sample', 1)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('72', 'task:create:inspect', 0)"
    );
    // 部门上限：dept 2 持三组旧码；dept 3 无
    for (const perm of [
      "device:box:policyCompany",
      "device:box:policyDefault",
      "task:create:sample",
    ])
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2', ?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('3', 'device:box:list')");
    const before70 = await permsOf(db, "70");
    const before71 = await permsOf(db, "71");

    // migrate 已在空表上建过 _bak_062（空壳）；删掉再跑，验证「改动前备份」语义（沿 061 先例）
    await db.run("DROP TABLE IF EXISTS _bak_062_perm_granularity_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_062_perm_granularity_sys_dept_perm");
    await up062(db);

    const after70 = await permsOf(db, "70");
    assert.deepEqual(
      after70,
      [
        ...new Set([
          ...before70,
          "device:box:policyCompanyJudge",
          "sys:settings:station",
          "task:create:inspect",
        ]),
      ].sort()
    );
    // grantable 继承：policyCompany=1 → judge=1；policyDefault=0 → station=0；create:sample=1 → inspect=1
    const flags = Object.fromEntries(
      (await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = '70'")).map((r) => [
        r.perm,
        Number(r.grantable),
      ])
    );
    assert.equal(flags["device:box:policyCompanyJudge"], 1);
    assert.equal(flags["sys:settings:station"], 0);
    assert.equal(flags["task:create:inspect"], 1);
    // 已持 inspect=0 的角色：sample=1 取 max → inspect 升 1（只升不降）
    const half = Object.fromEntries(
      (await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = '72'")).map((r) => [
        r.perm,
        Number(r.grantable),
      ])
    );
    assert.equal(half["task:create:inspect"], 1);
    assert.deepEqual(await permsOf(db, "71"), before71, "未持旧码的角色不动");
    assert.deepEqual(await permsOf(db, "1"), [], "ADMIN 短路不落行");
    // 部门上限同拆
    const dept2 = (
      await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = '2' ORDER BY perm")
    ).map((r) => r.perm);
    assert.deepEqual(dept2, [
      "device:box:policyCompany",
      "device:box:policyCompanyJudge",
      "device:box:policyDefault",
      "sys:settings:station",
      "task:create:inspect",
      "task:create:sample",
    ]);
    const dept3 = (await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = '3'")).map(
      (r) => r.perm
    );
    assert.deepEqual(dept3, ["device:box:list"]);
    // 备份留底＝改动前
    const bak = await db.all(
      "SELECT perm FROM _bak_062_perm_granularity_sys_role_perm WHERE role_id = '70' ORDER BY perm"
    );
    assert.deepEqual(
      bak.map((r) => r.perm),
      before70
    );
    const bakDept = await db.all(
      "SELECT perm FROM _bak_062_perm_granularity_sys_dept_perm WHERE dept_id = '2' ORDER BY perm"
    );
    assert.deepEqual(
      bakDept.map((r) => r.perm),
      ["device:box:policyCompany", "device:box:policyDefault", "task:create:sample"]
    );

    // 重跑：行数/flag 不变，备份不覆盖（先改一行再重跑，_bak 仍是首次备份）
    const countBefore = (await db.get("SELECT COUNT(*) AS n FROM sys_role_perm")).n;
    await db.run(
      "INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('71', 'device:box:detail', 0)"
    );
    await up062(db);
    assert.equal(
      (await db.get("SELECT COUNT(*) AS n FROM sys_role_perm")).n,
      Number(countBefore) + 1
    );
    assert.deepEqual(await permsOf(db, "70"), after70);
    const flagsAgain = Object.fromEntries(
      (await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = '70'")).map((r) => [
        r.perm,
        Number(r.grantable),
      ])
    );
    assert.deepEqual(flagsAgain, flags, "重跑 grantable 同值");
    const bakAfter = await db.all(
      "SELECT perm FROM _bak_062_perm_granularity_sys_role_perm WHERE role_id = '70' ORDER BY perm"
    );
    assert.deepEqual(
      bakAfter.map((r) => r.perm),
      before70,
      "_bak 不被重跑覆盖"
    );
    assert.ok(
      !(
        await db.all(
          "SELECT perm FROM _bak_062_perm_granularity_sys_role_perm WHERE role_id = '71'"
        )
      ).some((r) => r.perm === "device:box:detail"),
      "备份仍是首次留底"
    );
  } finally {
    await env.close();
  }
});

test("建单子类型 strict：送检无 inspect 码 403（sample 不兜底）、有码 200；采样仍 sample 码；taskOptions 随码", async () => {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const env = await fresh("perm-p1-kinds-");
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await dept(db, "6", "1", "总部检测站", "检测站");
    await dept(db, "2", "1", "华南分公司");
    await user(db, "20", "sender", "2", []);
    await user(db, "60", "signer", "6", []);
    await box(db, "864317080992517", "2");
    await box(db, "864317080992518", "2");
    await box(db, "864317080992519", "2");
    await box(db, "864317080992520", "2");
    await box(db, "864317080992521", "2");
    // 062 后管理员显式收回的形态：sample-only / inspect-only / 双码
    await role(db, "10", "SAMPLE_ONLY", 1, [
      "device:box:task",
      "device:box:list",
      "task:create:sample",
    ]);
    await role(db, "11", "INSPECT_ONLY", 1, [
      "device:box:task",
      "device:box:list",
      "task:create:inspect",
    ]);
    await role(db, "12", "BOTH", 1, [
      "device:box:task",
      "device:box:list",
      "task:create:sample",
      "task:create:inspect",
    ]);
    await user(db, "10", "sample.only", "2", ["10"]);
    await user(db, "11", "inspect.only", "2", ["11"]);
    await user(db, "12", "both.codes", "2", ["12"]);
    const sampleOnly = await ctxOf(db, "10");
    const inspectOnly = await ctxOf(db, "11");
    const both = await ctxOf(db, "12");
    const { controller } = controllerOf(db);
    const create = (ctx, body) => call(controller.createTask, { ...ctx, body });
    const inspectBody = (id) => ({
      name: "送检单",
      kind: "送检",
      boxIds: [id],
      senderId: "20",
      signerId: "60",
    });

    // 送检：sample-only 403（去兜底）；inspect-only / 双码 200
    const denied = await create(sampleOnly, inspectBody("864317080992517"));
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    assert.equal(denied.status, 403);
    const okInspect = await create(inspectOnly, inspectBody("864317080992517"));
    assert.equal(okInspect.ok, true, okInspect.error);
    assert.match(okInspect.data.id, /^IN-/);
    const okBoth = await create(both, inspectBody("864317080992518"));
    assert.equal(okBoth.ok, true, okBoth.error);
    // 采样（仅本地）/采样后送检：仍 sample 码；inspect-only 被拒
    const local = await create(sampleOnly, {
      name: "本地采样",
      kind: "采样",
      localOnly: true,
      boxIds: ["864317080992519"],
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    assert.equal(local.ok, true, local.error);
    const merged = await create(sampleOnly, {
      name: "采样后送检",
      kind: "采样后送检",
      boxIds: ["864317080992520"],
      fromOrgId: "2",
      senderId: "20",
      signerId: "60",
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    assert.equal(merged.ok, true, merged.error);
    const mergedDenied = await create(inspectOnly, {
      name: "采样后送检",
      kind: "采样后送检",
      boxIds: ["864317080992521"],
      fromOrgId: "2",
      senderId: "20",
      signerId: "60",
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    assert.equal(mergedDenied.ok, false);
    assert.equal(mergedDenied.code, "A0301");
    // taskOptions：inspect-only 可达（R21 接线）；sample-only 照旧；无建单码 403
    const optsInspect = await call(controller.taskOptions, { ...inspectOnly, query: {} });
    assert.equal(optsInspect.ok, true, optsInspect.error);
    assert.equal(optsInspect.data.stationDeptId, "6");
    const optsSample = await call(controller.taskOptions, { ...sampleOnly, query: {} });
    assert.equal(optsSample.ok, true, optsSample.error);
    await role(db, "13", "NO_CREATE", 1, ["device:box:task", "device:box:list"]);
    await user(db, "13", "no.create", "2", ["13"]);
    const noCreate = await ctxOf(db, "13");
    const optsDenied = await call(controller.taskOptions, { ...noCreate, query: {} });
    assert.equal(optsDenied.ok, false);
    assert.equal(optsDenied.code, "A0301");
  } finally {
    applyBoxSettings({});
    await env.close();
  }
});

test("公司阈值拆码：阈值变更无 judge 码 403、有码 200；judge-only 存阈值 200 改策略 403；回显未变更不查", async () => {
  const env = await fresh("perm-p1-judge-");
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    // 公司策略按顶级公司设置（companyOf）：华南必须是根（parent 0），与 seedOrg/three-kinds 同形
    await dept(db, "2", "0", "华南分公司");
    // 062 后显式收回的形态：company-only（无 judge）/ judge-only（无 company）/ 双码
    await role(db, "10", "COMPANY_ONLY", 3, ["device:box:policyRead", "device:box:policyCompany"]);
    await role(db, "11", "JUDGE_ONLY", 3, [
      "device:box:policyRead",
      "device:box:policyCompanyJudge",
    ]);
    await role(db, "12", "BOTH", 3, [
      "device:box:policyRead",
      "device:box:policyCompany",
      "device:box:policyCompanyJudge",
    ]);
    await user(db, "10", "company.only", "2", ["10"]);
    await user(db, "11", "judge.only", "2", ["11"]);
    await user(db, "12", "both.codes", "2", ["12"]);
    const companyOnly = await ctxOf(db, "10");
    const judgeOnly = await ctxOf(db, "11");
    const both = await ctxOf(db, "12");
    const { controller } = controllerOf(db);
    const save = (ctx, body) =>
      call(controller.companyPolicySave, { ...ctx, params: { id: "2" }, body });
    const read = (ctx) => call(controller.companyPolicyRead, { ...ctx, params: { id: "2" } });

    // can.judge 按码＋manage 闸门（scope3 本单位 manage=[2]）
    const readCompany = await read(companyOnly);
    assert.equal(readCompany.ok, true, readCompany.error);
    assert.deepEqual(readCompany.data.can, { write: true, judge: false });
    const readJudge = await read(judgeOnly);
    assert.deepEqual(readJudge.data.can, { write: false, judge: true });

    // company-only：改 idle 可以（阈值 null→null 未变更不查 judge）
    const idleOk = await save(companyOnly, {
      idle: p(120),
      task: null,
      batteryReserve: null,
      arriveRadiusM: null,
      taskOfflineGraceSec: null,
    });
    assert.equal(idleOk.ok, true, idleOk.error);
    assert.deepEqual(idleOk.data.can, { write: true, judge: false });
    // company-only：改阈值 → 403「修改公司判定阈值」
    const judgeDenied = await save(companyOnly, {
      idle: p(120),
      task: null,
      batteryReserve: 50,
      arriveRadiusM: null,
      taskOfflineGraceSec: null,
    });
    assert.equal(judgeDenied.ok, false);
    assert.equal(judgeDenied.code, "A0301");
    assert.equal(judgeDenied.status, 403);
    assert.match(judgeDenied.error, /修改公司判定阈值/);
    // company-only：原样回显（idle/阈值都没变）→ 200，不误判变更
    const echoOk = await save(companyOnly, {
      idle: p(120),
      task: null,
      batteryReserve: null,
      arriveRadiusM: null,
      taskOfflineGraceSec: null,
    });
    assert.equal(echoOk.ok, true, echoOk.error);
    // judge-only：改阈值 → 200；改 idle → 403（策略仍 company 码）
    const judgeOk = await save(judgeOnly, {
      idle: p(120),
      task: null,
      batteryReserve: 50,
      arriveRadiusM: 500,
      taskOfflineGraceSec: 600,
    });
    assert.equal(judgeOk.ok, true, judgeOk.error);
    assert.equal(judgeOk.data.batteryReserve, 50);
    assert.deepEqual(judgeOk.data.can, { write: false, judge: true });
    const idleDenied = await save(judgeOnly, {
      idle: p(300),
      task: null,
      batteryReserve: 50,
      arriveRadiusM: 500,
      taskOfflineGraceSec: 600,
    });
    assert.equal(idleDenied.ok, false);
    assert.equal(idleDenied.code, "A0301");
    // 双码：策略＋阈值一起改 → 200
    const bothOk = await save(both, {
      idle: p(90),
      task: p(30),
      batteryReserve: 30,
      arriveRadiusM: null,
      taskOfflineGraceSec: null,
    });
    assert.equal(bothOk.ok, true, bothOk.error);
    assert.deepEqual(bothOk.data.can, { write: true, judge: true });
    // 阈值范围校验不变（400 友好报错）
    const badReserve = await save(both, { idle: null, batteryReserve: 81 });
    assert.equal(badReserve.status, 400);
    // 无任何写码（只读 policyRead）→ 403（#companyTarget write 门 some(company,judge)）
    await role(db, "13", "READ_ONLY", 3, ["device:box:policyRead"]);
    await user(db, "13", "read.only", "2", ["13"]);
    const readOnly = await ctxOf(db, "13");
    const readDenied = await save(readOnly, { idle: p(60) });
    assert.equal(readDenied.ok, false);
    assert.equal(readDenied.code, "A0301");
  } finally {
    await env.close();
  }
});

test("唯一检测站拆码：boxSettingsDenied 行为（station 查新码）＋saveBox/路由/settings 接线源码断言", async () => {
  const before = publicBox({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "" },
  });
  const stationChanged = { ...before, stationDeptId: "6" };
  // station 变更：policyDefault 不再放行；station 码放行；双码放行
  assert.match(
    boxSettingsDenied(before, stationChanged, new Set(["device:box:policyDefault"])),
    /唯一检测站/
  );
  assert.equal(boxSettingsDenied(before, stationChanged, new Set(["sys:settings:station"])), null);
  assert.equal(
    boxSettingsDenied(
      before,
      stationChanged,
      new Set(["device:box:policyDefault", "sys:settings:station"])
    ),
    null
  );
  // 清空配置同样查新码；未变更不查
  assert.match(
    boxSettingsDenied(stationChanged, before, new Set(["device:box:policyDefault"])),
    /唯一检测站/
  );
  assert.equal(boxSettingsDenied(before, { ...before }, new Set()), null);
  // 其余三段口径不回归：周期/预留/半径各查各码
  assert.match(
    boxSettingsDenied(
      before,
      { ...before, reportPeriodSec: 120 },
      new Set(["sys:settings:station"])
    ),
    /修改默认上报策略/
  );
  assert.equal(
    boxSettingsDenied(
      before,
      { ...before, reportPeriodSec: 120 },
      new Set(["device:box:policyDefault"])
    ),
    null
  );
  assert.match(
    boxSettingsDenied(
      before,
      { ...before, batteryReserve: 30 },
      new Set(["device:box:policyDefault"])
    ),
    /修改电量预留比例/
  );
  assert.match(
    boxSettingsDenied(
      before,
      { ...before, arriveRadiusM: 500 },
      new Set(["device:box:policyDefault"])
    ),
    /修改到达判定半径/
  );
  // perms 缺失（无 access）按无权限拒，与原 saveBox 内联口径一致
  assert.match(boxSettingsDenied(before, stationChanged, undefined), /唯一检测站/);

  // 接线源码断言（settings-secret-flags/operation-log-export 同款惯例）
  const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const saveBoxBlock = routes.match(/async function saveBox\(ctx\) \{[\s\S]*?\n\}/);
  assert.ok(saveBoxBlock, "saveBox 处理函数要在");
  assert.match(saveBoxBlock[0], /boxSettingsDenied\(before, after, ctx\.access\?\.perms\)/);
  assert.ok(!/没有修改唯一检测站配置的权限/.test(saveBoxBlock[0]), "station gate 已抽到 helper");
  const boxRoute = routes.match(
    /path: "\/api\/v1\/system\/settings\/box",[\s\S]*?handler: saveBox,/
  );
  assert.ok(boxRoute, "settings/box 路由要注册");
  assert.match(boxRoute[0], /"sys:settings:station"/);
  const settingsBlock = routes.match(/async function systemSettings\(ctx\) \{[\s\S]*?\n\}/);
  assert.match(settingsBlock[0], /station: has\("sys:settings:station"\)/);
  // SETTINGS 菜单数组含新码（系统设置页入口随码）
  assert.ok(SETTINGS.includes("sys:settings:station"));
});

test("上报记录菜单门 some 口径：持 log 无 list 可见且内容 200；持 list 无 log/event 不可见；内容鉴权不动", async () => {
  const logOnly = new Set(["device:box:task", "device:box:log"]);
  const listOnly = new Set(["device:box:list", "device:box:detail"]);
  const eventOnly = new Set(["device:box:task", "device:box:event-lid"]);
  const names = (perms) => menusFor(perms).flatMap((g) => g.children.map((c) => c.name));
  assert.ok(names(logOnly).includes("SampleReports"), "持 log 无 list 菜单可见");
  assert.ok(!names(logOnly).includes("SampleBoxes"), "无 list 采样箱清单不可见");
  assert.ok(
    !names(listOnly).includes("SampleReports"),
    "持 list 无 log/event 菜单不可见（修毛刺）"
  );
  assert.ok(names(eventOnly).includes("SampleReports"), "持事件码菜单可见");
  // 预览＝真实侧栏（单源）
  assert.equal(menuPreviewFor(logOnly).find((m) => m.title === "采样箱 · 上报记录").on, true);
  assert.equal(menuPreviewFor(listOnly).find((m) => m.title === "采样箱 · 上报记录").on, false);
  // 新码菜单可达：judge-only 看得到默认策略页；station-only 看得到默认策略页＋系统设置页
  assert.ok(
    names(new Set(["device:box:policyRead", "device:box:policyCompanyJudge"])).includes(
      "SampleBoxPolicy"
    )
  );
  const stationOnly = new Set(["sys:settings:view", "sys:settings:station"]);
  assert.ok(names(stationOnly).includes("SampleBoxPolicy"));
  assert.ok(names(stationOnly).includes("SystemSettings"));
  // inspect-only 创建页路由不被裁（隐藏子项随 perm）
  assert.ok(
    names(new Set(["device:box:task", "task:create:inspect"])).includes("SampleTaskCreate")
  );

  // reportOptions＋内容鉴权（SampleController，临时库）
  const env = await fresh("perm-p1-reports-");
  const { db } = env;
  try {
    await dept(db, "1", "0", "总公司");
    await dept(db, "2", "1", "华南分公司");
    await dept(db, "3", "1", "华东分公司");
    await box(db, "864317080992517", "2");
    await box(db, "864317080992518", "3");
    const store = new SqlBoxStore(db);
    const sample = new SampleController(store);
    await role(db, "10", "LOG_ONLY", 1, ["device:box:task", "device:box:log"]);
    await role(db, "11", "LIST_ONLY", 1, ["device:box:list", "device:box:detail"]);
    await role(db, "12", "EVENT_ONLY", 1, ["device:box:task", "device:box:event-lid"]);
    await role(db, "13", "SCOPED", 3, ["device:box:task", "device:box:log"]);
    await user(db, "10", "log.only", "2", ["10"]);
    await user(db, "11", "list.only", "2", ["11"]);
    await user(db, "12", "event.only", "2", ["12"]);
    await user(db, "13", "scoped.log", "2", ["13"]);
    const logCtx = await ctxOf(db, "10");
    const listCtx = await ctxOf(db, "11");
    const eventCtx = await ctxOf(db, "12");
    const scopedCtx = await ctxOf(db, "13");

    // reportOptions：log-only 200，仅 id+name 两键；list-only（无 log/event）403；event-only 200
    const opts = await call(sample.reportOptions.bind(sample), logCtx);
    assert.equal(opts.ok, true, opts.error);
    assert.equal(opts.data.length, 2);
    for (const row of opts.data) assert.deepEqual(Object.keys(row).sort(), ["id", "name"]);
    // 未起名箱子（name 回显 id＝IMEI）：无设备标识权限 → name 清空（maskBox 同口径），整串不下发
    const unnamed = opts.data.find((r) => r.id === "864317080992517");
    assert.equal(unnamed.name, "");
    const optsDenied = await call(sample.reportOptions.bind(sample), listCtx);
    assert.equal(optsDenied.ok, false);
    assert.equal(optsDenied.code, "A0301");
    const optsEvent = await call(sample.reportOptions.bind(sample), eventCtx);
    assert.equal(optsEvent.ok, true, optsEvent.error);
    // 数据范围：scope3 本单位（dept2）只看得到 org2 的箱子（org3 的裁掉）
    const scopedOpts = await call(sample.reportOptions.bind(sample), scopedCtx);
    assert.equal(scopedOpts.ok, true, scopedOpts.error);
    assert.deepEqual(
      scopedOpts.data.map((r) => r.id),
      ["864317080992517"]
    );

    // 内容鉴权不动：logs 全量要 device:box:log；事件-only 按种类查事件码；list-only 403
    const window = { from: "2026-11-20 00:00:00", to: "2026-11-22 00:00:00" };
    const logs = (ctx, query) =>
      call(sample.logs.bind(sample), {
        ...ctx,
        params: { id: "864317080992517" },
        query: { ...window, ...query },
      });
    const logAll = await logs(logCtx, {});
    assert.equal(logAll.ok, true, logAll.error);
    const listDenied = await logs(listCtx, {});
    assert.equal(listDenied.ok, false);
    assert.equal(listDenied.code, "A0301");
    const eventPad = await logs(eventCtx, { kind: "pad" });
    assert.equal(eventPad.ok, true, eventPad.error);
    const eventAll = await logs(eventCtx, {});
    assert.equal(eventAll.ok, false, "事件-only 查全量仍 403（#logPerm 不动）");
    assert.equal(eventAll.code, "A0301");
    const eventBoot = await logs(eventCtx, { kind: "boot" });
    assert.equal(eventBoot.ok, false, "未持上电码查上电仍 403");
    // 概览与列表同口径
    const summary = await call(sample.uplinkSummary.bind(sample), {
      ...logCtx,
      params: { id: "864317080992517" },
      query: window,
    });
    assert.equal(summary.ok, true, summary.error);
    // 路由注册事实：report-options 在 /boxes/:id 之前（matchRoute 顺序匹配）＋some 门
    const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
    const optRoute = routes.match(
      /path: "\/api\/v1\/sample\/boxes\/report-options",[\s\S]*?handler: \(ctx\) => useSample\(ctx, \(api\) => api\.reportOptions\(ctx\)\),/
    );
    assert.ok(optRoute, "report-options 路由要注册");
    assert.match(optRoute[0], /"device:box:log"/);
    assert.match(optRoute[0], /"device:box:event-charge"/);
    assert.ok(
      routes.indexOf('path: "/api/v1/sample/boxes/report-options"') <
        routes.indexOf('path: "/api/v1/sample/boxes/:id"'),
      "report-options 必须先于 :id 注册"
    );
  } finally {
    await env.close();
  }
});

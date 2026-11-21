/**
 * R13 公司级策略中心（任务 #46，P0+P1）。
 * 守住：
 * 1. 058 幂等（建表/加列/补码/备份，重跑不重复）＋新库模板码集；
 * 2. 层优先级 单箱>长期单箱>任务>批量>公司>系统，公司层 null＝整层继承、版本指纹稳定；
 * 3. 双频：task_json 只作建单初始值＋空策略兜底（选项 A），快照冻结进行中不波及；idle 实时生效；
 * 4. 检测站期间按寄出分公司（任务 fromOrg 快照）——策略与判定阈值同口径；
 * 5. GET/PUT /depts/:id/policy 闸门：policyRead＋view 读、policyCompany＋manageOrgIds 写（越权 403）、
 *    type=公司＋顶级公司校验；审计 orgId=目标公司 detail={before,after,affectedBoxCount}；
 * 6. rl= 灯回显解析入库＋三态（已确认/未回报/不符），总状态维持 pv/rp/rc（旧固件兼容）；
 * 7. 公司化判定读取点：flagMatch/boxOnline（内存）与 stats/onlineSql（SQL）低电/宽限按公司，
 *    到达半径按寄出公司；划拨/撤销后公司层随归属切换。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { up as up058 } from "../migrations/058_company_policy.js";
import { ReportPolicy, resolvePolicy, validatePolicy } from "../src/settings/ReportPolicy.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import {
  companyBoxIds,
  companyJudgmentFor,
  companyLimits,
  companyOrgForBox,
  readCompanyPolicy,
  saveCompanyPolicy,
  validateCompanyNumbers,
} from "../src/settings/companyPolicy.js";
import { taskRadiusOf } from "../src/settings/taskPlaces.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import {
  resolveAccess,
  seedRolePerms,
  usableMv,
  flagMatch,
  boxOnline,
} from "../src/auth/boxAccess.js";
import { limits } from "../src/http/SampleController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { formatTimestamp } from "../src/domain/Clock.js";

const p = (n, extra = {}) => ({ reportPeriodSec: n, reportOnlyWhenCharging: false, ...extra });

/** 全局默认基线（模块级 applied 是共享态，每个用例先钉死）。 */
function baseline() {
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      reportOnlyWhenCharging: false,
      batteryReserve: 20,
      arriveRadiusM: 2000,
      taskOfflineGraceSec: 3600,
    },
  });
}

async function fresh(prefix = "company-policy-") {
  baseline();
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
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

async function box(db, id, orgId, extra = {}) {
  await db.run(
    "INSERT INTO sample_box (id,imei,life,org,org_id,activate_step,firmware) VALUES (?,?,?,?,?,?,?)",
    [
      id,
      id,
      extra.life || "未使用",
      orgId ? `单位${orgId}` : "总公司",
      orgId || "",
      "已确认",
      extra.firmware || "1.0.17",
    ]
  );
  if (extra.batteryMv != null)
    await db.run("UPDATE sample_box SET battery_mv=? WHERE id=?", [extra.batteryMv, id]);
  if (extra.boundTaskAt != null)
    await db.run("UPDATE sample_box SET bound_task_id='T-X', bound_task_at=? WHERE id=?", [
      extra.boundTaskAt,
      id,
    ]);
  return db.get("SELECT * FROM sample_box WHERE id=?", [id]);
}

async function saveCompany(db, orgId, value, actor = { name: "测试" }) {
  return saveCompanyPolicy(
    db,
    orgId,
    {
      idle: value.idle == null ? null : validatePolicy(value.idle),
      task: value.task == null ? null : validatePolicy(value.task),
      batteryReserve: value.batteryReserve ?? null,
      arriveRadiusM: value.arriveRadiusM ?? null,
      taskOfflineGraceSec: value.taskOfflineGraceSec ?? null,
    },
    actor
  );
}

async function ctxOf(db, username) {
  const user = await db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
  return { db, user, access: await resolveAccess(db, user), query: {}, ip: "127.0.0.1" };
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

function controllerOf(db) {
  const policies = new ReportPolicy(db);
  const controller = new ReportPolicyController({ summaryCache: null }, policies);
  // call() 以裸函数方式调用 handler：把公开方法绑回实例（私有方法经 this 品牌检查）
  for (const key of Object.getOwnPropertyNames(ReportPolicyController.prototype)) {
    if (key !== "constructor" && typeof controller[key] === "function")
      controller[key] = controller[key].bind(controller);
  }
  return { policies, controller };
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

test("058 幂等：建表/echo_lights/补码/备份，重跑不重复；存量缺码补齐；新库模板含公司码", async () => {
  const env = await fresh("company-migration-");
  const { db } = env;
  try {
    // 新库模板路径：seedRolePerms 按 DEFAULT_ROLE_PERMS 落行（058 迁移时角色还没种）
    const branch = await db.get("SELECT id FROM sys_role WHERE code='BRANCH_ADMIN'");
    const dispatch = await db.get("SELECT id FROM sys_role WHERE code='DISPATCH'");
    for (const role of [branch, dispatch]) {
      const rows = await db.all(
        "SELECT perm FROM sys_role_perm WHERE role_id=? AND perm='device:box:policyCompany'",
        [String(role.id)]
      );
      assert.equal(rows.length, 1, "模板码集应含 policyCompany");
    }
    // 表/列/备份存在
    await db.run("INSERT INTO box_company_policy (dept_id, idle_json) VALUES ('2', ?)", [
      JSON.stringify(p(120)),
    ]);
    assert.equal(
      (await db.get("SELECT idle_json FROM box_company_policy WHERE dept_id='2'")).idle_json,
      JSON.stringify(p(120))
    );
    const cols = await db.all("PRAGMA table_info(box_report_delivery)");
    assert.ok(cols.some((c) => c.name === "echo_lights"));
    assert.ok(
      await db.get("SELECT name FROM sqlite_master WHERE name='_bak_company_policy_sys_role_perm'")
    );
    // 存量补码路径：收回后直接重跑 058.up → 连前置 policyRead 一起补齐且不重复（幂等）
    await db.run(
      "DELETE FROM sys_role_perm WHERE perm IN ('device:box:policyCompany','device:box:policyRead')"
    );
    await up058(db);
    await up058(db);
    for (const role of [branch, dispatch]) {
      for (const perm of ["device:box:policyRead", "device:box:policyCompany"]) {
        const rows = await db.all(
          "SELECT grantable FROM sys_role_perm WHERE role_id=? AND perm=?",
          [String(role.id), perm]
        );
        assert.equal(rows.length, 1, `重跑不重复补码 ${perm}`);
      }
    }
    // BRANCH_ADMIN 有 sys:user:role → grantsAll 可转授；DISPATCH 无 → 不可转授（056②b 口径）
    const branchGrant = await db.get(
      "SELECT grantable FROM sys_role_perm WHERE role_id=? AND perm='device:box:policyCompany'",
      [String(branch.id)]
    );
    const dispatchGrant = await db.get(
      "SELECT grantable FROM sys_role_perm WHERE role_id=? AND perm='device:box:policyCompany'",
      [String(dispatch.id)]
    );
    assert.equal(Number(branchGrant.grantable), 1);
    assert.equal(Number(dispatchGrant.grantable), 0);
    // 备份表不被重跑覆盖（首次备份留底）
    assert.ok(
      await db.get("SELECT name FROM sqlite_master WHERE name='_bak_company_policy_sys_role_perm'")
    );
    // 生效权限解析含新码
    const branchUser = await person(db, "90", "accept.branch", "2", [String(branch.id)]);
    const access = await resolveAccess(db, branchUser);
    assert.ok(access.perms.has("device:box:policyCompany"));
    assert.deepEqual(access.scope.manageOrgIds.sort(), ["2", "21"]);
  } finally {
    await env.close();
  }
});

test("层优先级：单箱>长期单箱>任务>批量>公司>系统；公司 null 整层继承且版本指纹不变", async () => {
  baseline();
  const company = p(90);
  // 公司层插在批量与系统默认之间
  assert.equal(resolvePolicy(null, null, null, "a", company).reportPeriodSec, 90);
  assert.equal(resolvePolicy(null, null, null, "a", company).source, "公司默认");
  assert.equal(resolvePolicy(null, p(120), null, "a", company).reportPeriodSec, 120);
  assert.equal(resolvePolicy(null, p(120), null, "a", company).source, "批量设置");
  const task = { policy: p(30), overrides: { a: p(5) } };
  assert.equal(resolvePolicy(null, null, task, "b", company).reportPeriodSec, 30);
  assert.equal(resolvePolicy(p(10), null, task, "b", company).reportPeriodSec, 10);
  assert.equal(resolvePolicy(null, null, task, "a", company).reportPeriodSec, 5);
  // 公司层 null＝整层继承系统默认：与改造前逐字节一致（版本不变，不触发重发）
  const before = resolvePolicy(null, null, null, "a");
  const inherited = resolvePolicy(null, null, null, "a", null);
  assert.equal(inherited.source, "系统默认");
  assert.equal(inherited.version, before.version);
  assert.notEqual(resolvePolicy(null, null, null, "a", company).version, before.version);
  // 每层完整策略：公司层的灯/定位随整层生效，不逐字段拼接
  const lit = resolvePolicy(
    null,
    null,
    null,
    "a",
    p(90, { indicators: false, periodicGps: false })
  );
  assert.equal(lit.indicators, false);
  assert.equal(lit.periodicGps, false);

  const env = await fresh("company-layers-");
  const { db } = env;
  try {
    const { policies } = controllerOf(db);
    const b2 = await box(db, "B2", "2");
    const b3 = await box(db, "B3", "3");
    const systemVersion = (await policies.get(b2)).effective.version;
    await saveCompany(db, "2", { idle: p(120) });
    const got2 = await policies.get(b2);
    assert.equal(got2.effective.reportPeriodSec, 120);
    assert.equal(got2.effective.source, "公司默认");
    assert.equal((await policies.get(b3)).effective.source, "系统默认");
    // refresh 快照列：公司默认写生效值（非系统默认不写 NULL）
    await policies.refresh(["B2", "B3"], db);
    assert.equal(
      Number(
        (await db.get("SELECT policy_period_sec FROM sample_box WHERE id='B2'")).policy_period_sec
      ),
      120
    );
    assert.equal(
      (await db.get("SELECT policy_period_sec FROM sample_box WHERE id='B3'")).policy_period_sec,
      null
    );
    // 单箱/批量仍覆盖公司层
    await policies.save(["B2"], "batch", p(200));
    assert.equal((await policies.get(b2)).effective.reportPeriodSec, 200);
    await policies.save(["B2"], "single", p(10));
    assert.equal((await policies.get(b2)).effective.reportPeriodSec, 10);
    await policies.save(["B2"], "single", null);
    await policies.save(["B2"], "batch", null);
    assert.equal((await policies.get(b2)).effective.reportPeriodSec, 120);
    // 公司层清空 → 回落系统默认，版本指纹回到无公司层时的值（不重发风暴）
    await saveCompany(db, "2", { idle: null });
    const back = await policies.get(b2);
    assert.equal(back.effective.source, "系统默认");
    assert.equal(back.effective.version, systemVersion);
  } finally {
    await env.close();
  }
});

test("双频：task_json 建单初始值＋空策略兜底，快照冻结进行中不波及；idle 实时生效", async () => {
  const env = await fresh("company-dual-");
  const { db } = env;
  try {
    const { policies } = controllerOf(db);
    const b2 = await box(db, "B2", "2", { firmware: "1.0.17" });
    const bOld = await box(db, "BOLD", "2", { firmware: "1.0.4" });
    await saveCompany(db, "2", { idle: p(90), task: p(30) });
    // 空 policy 建单 → 公司 task_json 兜底入 body.policy 并冻结快照
    const id = await policies.createTask({
      name: "双频单",
      kind: "采样",
      inspect: true,
      fromOrgId: "2",
      toOrgId: "13",
      boxIds: ["B2", "BOLD"],
      policy: null,
      overrides: {},
    });
    const body = JSON.parse((await db.get("SELECT body FROM sample_task WHERE id=?", [id])).body);
    assert.equal(body.policy.reportPeriodSec, 30);
    assert.ok(body.policy.revision, "兜底策略盖 revision（与显式任务策略同口径）");
    assert.equal(body.assignedPolicies.B2.reportPeriodSec, 30);
    assert.equal(body.assignedPolicies.B2.source, "任务统一");
    // 新固件：建单即按快照下发
    assert.equal((await policies.get(b2)).effective.reportPeriodSec, 30);
    // 公司级后续修改（task 45 / idle 95）不波及进行中任务的快照
    await saveCompany(db, "2", { idle: p(95), task: p(45) });
    assert.equal((await policies.get(b2)).effective.reportPeriodSec, 30);
    const after = JSON.parse((await db.get("SELECT body FROM sample_task WHERE id=?", [id])).body);
    assert.equal(after.assignedPolicies.B2.reportPeriodSec, 30);
    // 旧固件：任务开始后按 body.policy（建单冻结）执行，也不用公司新 task 值
    await policies.transition(id, "采样中");
    assert.equal((await policies.get(bOld)).effective.reportPeriodSec, 30);
    // 显式任务策略优先于公司兜底
    const id2 = await policies.createTask({
      name: "显式单",
      kind: "采样",
      inspect: true,
      fromOrgId: "2",
      toOrgId: "13",
      boxIds: [],
      policy: p(50),
      overrides: {},
    });
    const body2 = JSON.parse((await db.get("SELECT body FROM sample_task WHERE id=?", [id2])).body);
    assert.equal(body2.policy.reportPeriodSec, 50);
    // 公司未设 task_json → 空 policy 建单行为不变（body.policy=null）
    await saveCompany(db, "3", { idle: null, task: null });
    const id3 = await policies.createTask({
      name: "无公司任务策略",
      kind: "采样",
      inspect: true,
      fromOrgId: "3",
      toOrgId: "13",
      boxIds: [],
      policy: null,
      overrides: {},
    });
    const body3 = JSON.parse((await db.get("SELECT body FROM sample_task WHERE id=?", [id3])).body);
    assert.equal(body3.policy, null);
  } finally {
    await env.close();
  }
});

test("检测站期间：策略与判定阈值按寄出分公司（任务 fromOrg 快照）；无任务回落挂名公司", async () => {
  const env = await fresh("company-station-");
  const { db } = env;
  try {
    const { policies } = controllerOf(db);
    // 华南(2) idle 90 / 总公司(1) idle 70；箱子签收后挂检测站 13
    await saveCompany(db, "2", { idle: p(90), batteryReserve: 50, taskOfflineGraceSec: 120 });
    await saveCompany(db, "1", { idle: p(70) });
    await box(db, "BS", "2");
    const id = await policies.createTask({
      name: "寄检测站",
      kind: "采样",
      inspect: true,
      fromOrgId: "2",
      toOrgId: "13",
      boxIds: ["BS"],
      policy: null,
      overrides: {},
    });
    // 签收交接：归属改挂检测站（与 transition handOver 同效）
    await db.run("UPDATE sample_box SET org_id='13', org='总部检测站' WHERE id='BS'");
    await policies.transition(id, "采样中");
    await policies.transition(id, "已封箱");
    await policies.transition(id, "在途");
    await policies.transition(id, "待签收");
    await policies.transition(id, "待检测");
    const atStation = await db.get("SELECT * FROM sample_box WHERE id='BS'");
    assert.equal(atStation.org_id, "13");
    // 任务已结束（待检测→已检测）仍按寄出公司：最近一张寄站任务的 fromOrg 快照
    await policies.transition(id, "已检测");
    assert.equal(await companyOrgForBox(db, atStation), "2");
    const got = await policies.get(atStation);
    assert.equal(got.effective.reportPeriodSec, 90);
    assert.equal(got.effective.source, "公司默认");
    // 判定阈值同口径：companyLimits 的 stationBoxes 映射到寄出公司
    const lim = await companyLimits(db, limits());
    assert.equal(lim.company.stationBoxes.get("BS"), "2");
    assert.equal((await companyJudgmentFor(db, "2")).batteryReserve, 50);
    // 手工改挂到检测站、没有寄站任务的箱子 → 回落 companyOf(13)=总公司
    const manual = await box(db, "BM", "13");
    assert.equal(await companyOrgForBox(db, manual), "1");
    assert.equal((await policies.get(manual)).effective.reportPeriodSec, 70);
    // companyBoxIds：公司 2 的箱子集合含检测站里由它寄出的 BS
    const ids = await companyBoxIds(db, "2");
    assert.ok(ids.includes("BS"));
    assert.ok(!ids.includes("BM"));
  } finally {
    await env.close();
  }
});

test("公司策略端点：manageOrgIds 越权 403、读 view 闸门、type/顶级公司校验、审计 detail", async () => {
  const env = await fresh("company-gate-");
  const { db } = env;
  try {
    const { controller } = controllerOf(db);
    await box(db, "B2", "2");
    await box(db, "B21", "21");
    await box(db, "B3", "3");
    await person(db, "90", "accept.branch", "2", ["12"]);
    const branch = await ctxOf(db, "accept.branch");
    const dispatch = await ctxOf(db, "chen.ke"); // 调度室 21，DISPATCH scope2
    const admin = await ctxOf(db, "admin");
    const sampler = await ctxOf(db, "lin.xia"); // scope4 无 policyRead

    // 分公司管理员：本公司可写（manageOrgIds=[2,21] 含 2）
    const okSave = await call(controller.companyPolicySave, {
      ...branch,
      params: { id: "2" },
      body: {
        idle: p(120),
        task: p(30),
        batteryReserve: 50,
        arriveRadiusM: null,
        taskOfflineGraceSec: null,
      },
    });
    assert.equal(okSave.ok, true, okSave.error);
    assert.equal(okSave.data.affectedBoxCount, 2, "B2+B21 都归华南公司");
    assert.equal(okSave.data.idle.reportPeriodSec, 120);
    assert.equal(okSave.data.system.batteryReserve, 20);
    // 越权公司 → 403 A0301（manage 口径不含别的公司）
    const cross = await call(controller.companyPolicySave, {
      ...branch,
      params: { id: "3" },
      body: { idle: p(60) },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.code, "A0301");
    // 调度员（dept 21）：manage=[21] 不含公司 2 → 403；但 view orgIds 含祖先 2 → 可读、can.write=false
    const dispatchSave = await call(controller.companyPolicySave, {
      ...dispatch,
      params: { id: "2" },
      body: { idle: p(60) },
    });
    assert.equal(dispatchSave.status, 403);
    const dispatchRead = await call(controller.companyPolicyRead, {
      ...dispatch,
      params: { id: "2" },
    });
    assert.equal(dispatchRead.ok, true, dispatchRead.error);
    assert.equal(dispatchRead.data.can.write, false);
    assert.equal(dispatchRead.data.idle.reportPeriodSec, 120);
    assert.equal(dispatchRead.data.boxCount, 2);
    // 下级部门（调度室 21 type=公司 但非顶级）→ 400：不收死配置
    const sub = await call(controller.companyPolicySave, {
      ...branch,
      params: { id: "21" },
      body: { idle: p(60) },
    });
    assert.equal(sub.status, 400);
    // 检测站 → 400（沿划拨 P8 口径）；不存在 → 400
    const station = await call(controller.companyPolicySave, {
      ...admin,
      params: { id: "13" },
      body: { idle: p(60) },
    });
    assert.equal(station.status, 400);
    assert.match(station.error, /检测站/);
    const missing = await call(controller.companyPolicyRead, { ...admin, params: { id: "999" } });
    assert.equal(missing.status, 400);
    // 无 policyRead → 403（读也要码）
    const samplerRead = await call(controller.companyPolicyRead, {
      ...sampler,
      params: { id: "2" },
    });
    assert.equal(samplerRead.status, 403);
    // ADMIN（all）可改各分公司
    const adminSave = await call(controller.companyPolicySave, {
      ...admin,
      params: { id: "3" },
      body: {
        idle: p(300),
        task: null,
        batteryReserve: null,
        arriveRadiusM: 500,
        taskOfflineGraceSec: 600,
      },
    });
    assert.equal(adminSave.ok, true, adminSave.error);
    // 范围校验：周期/阈值越界友好报错
    const badPeriod = await call(controller.companyPolicySave, {
      ...admin,
      params: { id: "3" },
      body: { idle: p(4) },
    });
    assert.equal(badPeriod.status, 400);
    const badReserve = await call(controller.companyPolicySave, {
      ...admin,
      params: { id: "3" },
      body: { idle: null, batteryReserve: 81 },
    });
    assert.equal(badReserve.status, 400);
    assert.deepEqual(validateCompanyNumbers({ batteryReserve: null }), {
      batteryReserve: null,
      arriveRadiusM: null,
      taskOfflineGraceSec: null,
    });
    // 审计：orgId=目标公司（PM 裁决），detail={before,after,affectedBoxCount}
    const logs = await db.all(
      "SELECT * FROM sys_operation_log WHERE action='修改公司策略' ORDER BY id"
    );
    assert.equal(logs.length, 2, "两次成功保存各一条（失败不记）");
    assert.equal(logs[0].org_id, "2");
    assert.equal(logs[0].org_name, "华南分公司");
    assert.equal(logs[0].target_type, "company-policy");
    assert.equal(logs[0].target_id, "2");
    const detail = JSON.parse(logs[0].detail);
    assert.equal(detail.before.idle, null);
    assert.equal(detail.after.idle.reportPeriodSec, 120);
    assert.equal(detail.after.batteryReserve, 50);
    assert.equal(detail.affectedBoxCount, 2);
    assert.equal(logs[1].org_id, "3", "第二条记目标公司 3 而不是 actor 部门");
    // 读模型：NULL 列原样下发（继承），updatedAt/updatedBy 有值
    const read = await readCompanyPolicy(db, "3");
    assert.equal(read.batteryReserve, null);
    assert.equal(read.arriveRadiusM, 500);
    assert.equal(read.taskOfflineGraceSec, 600);
    assert.ok(read.updatedAt);
  } finally {
    await env.close();
  }
});

test("rl= 灯回显：解析入库＋三态（已确认/未回报/不符），总状态维持 pv/rp/rc", async () => {
  const env = await fresh("company-lights-");
  const { db } = env;
  try {
    const { policies } = controllerOf(db);
    const b = await box(db, "BL", "2", { firmware: "1.0.17" });
    const parser = new UplinkParser();
    // 解析：rl=0/1 收，越界当没报
    const up1 = parser.parse(
      JSON.stringify({ imei: "864317080992517", uart: "why=timer,pv=9,rp=60,rc=0,rl=1,fw=1.0.17" })
    );
    assert.equal(up1.reportLights, 1);
    const up0 = parser.parse(
      JSON.stringify({ imei: "864317080992517", uart: "why=timer,pv=9,rp=60,rc=0,rl=0,fw=1.0.17" })
    );
    assert.equal(up0.reportLights, 0);
    const upBad = parser.parse(
      JSON.stringify({ imei: "864317080992517", uart: "why=timer,pv=9,rp=60,rc=0,rl=2,fw=1.0.17" })
    );
    assert.equal(upBad.reportLights, null);
    const upOld = parser.parse(
      JSON.stringify({ imei: "864317080992517", uart: "why=timer,pv=9,rp=60,rc=0,fw=1.0.4" })
    );
    assert.equal(upOld.reportLights, null);

    // 明确关灯策略 + 设备回 rl=1 → 灯「不符」，但 pv/rp/rc 匹配 → 总状态仍「已生效」
    await policies.save(["BL"], "single", p(60, { indicators: false }));
    const packet = await policies.packet(b);
    await policies.sent(b.id, packet.version);
    const mismatch = parser.parse(
      JSON.stringify({
        imei: "864317080992517",
        uart: `why=timer,pv=${packet.version},rp=60,rc=0,rl=1,fw=1.0.17`,
      })
    );
    await policies.observe(b, mismatch);
    const got = await policies.get(b);
    assert.equal(got.status, "已生效");
    assert.equal(got.echo.lights, true);
    assert.equal(got.lightsStatus, "不符");
    // 设备改回 rl=0 → 已确认
    const match = parser.parse(
      JSON.stringify({
        imei: "864317080992517",
        uart: `why=timer,pv=${packet.version},rp=60,rc=0,rl=0,fw=1.0.17`,
      })
    );
    await policies.observe(b, match);
    assert.equal((await policies.get(b)).lightsStatus, "已确认");
    // 旧固件无 rl → 未回报（不判未生效）
    const noRl = parser.parse(
      JSON.stringify({
        imei: "864317080992517",
        uart: `why=timer,pv=${packet.version},rp=60,rc=0,fw=1.0.17`,
      })
    );
    await policies.observe(b, noRl);
    const old = await policies.get(b);
    assert.equal(old.status, "已生效");
    assert.equal(old.echo.lights, null);
    assert.equal(old.lightsStatus, "未回报");
    // 换版本重发 → echo_lights 重置
    await policies.save(["BL"], "single", p(120));
    const packet2 = await policies.packet(b);
    await policies.sent(b.id, packet2.version);
    assert.equal((await policies.get(b)).echo, null);
    assert.equal((await policies.get(b)).lightsStatus, null);
  } finally {
    await env.close();
  }
});

test("公司化判定：低电/宽限按公司（内存 flagMatch/boxOnline 与 SQL stats 同口径），到达半径按寄出公司", async () => {
  const env = await fresh("company-judgment-");
  const { db } = env;
  try {
    const store = new SqlBoxStore(db);
    // 华南(2)：预留 50%、宽限 60s、半径 500m；华东(3) 未设 → 全局 20%/3600s/2000m
    await saveCompany(db, "2", {
      idle: null,
      batteryReserve: 50,
      taskOfflineGraceSec: 60,
      arriveRadiusM: 500,
    });
    const mv = Math.round((usableMv(20, 20) + usableMv(20, 50)) / 2);
    const boundAt = formatTimestamp(new Date(Date.now() - 100 * 1000)).slice(0, 19);
    const b2 = await box(db, "J2", "2", { batteryMv: mv, boundTaskAt: boundAt });
    const b3 = await box(db, "J3", "3", { batteryMv: mv, boundTaskAt: boundAt });
    const lim = await companyLimits(db, limits());
    assert.ok(lim.company, "有公司覆盖时 company 数据非空");
    // 内存判定：低电——公司 50% 预留判低电，全局 20% 不判
    assert.equal(flagMatch({ ...b2, id: "J2", orgId: "2", batteryMv: mv }, "low", lim), true);
    assert.equal(flagMatch({ ...b3, id: "J3", orgId: "3", batteryMv: mv }, "low", lim), false);
    // 内存判定：宽限——占用从未上报 100s：公司 60s 超宽限判离线，全局 3600s 仍中性在线
    const json2 = { id: "J2", orgId: "2", last: "", boundTaskAt: boundAt, charge: 0 };
    const json3 = { id: "J3", orgId: "3", last: "", boundTaskAt: boundAt, charge: 0 };
    assert.equal(boxOnline(json2, lim), false);
    assert.equal(boxOnline(json3, lim), true);
    // SQL 判定：stats 与内存同口径（低电 1 台、离线 1 台）
    const stats = await store.stats({ scope: null, limits: lim });
    assert.equal(stats.flags.low, 1);
    assert.equal(stats.flags.offline, 1);
    const byOrg = await store.statsByOrg(lim);
    assert.equal(byOrg.get("2").flags.low, 1);
    assert.equal(byOrg.get("3").flags.low, 0);
    assert.equal(byOrg.get("2").flags.offline, 1);
    assert.equal(byOrg.get("3").flags.offline, 0);
    // 无公司覆盖时 company=null（SQL 与改造前一致）
    await saveCompany(db, "2", {
      idle: null,
      batteryReserve: null,
      taskOfflineGraceSec: null,
      arriveRadiusM: null,
    });
    const plain = await companyLimits(db, limits());
    assert.equal(plain.company, null);
    const statsPlain = await store.stats({ scope: null, limits: plain });
    assert.equal(statsPlain.flags.low, 0);
    assert.equal(statsPlain.flags.offline, 0);
    // 到达半径：寄出公司覆盖优先，地址显式半径更优先，未覆盖回落全局
    assert.equal(await taskRadiusOf(db, { fromOrgId: "2" }, null), 2000, "清空后回落全局");
    await saveCompany(db, "2", { idle: null, arriveRadiusM: 500 });
    assert.equal(await taskRadiusOf(db, { fromOrgId: "21" }, null), 500, "下级部门向上归公司");
    assert.equal(await taskRadiusOf(db, { fromOrgId: "2" }, { radiusM: 800 }), 800);
    assert.equal(await taskRadiusOf(db, { fromOrgId: "3" }, null), 2000);
    assert.equal(await taskRadiusOf(db, {}, null), 2000, "旧单无 fromOrg 回落全局/总公司");
  } finally {
    await env.close();
  }
});

test("划拨/撤销划拨：公司默认层随归属切换，同事务刷新生效值快照", async () => {
  const env = await fresh("company-transfer-");
  const { db } = env;
  try {
    const { policies } = controllerOf(db);
    const b = await box(db, "BT", "2");
    await saveCompany(db, "2", { idle: p(120) });
    await saveCompany(db, "3", { idle: p(300) });
    await policies.refresh(["BT"], db);
    assert.equal((await policies.get(b)).effective.reportPeriodSec, 120);
    const result = await policies.createTransfer(
      { name: "划拨到华东", toOrgId: "3", boxIds: ["BT"], clientToken: "tok-r13" },
      { id: "90", name: "分公司管理员" }
    );
    const moved = await db.get("SELECT * FROM sample_box WHERE id='BT'");
    assert.equal(moved.org_id, "3");
    const got = await policies.get(moved);
    assert.equal(got.effective.reportPeriodSec, 300);
    assert.equal(got.effective.source, "公司默认");
    assert.equal(Number(moved.policy_period_sec), 300);
    // 幂等重放（同 clientToken）返回原单，不重复转移/下发
    const again = await policies.createTransfer(
      { name: "划拨到华东", toOrgId: "3", boxIds: ["BT"], clientToken: "tok-r13" },
      { id: "90", name: "分公司管理员" }
    );
    assert.equal(again.id, result.id);
    assert.equal(again.idempotent, true);
    // 撤销 → 退回华南，公司层切回 120
    await policies.revokeTransfer(result.id, {
      reason: "测试退回",
      actor: { id: "90", name: "测试" },
    });
    const back = await db.get("SELECT * FROM sample_box WHERE id='BT'");
    assert.equal(back.org_id, "2");
    assert.equal((await policies.get(back)).effective.reportPeriodSec, 120);
    assert.equal(Number(back.policy_period_sec), 120);
  } finally {
    await env.close();
  }
});

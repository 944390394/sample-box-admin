/**
 * R28 分公司自箱上报策略（任务 #95，用户拍板「分公司管理员应该可以设置自己公司下的采样箱」）＋068 服务端契约：
 * - 068 幂等/两角色补码：BRANCH_ADMIN/STATION_ADMIN 缺 policyWrite/policyBatch 者补；grantable 沿该角色现有 max
 *   （无授权行时 0）；已有其一不改不重、只补另一个；ADMIN 短路不落行；自定义角色/STATION_STAFF 不动；
 *   角色不存在跳过（不建角色）；_bak_068 双表留底；含 device:box:policyRead 的受限部门上限同补防交集裁掉；重跑不变。
 * - 模板/新种子口径：DEFAULT_ROLE_PERMS.BRANCH_ADMIN 含两写码、无重复；seedRolePerms/ROLE_TEMPLATES 单源同口径；
 *   其他非 ADMIN 模板不借批补两写码（升级链不会自动带出，SPLIT_045 policyTask 不含写码）。
 * - 范围守卫（single/preview/batch 入口，#policyScopeGuard 沿 inPartyScope manage 口径）：
 *   branch 本公司子树箱 single 200 落库／上级总部箱·未分配箱 403「只能设置本公司范围内的采样箱策略」／
 *   他司箱（读可见但 manage 外）403／读不可见的兄弟公司箱仍 targets 404（读门先于守卫，不泄露存在性）；
 *   batch 全本公司 200／混他司整单拒 403 且不落库（不静默过滤）；station admin 本站箱 200 他司 403；
 *   ADMIN 全范围 200；无码角色 require 403「没有这项操作权限」（权限门先于守卫）；preview 同口径早拒。
 * - 审计：single/batch 成功经 this.log 记 action/targetType=report-policy/targetId/result=成功（核对现状）。
 * - resolveAccess 端到端：068 后 BRANCH_ADMIN 真实用户 perms 含两写码（含 policyRead 的部门上限同补不被交集裁掉）；
 *   不含 policyRead 的部门上限仍裁掉（上限是上界不是授权）。
 * 一次性临时库，不碰开发/线上库、不占服务端口（主夹具 8010 不写不碰）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ROLE_PERMS,
  ROLE_TEMPLATES,
  BOX_POLICY_SELF_068,
} from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { up as up068 } from "../migrations/068_box_policy_self.js";

const WRITE = "device:box:policyWrite";
const BATCH = "device:box:policyBatch";
const READ = "device:box:policyRead";
const SCOPE_MSG = /只能设置本公司范围内的采样箱策略/;
const NO_PERM_MSG = /没有这项操作权限/;
const p = (n) => ({ reportPeriodSec: n, reportOnlyWhenCharging: false });

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

async function tempDb(prefix) {
  baseline();
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  return {
    db,
    close: async () => {
      await db.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const addRole = (db, id, code, scope = 2) =>
  db.run("INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES (?,?,?,?,90,1)", [
    id,
    code,
    code,
    scope,
  ]);
const addRolePerm = (db, roleId, perm, grantable = 0) =>
  db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES (?,?,?)", [
    roleId,
    perm,
    grantable,
  ]);
const addDept = (db, id, parent, name, type = "公司") =>
  db.run("INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)", [
    id,
    parent,
    name,
    `D${id}`,
    type,
  ]);
const addUser = (db, id, username, deptId, roles) =>
  db
    .run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
      [id, username, username, deptId]
    )
    .then(() =>
      Promise.all(
        roles.map((r) =>
          db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES (?,?)", [id, r])
        )
      )
    );
async function addBox(db, id, orgId, extra = {}) {
  await db.run(
    "INSERT INTO sample_box (id,imei,name,life,org,org_id,activate_step,firmware) VALUES (?,?,?,?,?,?,?,?)",
    [
      id,
      id,
      extra.name ?? id,
      extra.life || "未使用",
      orgId ? `单位${orgId}` : "总公司",
      orgId || "",
      "已确认",
      extra.firmware || "1.0.17",
    ]
  );
  return db.get("SELECT * FROM sample_box WHERE id=?", [id]);
}
async function ctxOf(db, id) {
  const row = await db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
  return { db, user: row, access: await resolveAccess(db, row), query: {}, ip: "127.0.0.1" };
}
const adminCtx = (db) => ({
  db,
  user: { id: "1", dept_id: "1", nickname: "管理员" },
  access: {
    roles: ["ADMIN"],
    perms: new Set(DEFAULT_ROLE_PERMS.ADMIN),
    grantable: new Set(),
    scope: { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] },
  },
  query: {},
  ip: "127.0.0.1",
});
/** 控制器抛 AppError（noPermission/badRequest/notVisible），映射成 {ok,code,status} 供断言。 */
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
  const controller = new ReportPolicyController(new SqlBoxStore(db), policies);
  for (const key of Object.getOwnPropertyNames(ReportPolicyController.prototype)) {
    if (key !== "constructor" && typeof controller[key] === "function")
      controller[key] = controller[key].bind(controller);
  }
  return { policies, controller };
}

/* ── 068 迁移 ── */

test("068：两角色补码/grantable 沿现有 max/已有其一不改只补另一/ADMIN 短路/自定义与 STATION_STAFF 不动/部门上限同补/留底；重跑幂等", async () => {
  const env = await tempDb("box-policy-self-068-");
  const { db } = env;
  try {
    // legacy：BRANCH_ADMIN 缺两写码（有 policyRead grantable=1 → max=1）；
    // STATION_ADMIN 已有 policyWrite（grantable=0，另有 list grantable=1 → max=1，但已有 write 不改）、缺 batch；
    // STATION_STAFF 缺两码但非目标；ADMIN/CUSTOM 对照。
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await addRole(db, "92", "STATION_STAFF", 3);
    await addRole(db, "1", "ADMIN", 1);
    await addRole(db, "90", "CUSTOM");
    await addRolePerm(db, "14", READ, 1);
    await addRolePerm(db, "91", "device:box:list", 1);
    await addRolePerm(db, "91", WRITE, 0); // 已有 write（grantable=0）
    await addRolePerm(db, "91", READ, 0);
    for (const perm of [READ, "device:box:list"]) await addRolePerm(db, "92", perm, 0);
    await addRolePerm(db, "1", "sys:role:view", 1);
    await addRolePerm(db, "90", READ, 0);
    // 受限部门上限：21 含 policyRead（同补两码）；22 含 policyRead＋write（只补 batch）；13 无 policyRead（不动）
    for (const perm of [READ, "device:box:list"])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('21',?)", [perm]);
    for (const perm of [READ, WRITE])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('22',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('13','device:box:detail')");
    // 清掉 migrate 期（空角色）留下的 068 备份，让本次 up 的备份捕获 legacy 现状
    await db.run("DROP TABLE IF EXISTS _bak_068_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_068_sys_dept_perm");

    const snapshot = async () => ({
      role: await db.all(
        "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
      ),
      dept: await db.all("SELECT dept_id, perm FROM sys_dept_perm ORDER BY dept_id, perm"),
      roles: await db.all("SELECT id, code FROM sys_role ORDER BY id"),
    });
    await up068(db);
    const after1 = await snapshot();
    const permsOf = (roleId) =>
      new Set(after1.role.filter((r) => r.role_id === roleId).map((r) => r.perm));
    const rowsOf = (roleId, perm) =>
      after1.role.filter((r) => r.role_id === roleId && r.perm === perm);

    // BRANCH_ADMIN：补两码，grantable 沿现有 max=1，不重复
    for (const code of BOX_POLICY_SELF_068) {
      assert.ok(permsOf("14").has(code), `BRANCH_ADMIN 应补 ${code}`);
      assert.deepEqual(
        rowsOf("14", code).map((r) => Number(r.grantable)),
        [1],
        `BRANCH_ADMIN 补 ${code} grantable 沿现有 max=1，且不重复`
      );
    }
    // STATION_ADMIN：已有 write 不改不重（grantable 保持 0，不借 max=1 抬升）；缺 batch 补 grantable=1
    assert.deepEqual(
      rowsOf("91", WRITE).map((r) => Number(r.grantable)),
      [0],
      "已有 write 行不改（只补不删不改）"
    );
    assert.deepEqual(
      rowsOf("91", BATCH).map((r) => Number(r.grantable)),
      [1],
      "缺 batch 补，grantable 沿现有 max=1"
    );
    // STATION_STAFF 非目标：不补两写码
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(!permsOf("92").has(code), `STATION_STAFF 不在本批，不补 ${code}`);
    // ADMIN 短路不落行；自定义角色不动
    assert.deepEqual(
      after1.role.filter((r) => r.role_id === "1").map((r) => r.perm),
      ["sys:role:view"],
      "ADMIN 不落行"
    );
    assert.deepEqual(
      after1.role.filter((r) => r.role_id === "90").map((r) => r.perm),
      [READ],
      "自定义角色不动"
    );
    // 部门上限：21 同补两码；22 已有 write 只补 batch；13 无 policyRead 不动
    const deptPerms = (id) => after1.dept.filter((d) => d.dept_id === id).map((d) => d.perm);
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(deptPerms("21").includes(code), `部门21上限含 policyRead 应补 ${code}`);
    assert.deepEqual(
      deptPerms("22").filter((x) => x === WRITE),
      [WRITE],
      "部门22上限已有 write 不重复"
    );
    assert.ok(deptPerms("22").includes(BATCH), "部门22上限缺 batch 应补");
    assert.deepEqual(deptPerms("13"), ["device:box:detail"], "无 policyRead 的部门上限不动");
    // 备份留底＝legacy 现状（BRANCH_ADMIN 不含写码；部门21 不含写码）
    const bakRole = await db.all("SELECT perm FROM _bak_068_sys_role_perm WHERE role_id='14'");
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(!bakRole.some((r) => r.perm === code), `角色备份应为补码前现状（无 ${code}）`);
    const bakDept = await db.all("SELECT perm FROM _bak_068_sys_dept_perm WHERE dept_id='21'");
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(!bakDept.some((r) => r.perm === code), `部门备份应为补码前现状（无 ${code}）`);
    // 重跑幂等：结果完全不变（含角色本体行数、备份不被覆盖）
    await up068(db);
    assert.deepEqual(await snapshot(), after1, "068 重跑结果应不变");
    const bakAgain = await db.all("SELECT perm FROM _bak_068_sys_role_perm WHERE role_id='14'");
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(!bakAgain.some((r) => r.perm === code), "_bak_068 不被重跑覆盖");
  } finally {
    await env.close();
  }
});

test("068：角色不存在跳过（不建角色）；无授权行的目标角色补码 grantable=0；无 sys_role 的老库直接返回", async () => {
  const env = await tempDb("box-policy-self-068-missing-");
  const { db } = env;
  try {
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "1", "ADMIN", 1);
    await addRolePerm(db, "1", "sys:role:view", 1);
    await up068(db);
    const rows = await db.all(
      "SELECT perm, grantable FROM sys_role_perm WHERE role_id='14' ORDER BY perm"
    );
    assert.deepEqual(
      rows.map((r) => [r.perm, Number(r.grantable)]),
      [
        [BATCH, 0],
        [WRITE, 0],
      ],
      "无授权行的 BRANCH_ADMIN 补两写码且 grantable=0"
    );
    const roles = await db.all("SELECT code FROM sys_role ORDER BY id");
    assert.deepEqual(
      roles.map((r) => r.code),
      ["ADMIN", "BRANCH_ADMIN"],
      "不存在的 STATION_ADMIN 不新建"
    );
    const before = await db.all(
      "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
    );
    await db.run("DROP TABLE sys_role");
    await up068(db);
    assert.deepEqual(
      await db.all("SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"),
      before,
      "无 sys_role 时直接返回，权限行不变"
    );
  } finally {
    await env.close();
  }
});

test("模板/新种子：BRANCH_ADMIN 含两写码无重复；seedRolePerms/ROLE_TEMPLATES 单源；其他模板不借批补；DB-only STATION_ADMIN 由 068 补", async () => {
  const branch = DEFAULT_ROLE_PERMS.BRANCH_ADMIN;
  for (const code of BOX_POLICY_SELF_068) assert.ok(branch.includes(code), `模板应含 ${code}`);
  assert.equal(new Set(branch).size, branch.length, "模板码集无重复");
  const template = ROLE_TEMPLATES.find((t) => t.key === "BRANCH_ADMIN");
  for (const code of BOX_POLICY_SELF_068)
    assert.ok(template.codes.includes(code), "ROLE_TEMPLATES 单源随模板");
  for (const key of ["SAMPLER", "DUTY", "VERIFY", "LEADER", "DISPATCH", "ASSET"])
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(!DEFAULT_ROLE_PERMS[key].includes(code), `${key} 模板不借批补 ${code}`);

  const env = await tempDb("box-policy-self-seed-");
  const { db } = env;
  try {
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await seedRolePerms(db);
    const seeded = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id='14'");
    const have = new Set(seeded.map((r) => r.perm));
    for (const code of BOX_POLICY_SELF_068) {
      assert.ok(have.has(code), `新库 BRANCH_ADMIN 应含 ${code}`);
      for (const row of seeded.filter((r) => r.perm === code))
        assert.equal(Number(row.grantable), 1, "种子 grantable=1（grantsAll）");
    }
    assert.equal(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).length,
      0,
      "DB-only 角色无模板默认值（seedRolePerms 跳过）"
    );
    await up068(db);
    const station = new Set(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).map((r) => r.perm)
    );
    for (const code of BOX_POLICY_SELF_068)
      assert.ok(station.has(code), `068 应给 DB-only 角色补 ${code}`);
  } finally {
    await env.close();
  }
});

/* ── 范围守卫夹具 ── */

/**
 * 总公司1／华南分公司2（子21/22，挂总部下）／华东分公司3（兄弟公司）／总部检测站13。
 * 分公司管理员挂 dept2（scope2）：manage=[2,21,22]，read orgIds 含祖先 1＋未分配 ""（读宽于管）。
 * 站点管理员挂 dept13（scope3）：manage=[13]，read 含祖先 1＋""。
 * 角色仅 policyRead（前置），两写码由 068 按 code 补——验证「补码→守卫」全链。
 */
async function seedGuard(db) {
  await addDept(db, "1", "0", "总公司");
  await addDept(db, "2", "1", "华南分公司");
  await addDept(db, "21", "2", "调度一室");
  await addDept(db, "22", "2", "调度二室");
  await addDept(db, "3", "1", "华东分公司");
  await addDept(db, "13", "1", "总部检测站", "检测站");
  await addRole(db, "1", "ADMIN", 1);
  await addRole(db, "14", "BRANCH_ADMIN", 2);
  await addRolePerm(db, "14", READ, 0);
  await addRole(db, "91", "STATION_ADMIN", 3);
  await addRolePerm(db, "91", READ, 0);
  // 无码对照角色：持 policyRead 但无两写码（068 非目标，不补）
  await addRole(db, "90", "READONLY", 2);
  await addRolePerm(db, "90", READ, 0);
  await addUser(db, "1", "admin", "1", ["1"]);
  await addUser(db, "10", "branch", "2", ["14"]);
  await addUser(db, "91", "station", "13", ["91"]);
  await addUser(db, "90", "readonly", "2", ["90"]);
  await up068(db);
  // 箱子：本公司2/子21、总部1、未分配""、兄弟公司3、检测站13
  await addBox(db, "B2", "2");
  await addBox(db, "B21", "21");
  await addBox(db, "B1", "1");
  await addBox(db, "B0", "");
  await addBox(db, "B3", "3");
  await addBox(db, "B13", "13");
}

test("守卫 single：branch 本公司箱 200 落库；总部/未分配箱 403 范围文案；兄弟公司箱读不可见仍 404；恢复继承 200", async () => {
  const env = await tempDb("box-policy-self-single-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller, policies } = controllerOf(db);
    const branch = await ctxOf(db, "10");
    assert.ok(branch.access.perms.has(WRITE), "068 后 branch 持 policyWrite");
    assert.ok(branch.access.perms.has(BATCH), "068 后 branch 持 policyBatch");
    assert.deepEqual(
      branch.access.scope.manageOrgIds.sort(),
      ["2", "21", "22"],
      "manage＝本公司子树"
    );
    assert.ok(branch.access.scope.orgIds.includes("1"), "read 含祖先总部1（读宽于管）");

    // 本公司箱（org2）single 200 落库
    const ok = await call(controller.save, {
      ...branch,
      params: { id: "B2" },
      body: { policy: p(120) },
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.data.saved, true);
    const row = await db.get("SELECT single_json FROM box_report_policy WHERE box_id='B2'");
    assert.equal(JSON.parse(row.single_json).reportPeriodSec, 120, "单箱策略落库");
    assert.equal(
      (await policies.get(await db.get("SELECT * FROM sample_box WHERE id='B2'"))).effective
        .reportPeriodSec,
      120
    );
    // 子部门箱（org21）也在 manage 子树 → 200
    assert.equal(
      (await call(controller.save, { ...branch, params: { id: "B21" }, body: { policy: p(90) } }))
        .ok,
      true
    );
    // 总部箱（org1，读可见 manage 外）→ 403 范围文案
    const hq = await call(controller.save, {
      ...branch,
      params: { id: "B1" },
      body: { policy: p(60) },
    });
    assert.equal(hq.ok, false);
    assert.equal(hq.status, 403);
    assert.equal(hq.code, "A0301");
    assert.match(hq.error, SCOPE_MSG);
    assert.equal(
      await db.get("SELECT single_json FROM box_report_policy WHERE box_id='B1'"),
      undefined,
      "越权箱不落库"
    );
    // 未分配箱（org""，读可见 manage 外）→ 403
    const unassigned = await call(controller.save, {
      ...branch,
      params: { id: "B0" },
      body: { policy: p(60) },
    });
    assert.equal(unassigned.status, 403);
    assert.match(unassigned.error, SCOPE_MSG);
    // 兄弟公司箱（org3，读不可见）→ targets 读门先拒 404（不泄露存在性，非守卫 403）
    const sibling = await call(controller.save, {
      ...branch,
      params: { id: "B3" },
      body: { policy: p(60) },
    });
    assert.equal(sibling.status, 404);
    assert.equal(sibling.code, "A0404");
    // 恢复继承（policy null）本公司箱 → 200
    const inherit = await call(controller.save, {
      ...branch,
      params: { id: "B2" },
      body: { policy: null },
    });
    assert.equal(inherit.ok, true, inherit.error);
    assert.equal(
      JSON.parse(
        (await db.get("SELECT single_json FROM box_report_policy WHERE box_id='B2'")).single_json
      ),
      null,
      "恢复继承：single_json 解析为 null（落底公司/系统默认）"
    );
  } finally {
    await env.close();
  }
});

test("守卫 batch：branch 全本公司 200；混总部箱整单拒 403 且都不落库（不静默过滤）；ADMIN 全范围 200", async () => {
  const env = await tempDb("box-policy-self-batch-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    const branch = await ctxOf(db, "10");
    // 全本公司 [B2,B21] → 200 saved=2
    const ok = await call(controller.batch, {
      ...branch,
      body: { ids: ["B2", "B21"], policy: p(200) },
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.data.saved, 2);
    for (const id of ["B2", "B21"])
      assert.equal(
        JSON.parse(
          (await db.get("SELECT batch_json FROM box_report_policy WHERE box_id=?", [id])).batch_json
        ).reportPeriodSec,
        200
      );
    // 混总部箱 [B2,B1] → 整单拒 403，两台都不落 batch（不静默过滤）
    await db.run("DELETE FROM box_report_policy");
    const mixed = await call(controller.batch, {
      ...branch,
      body: { ids: ["B2", "B1"], policy: p(300) },
    });
    assert.equal(mixed.ok, false);
    assert.equal(mixed.status, 403);
    assert.match(mixed.error, SCOPE_MSG);
    assert.equal(
      await db.get("SELECT batch_json FROM box_report_policy WHERE box_id='B2'"),
      undefined,
      "整单拒：本公司箱也不落库"
    );
    assert.equal(
      await db.get("SELECT batch_json FROM box_report_policy WHERE box_id='B1'"),
      undefined,
      "整单拒：越权箱不落库"
    );
    // 混兄弟公司箱 [B2,B3]（B3 读不可见）→ targets 404（读门先于守卫）
    const mixedSibling = await call(controller.batch, {
      ...branch,
      body: { ids: ["B2", "B3"], policy: p(300) },
    });
    assert.equal(mixedSibling.status, 404);
    // ADMIN 全范围：混各公司 [B2,B1,B3,B13,B0] → 200 saved=5
    const admin = adminCtx(db);
    const adminBatch = await call(controller.batch, {
      ...admin,
      body: { ids: ["B2", "B1", "B3", "B13", "B0"], policy: p(150) },
    });
    assert.equal(adminBatch.ok, true, adminBatch.error);
    assert.equal(adminBatch.data.saved, 5);
    // ADMIN single 他司箱 → 200（全范围不变）
    assert.equal(
      (await call(controller.save, { ...admin, params: { id: "B3" }, body: { policy: p(80) } })).ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("守卫 station admin：本站箱 single/batch 200；总部箱 403；ADMIN 检测站箱不回归", async () => {
  const env = await tempDb("box-policy-self-station-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    const station = await ctxOf(db, "91");
    assert.ok(station.access.perms.has(WRITE), "068 后 station admin 持 policyWrite");
    assert.deepEqual(station.access.scope.manageOrgIds, ["13"], "station manage＝本站");
    // 本站箱 single 200
    assert.equal(
      (await call(controller.save, { ...station, params: { id: "B13" }, body: { policy: p(70) } }))
        .ok,
      true
    );
    // 总部箱（读可见 manage 外）single 403
    const hq = await call(controller.save, {
      ...station,
      params: { id: "B1" },
      body: { policy: p(60) },
    });
    assert.equal(hq.status, 403);
    assert.match(hq.error, SCOPE_MSG);
    // 本公司箱（org2，station 读不可见）→ 404
    assert.equal(
      (await call(controller.save, { ...station, params: { id: "B2" }, body: { policy: p(60) } }))
        .status,
      404
    );
    // batch 本站箱 200（再加一台本站箱）
    await addBox(db, "B13b", "13");
    const okBatch = await call(controller.batch, {
      ...station,
      body: { ids: ["B13", "B13b"], policy: p(75) },
    });
    assert.equal(okBatch.ok, true, okBatch.error);
    assert.equal(okBatch.data.saved, 2);
    // batch 混总部箱整单拒 403
    const mixed = await call(controller.batch, {
      ...station,
      body: { ids: ["B13", "B1"], policy: p(75) },
    });
    assert.equal(mixed.status, 403);
    assert.match(mixed.error, SCOPE_MSG);
  } finally {
    await env.close();
  }
});

test("守卫 无码角色：持 policyRead 无写码 → single/batch require 403「没有这项操作权限」（权限门先于守卫）", async () => {
  const env = await tempDb("box-policy-self-noperm-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    const readonly = await ctxOf(db, "90");
    assert.ok(readonly.access.perms.has(READ), "对照角色持 policyRead");
    assert.ok(!readonly.access.perms.has(WRITE), "068 非目标不补 write");
    assert.ok(!readonly.access.perms.has(BATCH), "068 非目标不补 batch");
    // 本公司箱（读可见 manage 内）但无写码 → require 403（非范围文案）
    const single = await call(controller.save, {
      ...readonly,
      params: { id: "B2" },
      body: { policy: p(60) },
    });
    assert.equal(single.status, 403);
    assert.match(single.error, NO_PERM_MSG);
    const batch = await call(controller.batch, {
      ...readonly,
      body: { ids: ["B2"], policy: p(60) },
    });
    assert.equal(batch.status, 403);
    assert.match(batch.error, NO_PERM_MSG);
    const preview = await call(controller.preview, { ...readonly, body: { ids: ["B2"] } });
    assert.equal(preview.status, 403);
    assert.match(preview.error, NO_PERM_MSG);
  } finally {
    await env.close();
  }
});

test("守卫 手工 scope（读含兄弟公司 manage 外）：single 他司箱 403 范围文案；batch 混他司整单拒 403", async () => {
  const env = await tempDb("box-policy-self-manual-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    // 手工构造读宽于管的 scope：orgIds 含兄弟公司3（读可见），manageOrgIds 仅本公司子树
    const ctx = {
      db,
      user: { id: "10", dept_id: "2", nickname: "分公司管理员" },
      access: {
        roles: ["BRANCH_ADMIN"],
        perms: new Set([READ, WRITE, BATCH, "device:box:list", "device:box:detail"]),
        grantable: new Set(),
        scope: {
          all: false,
          orgIds: ["2", "21", "22", "3"],
          ownerIds: [],
          manageOrgIds: ["2", "21", "22"],
        },
      },
      query: {},
      ip: "127.0.0.1",
    };
    // 兄弟公司箱（org3，读可见 manage 外）single → 守卫 403（区别于真实 resolveAccess 的读不可见 404）
    const single = await call(controller.save, {
      ...ctx,
      params: { id: "B3" },
      body: { policy: p(60) },
    });
    assert.equal(single.status, 403);
    assert.equal(single.code, "A0301");
    assert.match(single.error, SCOPE_MSG);
    // batch 混他司 [B2,B3] → 整单拒 403，都不落库
    const mixed = await call(controller.batch, {
      ...ctx,
      body: { ids: ["B2", "B3"], policy: p(90) },
    });
    assert.equal(mixed.status, 403);
    assert.match(mixed.error, SCOPE_MSG);
    assert.equal(
      await db.get("SELECT batch_json FROM box_report_policy WHERE box_id='B2'"),
      undefined
    );
    assert.equal(
      await db.get("SELECT batch_json FROM box_report_policy WHERE box_id='B3'"),
      undefined
    );
    // 全本公司 batch → 200
    assert.equal(
      (await call(controller.batch, { ...ctx, body: { ids: ["B2", "B21"], policy: p(90) } })).ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("守卫 preview：branch 全本公司 200 返回 total/overridden；混总部箱早拒 403 同文案；ADMIN 全范围 200", async () => {
  const env = await tempDb("box-policy-self-preview-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    const branch = await ctxOf(db, "10");
    const ok = await call(controller.preview, { ...branch, body: { ids: ["B2", "B21"] } });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.data.total, 2);
    assert.deepEqual(ok.data.ids.sort(), ["B2", "B21"]);
    assert.equal(typeof ok.data.overridden, "number");
    // 混总部箱 → 与 batch 同口径早拒 403
    const mixed = await call(controller.preview, { ...branch, body: { ids: ["B2", "B1"] } });
    assert.equal(mixed.status, 403);
    assert.match(mixed.error, SCOPE_MSG);
    // ADMIN 全范围 preview → 200
    const admin = adminCtx(db);
    assert.equal(
      (await call(controller.preview, { ...admin, body: { ids: ["B2", "B1", "B3"] } })).data.total,
      3
    );
  } finally {
    await env.close();
  }
});

test("审计：single/batch 成功记 action/targetType=report-policy/targetId/result=成功（核对现状）", async () => {
  const env = await tempDb("box-policy-self-audit-");
  const { db } = env;
  try {
    await seedGuard(db);
    const { controller } = controllerOf(db);
    const branch = await ctxOf(db, "10");
    await call(controller.save, { ...branch, params: { id: "B2" }, body: { policy: p(120) } });
    await call(controller.batch, { ...branch, body: { ids: ["B2", "B21"], policy: p(200) } });
    const single = await db.get(
      "SELECT * FROM sys_operation_log WHERE action='设置单箱上报策略' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(single, "单箱保存审计存在");
    assert.equal(single.target_type, "report-policy");
    assert.equal(single.target_id, "B2");
    assert.equal(single.result, "成功");
    const batch = await db.get(
      "SELECT * FROM sys_operation_log WHERE action LIKE '批量设置上报策略%' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(batch, "批量保存审计存在");
    assert.equal(batch.target_type, "report-policy");
    assert.equal(batch.result, "成功");
    assert.match(batch.action, /2台/);
    // 越权失败不记审计（整单拒）
    await call(controller.batch, { ...branch, body: { ids: ["B2", "B1"], policy: p(300) } });
    const count = await db.get(
      "SELECT COUNT(*) AS n FROM sys_operation_log WHERE action LIKE '批量设置上报策略%'"
    );
    assert.equal(Number(count.n), 1, "越权整单拒不新增审计");
  } finally {
    await env.close();
  }
});

test("resolveAccess 端到端：068 后含 policyRead 上限部门同补不被交集裁掉；无 policyRead 上限仍裁；全链 save 本公司箱 200", async () => {
  const env = await tempDb("box-policy-self-access-");
  const { db } = env;
  try {
    await addDept(db, "1", "0", "总公司");
    await addDept(db, "2", "1", "华南分公司");
    await addDept(db, "3", "1", "华东分公司");
    await addDept(db, "4", "1", "西北分公司");
    // 部门2/3 开单独限制、上限含 policyRead（068 同补两写码）；部门4 上限不含 policyRead（不动，写码被裁）
    for (const id of ["2", "3", "4"])
      await db.run("UPDATE sys_dept SET perm_limited = 1 WHERE id = ?", [id]);
    for (const perm of [READ, "device:box:list"])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('2',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('3',?)", [READ]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('4','device:box:detail')");
    await addRole(db, "14", "BRANCH_ADMIN", 2);
    await addRolePerm(db, "14", READ, 0);
    await addUser(db, "10", "branch", "2", ["14"]);
    await addUser(db, "11", "branch4", "4", ["14"]);
    await addBox(db, "B2", "2");
    const user10 = await db.get("SELECT * FROM sys_user WHERE id='10'");
    const before = await resolveAccess(db, user10);
    assert.ok(!before.perms.has(WRITE), "068 前 BRANCH_ADMIN 无 write（根因态）");

    await up068(db);
    const after = await resolveAccess(db, user10);
    for (const code of BOX_POLICY_SELF_068) {
      assert.ok(after.rolePerms.has(code), `角色层面已补 ${code}`);
      assert.ok(after.perms.has(code), `含 policyRead 上限部门2 同补 ${code}，不被交集裁掉`);
    }
    // 部门4 上限不含 policyRead → 068 不动该上限；角色虽补，仍被交集裁掉（上限是上界不是授权）
    const user11 = await db.get("SELECT * FROM sys_user WHERE id='11'");
    const cut = await resolveAccess(db, user11);
    for (const code of BOX_POLICY_SELF_068) {
      assert.ok(cut.rolePerms.has(code), `角色层面已补 ${code}`);
      assert.ok(!cut.perms.has(code), `无 policyRead 上限部门仍裁掉 ${code}`);
    }
    // 全链：068 → resolveAccess → save 本公司箱 200
    const { controller } = controllerOf(db);
    const res = await call(controller.save, {
      db,
      user: user10,
      access: after,
      params: { id: "B2" },
      body: { policy: p(110) },
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(
      JSON.parse(
        (await db.get("SELECT single_json FROM box_report_policy WHERE box_id='B2'")).single_json
      ).reportPeriodSec,
      110
    );
  } finally {
    await env.close();
  }
});

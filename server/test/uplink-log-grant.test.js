/**
 * R26 上报记录角色可见性（任务 #85，用户拍板「三角色补码」）＋065 服务端契约：
 * - 065 幂等/三角色补码：BRANCH_ADMIN/STATION_ADMIN/STATION_STAFF 缺 log/logExport 者补
 *   （export 随 read 同补，已有 log 缺 export 只补 export）；grantable 沿该角色现有 max
 *   （无授权行时 0）；ADMIN 短路不落行；其他/自定义角色不动；角色不存在跳过（不建角色）；
 *   _bak_065 双表留底；含事件类码的受限部门上限同补防交集裁掉；重跑不变。
 * - 模板/新种子口径：DEFAULT_ROLE_PERMS.BRANCH_ADMIN 含 log＋logExport 且不连带 raw
 *   （SPLIT_045 会把 log 拆出 raw，后置追加绕开拆分链）；seedRolePerms/ROLE_TEMPLATES 单源同口径；
 *   其他非 ADMIN 模板不借批补 log。
 * - #logPerm（服务端逻辑不改，口径锁定）：补码后 branch 查 timer 200 有记录、默认全部可查、
 *   概览同口径；事件-only 临时角色仍仅事件类（并集默认组合可查）、查 timer/无 kind 被拒 403；
 *   补码前 legacy BRANCH_ADMIN 查 timer 被拒（根因锁定）。
 * - resolveAccess 端到端：065 后 STATION_ADMIN 真实用户 perms 含 log（部门上限同补不被交集裁掉）；
 *   上限不含事件类码的部门仍裁掉（上限是上界不是授权）。
 * 一次性临时库，不碰开发/线上库、不占服务端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_ROLE_PERMS,
  ROLE_TEMPLATES,
  UPLINK_LOG_GRANT_065,
} from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import { SampleController } from "../src/http/SampleController.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { up as up065 } from "../migrations/065_uplink_log_grant.js";

const LOG = "device:box:log";
const LOG_EXPORT = "device:box:logExport";
const RAW_PERM = "device:box:raw";
const EVENT_CODES = ["device:box:event-lid", "device:box:event-boot", "device:box:event-charge"];
/** legacy（#85 前）BRANCH_ADMIN 码集＝现模板去掉两补码（根因态）。 */
const LEGACY_BRANCH = DEFAULT_ROLE_PERMS.BRANCH_ADMIN.filter(
  (code) => !UPLINK_LOG_GRANT_065.includes(code)
);

async function tempDb(prefix) {
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

test("065：三角色补码/export 随 read/grantable 沿现有 max/ADMIN 短路/自定义不动/部门上限同补/留底；重跑幂等", async () => {
  const env = await tempDb("uplink-grant-065-");
  const { db } = env;
  try {
    // legacy 现状：BRANCH_ADMIN 缺两码（种子态 grantable=1）；STATION_ADMIN 已有 log 缺 export
    //（list 行 grantable=1、其余 0 → max=1）；STATION_STAFF 缺两码且全 0；ADMIN/CUSTOM 对照。
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await addRole(db, "92", "STATION_STAFF", 3);
    await addRole(db, "1", "ADMIN", 1);
    await addRole(db, "90", "CUSTOM");
    for (const perm of LEGACY_BRANCH) await addRolePerm(db, "14", perm, 1);
    for (const perm of ["device:box:list", "device:box:detail", ...EVENT_CODES])
      await addRolePerm(db, "91", perm, perm === "device:box:list" ? 1 : 0);
    await addRolePerm(db, "91", LOG, 0); // 已有 log（grantable=0），缺 export
    for (const perm of ["device:box:list", "device:box:detail", "device:box:event-lid"])
      await addRolePerm(db, "92", perm, 0);
    await addRolePerm(db, "1", "sys:role:view", 1);
    for (const perm of EVENT_CODES) await addRolePerm(db, "90", perm, 0);
    // 受限部门上限：21 含事件类码（同补）；22 含事件码且已有 log（只补 export）；13 无事件码（不动）
    for (const perm of ["device:box:list", "device:box:event-lid", "device:box:event-boot"])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('21',?)", [perm]);
    for (const perm of ["device:box:event-charge", LOG])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('22',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('13','device:box:detail')");
    // 清掉 migrate 期（空角色）留下的 065 备份，让本次 up 的备份捕获 legacy 现状
    await db.run("DROP TABLE IF EXISTS _bak_065_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_065_sys_dept_perm");

    const snapshot = async () => ({
      role: await db.all(
        "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
      ),
      dept: await db.all("SELECT dept_id, perm FROM sys_dept_perm ORDER BY dept_id, perm"),
      roles: await db.all("SELECT id, code FROM sys_role ORDER BY id"),
    });
    await up065(db);
    const after1 = await snapshot();
    const permsOf = (roleId) =>
      new Set(after1.role.filter((r) => r.role_id === roleId).map((r) => r.perm));
    const flagOf = (roleId, perm) =>
      Number(after1.role.find((r) => r.role_id === roleId && r.perm === perm)?.grantable);

    // BRANCH_ADMIN：两码都补，grantable 沿现有 max=1
    for (const code of UPLINK_LOG_GRANT_065) {
      assert.ok(permsOf("14").has(code), `BRANCH_ADMIN 应补 ${code}`);
      assert.equal(flagOf("14", code), 1, "BRANCH_ADMIN 补码 grantable 沿现有 max=1");
    }
    // STATION_ADMIN：export 随 read——已有 log 不动（grantable 保持 0），只补 export（max=1）
    assert.ok(permsOf("91").has(LOG_EXPORT), "STATION_ADMIN 缺 export 应补");
    assert.equal(flagOf("91", LOG_EXPORT), 1, "STATION_ADMIN 补码沿现有 max=1");
    assert.equal(flagOf("91", LOG), 0, "已有 log 行不改（只补不删不改）");
    // STATION_STAFF：两码都补，全 0 角色 grantable=0（不借补码扩转授面）
    for (const code of UPLINK_LOG_GRANT_065) {
      assert.ok(permsOf("92").has(code), `STATION_STAFF 应补 ${code}`);
      assert.equal(flagOf("92", code), 0, "STATION_STAFF 补码 grantable=0");
    }
    // ADMIN 短路不落行；自定义角色（含事件码）不动
    assert.deepEqual(
      after1.role.filter((r) => r.role_id === "1").map((r) => r.perm),
      ["sys:role:view"],
      "ADMIN 不落行"
    );
    assert.deepEqual(
      after1.role
        .filter((r) => r.role_id === "90")
        .map((r) => r.perm)
        .sort(),
      [...EVENT_CODES].sort(),
      "自定义角色不动"
    );
    // 部门上限：21 同补两码；22 只补 export；13 无事件码不动
    const deptPerms = (id) =>
      new Set(after1.dept.filter((d) => d.dept_id === id).map((d) => d.perm));
    for (const code of UPLINK_LOG_GRANT_065)
      assert.ok(deptPerms("21").has(code), `部门21上限应补 ${code}`);
    assert.ok(deptPerms("22").has(LOG_EXPORT), "部门22上限已有 log 只补 export");
    assert.deepEqual([...deptPerms("13")], ["device:box:detail"], "无事件类码的部门上限不动");
    // 备份留底＝legacy 现状（BRANCH_ADMIN 不含 log；部门21 不含 log）
    const bakRole = await db.all("SELECT perm FROM _bak_065_sys_role_perm WHERE role_id='14'");
    assert.ok(!bakRole.some((r) => r.perm === LOG), "角色备份应为补码前现状");
    const bakDept = await db.all("SELECT perm FROM _bak_065_sys_dept_perm WHERE dept_id='21'");
    assert.ok(!bakDept.some((r) => r.perm === LOG), "部门备份应为补码前现状");
    // 重跑幂等：结果完全不变（含角色本体行数）
    await up065(db);
    assert.deepEqual(await snapshot(), after1, "065 重跑结果应不变");
  } finally {
    await env.close();
  }
});

test("065：角色不存在跳过（不建角色）；无授权行的目标角色补码 grantable=0；无 sys_role 的老库直接返回", async () => {
  const env = await tempDb("uplink-grant-065-missing-");
  const { db } = env;
  try {
    // 只有 BRANCH_ADMIN（无任何授权行）＋ADMIN；STATION_ADMIN/STATION_STAFF 不存在
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "1", "ADMIN", 1);
    await addRolePerm(db, "1", "sys:role:view", 1);
    await up065(db);
    const rows = await db.all(
      "SELECT perm, grantable FROM sys_role_perm WHERE role_id='14' ORDER BY perm"
    );
    assert.deepEqual(
      rows.map((r) => [r.perm, Number(r.grantable)]),
      [LOG, LOG_EXPORT].sort().map((code) => [code, 0]),
      "无授权行的 BRANCH_ADMIN 补两码且 grantable=0"
    );
    const roles = await db.all("SELECT code FROM sys_role ORDER BY id");
    assert.deepEqual(
      roles.map((r) => r.code),
      ["ADMIN", "BRANCH_ADMIN"],
      "不存在的 STATION_* 角色不新建"
    );
    // 老库没有 sys_role 表：按 045/062/063 先例直接返回，不抛错、不再动权限行
    const before = await db.all(
      "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
    );
    await db.run("DROP TABLE sys_role");
    await up065(db);
    assert.deepEqual(
      await db.all("SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"),
      before,
      "无 sys_role 时直接返回，权限行不变"
    );
  } finally {
    await env.close();
  }
});

test("模板/新种子：BRANCH_ADMIN 含 log＋logExport 不连带 raw；seedRolePerms/ROLE_TEMPLATES 单源；其他模板不借批补 log", async () => {
  // 模板口径（升级链后置追加，绕开 SPLIT_045 的 log→raw 连带）
  const branch = DEFAULT_ROLE_PERMS.BRANCH_ADMIN;
  for (const code of UPLINK_LOG_GRANT_065) assert.ok(branch.includes(code), `模板应含 ${code}`);
  assert.ok(!branch.includes(RAW_PERM), "模板补 log 不连带 raw（超出拍板口径）");
  assert.equal(new Set(branch).size, branch.length, "模板码集无重复");
  const template = ROLE_TEMPLATES.find((t) => t.key === "BRANCH_ADMIN");
  for (const code of UPLINK_LOG_GRANT_065)
    assert.ok(template.codes.includes(code), "ROLE_TEMPLATES 单源随模板");
  for (const key of ["SAMPLER", "DUTY", "VERIFY", "LEADER", "DISPATCH"])
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes(LOG), `${key} 模板不借批补 log`);

  // 新库种子：BRANCH_ADMIN 走模板（grantable=1，grantsAll）；DB-only 的 STATION_ADMIN 无模板
  // 默认值（seedRolePerms 跳过），由 065 补码——生产路径＝先有角色行再跑迁移。
  const env = await tempDb("uplink-grant-seed-");
  const { db } = env;
  try {
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await seedRolePerms(db);
    const seeded = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id='14'");
    const have = new Set(seeded.map((r) => r.perm));
    for (const code of UPLINK_LOG_GRANT_065)
      assert.ok(have.has(code), `新库 BRANCH_ADMIN 应含 ${code}`);
    assert.ok(!have.has(RAW_PERM), "新库种子不连带 raw");
    for (const row of seeded.filter((r) => UPLINK_LOG_GRANT_065.includes(r.perm)))
      assert.equal(Number(row.grantable), 1, "种子 grantable=1（grantsAll）");
    assert.equal(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).length,
      0,
      "DB-only 角色无模板默认值（seedRolePerms 跳过）"
    );
    await up065(db);
    const station = new Set(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).map((r) => r.perm)
    );
    for (const code of UPLINK_LOG_GRANT_065)
      assert.ok(station.has(code), `065 应给 DB-only 角色补 ${code}`);
  } finally {
    await env.close();
  }
});

/* ── #logPerm 口径（服务端逻辑不改）：补码后 branch 可见定时；事件-only 仍仅事件类 ── */

const BOX_ID = "864317080992517";
const RAW = gzipSync(Buffer.from('{"uart":"why=timer,aa55=0"}'));
const BASE = Date.parse("2026-11-20T10:00:00");
const at = (sec) => formatTimestamp(new Date(BASE + sec * 1000));
const WINDOW = { from: "2026-11-20 00:00:00", to: "2026-11-21 00:00:00" };

/** 箱子当前行：PRAGMA 驱动补 NOT NULL 默认值（uplink-records.test.js 先例）。 */
async function insertBox(db, extra = {}) {
  const info = await db.all("PRAGMA table_info(sample_box)");
  const vals = {
    id: BOX_ID,
    imei: BOX_ID,
    name: BOX_ID,
    org: "总公司",
    life: "在途",
    last_report_at: at(0),
    bound_task_id: "",
    bound_task_at: "",
    activate_step: "等待激活",
    ...extra,
  };
  const cols = [];
  const params = [];
  for (const col of info) {
    if (col.name in vals) {
      cols.push(col.name);
      params.push(vals[col.name]);
    } else if (col.notnull === 1 && col.dflt_value == null && col.pk === 0) {
      cols.push(col.name);
      params.push(/int|real|num/i.test(col.type) ? 0 : "");
    }
  }
  await db.run(
    `INSERT INTO sample_box (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    params
  );
}

async function insertUplink(db, sec, kind, mv = 3800) {
  const label = { timer: "定时上报", pad: "开箱上报" }[kind] || "设备上报";
  await db.run(
    "INSERT INTO sample_uplink (box_id, imei, received_at, device_time, kind, summary, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      BOX_ID,
      BOX_ID,
      at(sec),
      at(sec),
      kind,
      `${label} · seq ${sec} · ${(mv / 1000).toFixed(2)} V`,
      RAW,
    ]
  );
}

function makeCtx(query = {}, access = null) {
  return {
    query,
    params: { id: BOX_ID },
    access,
    ok(data) {
      this.data = data;
    },
    fail(msg, code = "A0001", status = 200) {
      this.error = { msg, code, status };
    },
  };
}

test("#logPerm：补码后 branch 查 timer 200 有记录＋概览同口径＋默认全部可查；legacy branch 查 timer 被拒（根因锁定）", async () => {
  const env = await tempDb("uplink-grant-logperm-");
  const { db } = env;
  try {
    const store = new SqlBoxStore(db);
    await insertBox(db);
    // 仅定时报文的箱子（诊断形态：采样箱_00000002）＋一条开箱对照
    for (const sec of [1, 2, 3]) await insertUplink(db, sec, "timer");
    await insertUplink(db, 4, "pad");
    const controller = new SampleController(store);
    const branch = { perms: new Set(DEFAULT_ROLE_PERMS.BRANCH_ADMIN), scope: { all: true } };

    const timer = makeCtx({ ...WINDOW, kind: "timer" }, branch);
    await controller.logs(timer);
    assert.ok(!timer.error, timer.error?.msg);
    assert.equal(timer.data.list.length, 3, "补码后 branch 查 timer 有记录");
    assert.ok(timer.data.list.every((r) => r.kind === "timer"));

    const timerSum = makeCtx({ ...WINDOW, kind: "timer" }, branch);
    await controller.uplinkSummary(timerSum);
    assert.ok(!timerSum.error, timerSum.error?.msg);
    assert.equal(timerSum.data.total, 3, "概览与列表同口径");
    assert.deepEqual(timerSum.data.kinds, { timer: 3 });

    // 默认全部（web #85 默认口径）：持 log 角色无 kind 查全量
    const all = makeCtx({ ...WINDOW }, branch);
    await controller.logs(all);
    assert.ok(!all.error, all.error?.msg);
    assert.equal(all.data.list.length, 4);
    const allSum = makeCtx({ ...WINDOW }, branch);
    await controller.uplinkSummary(allSum);
    assert.equal(allSum.data.total, 4);
    assert.deepEqual(allSum.data.kinds, { timer: 3, pad: 1 });

    // 根因锁定：补码前 legacy BRANCH_ADMIN（事件-only）查 timer 被拒、查开箱仍放行
    const legacy = { perms: new Set(LEGACY_BRANCH), scope: { all: true } };
    const legacyTimer = makeCtx({ ...WINDOW, kind: "timer" }, legacy);
    await controller.logs(legacyTimer);
    assert.equal(legacyTimer.error?.code, "A0301");
    assert.equal(legacyTimer.error?.status, 403);
    const legacyPad = makeCtx({ ...WINDOW, kind: "pad" }, legacy);
    await controller.logs(legacyPad);
    assert.ok(!legacyPad.error, "legacy branch 持事件码查开箱仍放行");
    assert.equal(legacyPad.data.list.length, 1);
    await store.flush();
  } finally {
    await env.close();
  }
});

test("#logPerm：事件-only 临时角色仍仅事件类——并集默认可查、timer/无 kind/混 kind 被拒", async () => {
  const env = await tempDb("uplink-grant-eventonly-");
  const { db } = env;
  try {
    const store = new SqlBoxStore(db);
    await insertBox(db);
    for (const sec of [1, 2, 3]) await insertUplink(db, sec, "timer");
    await insertUplink(db, 4, "pad");
    const controller = new SampleController(store);
    const eventOnly = {
      perms: new Set(["device:box:list", "device:box:detail", ...EVENT_CODES]),
      scope: { all: true },
    };

    // web #85 事件-only 默认口径＝持码事件种类并集（逗号列表）：#logPerm 认全事件类组合
    const union = makeCtx({ ...WINDOW, kind: "pad,shut,boot,chg" }, eventOnly);
    await controller.logs(union);
    assert.ok(!union.error, union.error?.msg);
    assert.equal(union.data.list.length, 1, "并集查询只回事件行（timer 不在其中）");
    assert.equal(union.data.list[0].kind, "pad");
    const unionSum = makeCtx({ ...WINDOW, kind: "pad,shut,boot,chg" }, eventOnly);
    await controller.uplinkSummary(unionSum);
    assert.ok(!unionSum.error, unionSum.error?.msg);
    assert.equal(unionSum.data.total, 1);
    assert.deepEqual(unionSum.data.kinds, { pad: 1 });

    // 单事件种类仍放行
    const pad = makeCtx({ ...WINDOW, kind: "pad" }, eventOnly);
    await controller.logs(pad);
    assert.ok(!pad.error, pad.error?.msg);
    assert.equal(pad.data.list.length, 1);

    // timer / 无 kind（全部）/ 混 kind 都要 log 码 → 403
    for (const query of [{ kind: "timer" }, {}, { kind: "timer,pad" }]) {
      const denied = makeCtx({ ...WINDOW, ...query }, eventOnly);
      await controller.logs(denied);
      assert.equal(denied.error?.code, "A0301", `kind=${query.kind ?? "(无)"} 应拒`);
      assert.equal(denied.error?.status, 403);
      const deniedSum = makeCtx({ ...WINDOW, ...query }, eventOnly);
      await controller.uplinkSummary(deniedSum);
      assert.equal(deniedSum.error?.status, 403, "概览同口径拒绝");
    }
    await store.flush();
  } finally {
    await env.close();
  }
});

test("resolveAccess 端到端：065 后 STATION_ADMIN 真实用户 perms 含 log（事件类部门上限同补不裁）；无事件码上限部门仍裁掉", async () => {
  const env = await tempDb("uplink-grant-access-");
  const { db } = env;
  try {
    // 部门 2＝开了单独限制、上限含事件类码（事件-only 角色部门形态）；部门 3＝上限仅 detail（无事件码）
    for (const [id, name] of [
      ["2", "华南分公司"],
      ["3", "华东分公司"],
    ])
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type,perm_limited) VALUES (?,?,?, ?,1,1,'公司',1)",
        [id, "0", name, `C${id}`]
      );
    for (const perm of ["device:box:list", "device:box:detail", ...EVENT_CODES])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('2',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('3','device:box:detail')");
    await addRole(db, "91", "STATION_ADMIN", 1);
    await addRole(db, "92", "STATION_STAFF", 1);
    for (const perm of ["device:box:list", "device:box:detail", ...EVENT_CODES]) {
      await addRolePerm(db, "91", perm, 0);
      await addRolePerm(db, "92", perm, 0);
    }
    for (const [id, deptId, roleId] of [
      ["91", "2", "91"],
      ["92", "3", "92"],
    ]) {
      await db.run(
        "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
        [id, `u${id}`, `站点${id}`, deptId]
      );
      await db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES (?,?)", [id, roleId]);
    }
    const user91 = await db.get("SELECT * FROM sys_user WHERE id='91'");
    const user92 = await db.get("SELECT * FROM sys_user WHERE id='92'");
    const before = await resolveAccess(db, user91);
    assert.ok(!before.perms.has(LOG), "065 前 STATION_ADMIN 无 log（根因态）");

    await up065(db);
    const after = await resolveAccess(db, user91);
    assert.ok(after.perms.has(LOG), "065 后 STATION_ADMIN perms 含 log");
    assert.ok(after.perms.has(LOG_EXPORT), "export 随 read 同补");
    // 部门 3 上限无事件类码 → 065 不动该上限；STATION_STAFF 角色虽补了 log，仍被交集裁掉
    const staff = await resolveAccess(db, user92);
    assert.ok(staff.rolePerms.has(LOG), "角色层面已补 log");
    assert.ok(!staff.perms.has(LOG), "上限是上界不是授权：无事件码部门仍裁掉 log");

    // 全链：065 → resolveAccess → #logPerm → 仅定时报文箱查 timer 200 有记录
    const store = new SqlBoxStore(db);
    await insertBox(db);
    for (const sec of [1, 2]) await insertUplink(db, sec, "timer");
    const controller = new SampleController(store);
    const ctx = makeCtx({ ...WINDOW, kind: "timer" }, { perms: after.perms, scope: after.scope });
    await controller.logs(ctx);
    assert.ok(!ctx.error, ctx.error?.msg);
    assert.equal(ctx.data.list.length, 2, "迁移补码后真实 access 查 timer 200 有记录");
    await store.flush();
  } finally {
    await env.close();
  }
});

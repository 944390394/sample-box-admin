/**
 * 任务 #94：操作日志对象可读化（targetName）读模型单测。
 * 覆盖：四类解析（人员 nickname||username／部门 name／箱子 boxNameCell 脱敏／任务单号+name，含 AL- 划拨）、
 * scope 外回退「类型 #id」、已删除回退、箱子无 identity 码打码（含回退串）、actor 仅本人范围、
 * list/export 同口径、CSV 对象名称列 additive＋防注入、批量 lookup 无 N+1（每类型单条 IN，大表分批）、
 * 设置类/空编号/未知类型口径、additive 不破坏旧字段（targetId 打码照旧）。
 * 跑法：node --test server/test/oplog-target-name.test.js（全量 npm run test:server）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { identityGranted, maskImei, resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { queryOperationLogs, queryOperationLogsForExport } from "../src/log/operationLog.js";
import { csvCell, operationLogsExport } from "../src/log/operationLogExport.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oplog-target-"));
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

async function person(db, id, username, nickname, deptId, roleIds) {
  await db.run(
    "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES (?, ?, ?, 'x', ?, 1)",
    [id, username, nickname, deptId]
  );
  for (const roleId of roleIds)
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, roleId]);
  return db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
}

async function box(db, id, name, orgId, ownerId = "") {
  await db.run(
    `INSERT INTO sample_box (id, imei, name, org, org_id, owner_id, life, activate_step)
     VALUES (?, ?, ?, ?, ?, ?, '未使用', '已确认')`,
    [id, id, name, `单位${orgId}`, orgId, ownerId]
  );
}

async function task(db, id, name, kind, fromOrgId, toOrgId, body = {}) {
  await db.run(
    `INSERT INTO sample_task (id, name, kind, status, body, from_org_id, to_org_id, created_at)
     VALUES (?, ?, ?, '待检测', ?, ?, ?, '2026-10-15 08:00:00.000')`,
    [id, name, kind, JSON.stringify(body), fromOrgId, toOrgId]
  );
}

async function log(db, orgId, actorId, action, targetType, targetId, detail = "") {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, '成功', ?, '2026-10-15 09:00:00.000', '10.0.0.1')`,
    [orgId, `单位${orgId}`, actorId, `操作者${actorId}`, action, targetType, targetId, detail]
  );
}

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const IMEI_NAMED = "861234567890101";
const IMEI_UNNAMED = "861234567890102";
const IMEI_FOREIGN = "861234567890103";
const IMEI_OWNED = "861234567890104";

/** branch（12 BRANCH_ADMIN 挂 2，manage=[2,21]、orgIds 含祖先 1）＋ admin ＋ sampler（仅本人）三视角。 */
async function scenario(db) {
  const branch = await person(db, "9103", "accept.branch", "验收分公司管理员", "2", ["12"]);
  const plain = await person(db, "30", "test.user", "", "2", ["15"]);
  const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
  const sampler = await db.get("SELECT * FROM sys_user WHERE username = 'lin.xia'");
  await box(db, IMEI_NAMED, "南山01号", "21");
  await box(db, IMEI_UNNAMED, "", "2");
  await box(db, IMEI_FOREIGN, "范围外箱", "3");
  await box(db, IMEI_OWNED, "保管箱", "3", "7");
  await task(db, "TK-9401-0001", "采样送检第1批", "采样后送检", "2", "13");
  await task(db, "TK-9401-OUT", "范围外任务", "采样后送检", "3", "13");
  await task(db, "TK-9401-BODY", "采样单位单", "采样", "", "", { orgId: "2" });
  await task(db, "AL-9401-0001", "划拨现场组", "划拨", "2", "21");
  const perms = {};
  for (const [key, user] of Object.entries({ branch, admin, sampler }))
    perms[key] = (await resolveAccess(db, user)).perms;
  return { branch, plain, admin, sampler, perms };
}

/** mock ctx 直调导出处理器，download 收全 CSV 文本。 */
async function invokeExport(db, user, perms, query = {}) {
  let result;
  await operationLogsExport({
    db,
    user,
    query,
    access: { perms },
    ip: "10.0.0.9",
    ok: (data) => {
      result = { ok: true, data };
    },
    fail: (message, code, status) => {
      result = { ok: false, message, code, status };
    },
    download: async (filename, chunks, headers) => {
      let text = "";
      for await (const chunk of chunks) text += chunk;
      result = { ok: true, filename, text, headers };
    },
  });
  return result;
}

/** 按类型+编号找行：无 identity 视角的 targetId 已打码，两种形态都认。 */
const byTarget = (list, targetType, targetId) =>
  list.find(
    (i) =>
      i.targetType === targetType &&
      (String(i.targetId) === String(targetId) || String(i.targetId) === maskImei(targetId))
  );

test("四类对象解析：人员 nickname||username、部门 name、箱子箱名、任务单号+name（TK/AL）", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    await log(db, "2", "9103", "修改用户", "user", "7"); // 林夏（seed nickname）
    await log(db, "2", "9103", "修改用户", "user", "30"); // nickname 空 → username
    await log(db, "2", "9103", "修改部门", "dept", "21");
    await log(db, "2", "9103", "分配采样箱", "box", IMEI_NAMED);
    await log(db, "2", "9103", "创建任务单", "report-policy", "TK-9401-0001");
    await log(db, "2", "9103", "提交划拨", "report-policy", "AL-9401-0001");
    const page = await queryOperationLogs(db, s.admin, { ...RANGE, limit: 100 }, s.perms.admin);
    assert.equal(byTarget(page.list, "user", "7").targetName, "林夏");
    assert.equal(byTarget(page.list, "user", "30").targetName, "test.user");
    assert.equal(byTarget(page.list, "dept", "21").targetName, "调度室");
    assert.equal(byTarget(page.list, "box", IMEI_NAMED).targetName, "南山01号");
    assert.equal(
      byTarget(page.list, "report-policy", "TK-9401-0001").targetName,
      "TK-9401-0001 采样送检第1批"
    );
    assert.equal(
      byTarget(page.list, "report-policy", "AL-9401-0001").targetName,
      "AL-9401-0001 划拨现场组"
    );
    assert.ok(
      page.list.every((i) => i.targetResolved === true),
      "本场景全在 admin 范围内应全解析"
    );
    // additive：旧字段一个不动
    const item = byTarget(page.list, "box", IMEI_NAMED);
    assert.equal(item.targetId, IMEI_NAMED);
    assert.equal(item.action, "分配采样箱");
    assert.equal(item.orgId, "2");
  } finally {
    await env.close();
  }
});

test("scope 外回退「类型 #id」：branch 见兄弟单位人/部门/箱/任务只给回退，不泄名", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    await log(db, "2", "9103", "修改用户", "user", "5"); // 吴迪 dept 13 ∉ manage[2,21]
    await log(db, "2", "9103", "修改部门", "dept", "3"); // 华东分公司 ∉ manage
    await log(db, "2", "9103", "分配采样箱", "box", IMEI_FOREIGN); // org 3 ∉ orgIds
    await log(db, "21", "6", "任务单推进到「已签收」", "report-policy", "TK-9401-OUT");
    await log(db, "2", "9103", "修改用户", "user", "7"); // 范围内对照
    await log(db, "2", "9103", "修改部门", "dept", "21");
    const page = await queryOperationLogs(db, s.branch, { ...RANGE, limit: 100 }, s.perms.branch);
    const u = byTarget(page.list, "user", "5");
    assert.equal(u.targetName, "人员 #5");
    assert.equal(u.targetResolved, false);
    assert.equal(byTarget(page.list, "dept", "3").targetName, "部门 #3");
    assert.equal(
      byTarget(page.list, "box", IMEI_FOREIGN).targetName,
      `采样箱 #${maskImei(IMEI_FOREIGN)}`
    );
    assert.equal(
      byTarget(page.list, "report-policy", "TK-9401-OUT").targetName,
      "任务单 #TK-9401-OUT"
    );
    assert.equal(byTarget(page.list, "user", "7").targetName, "林夏", "范围内照常解析");
    assert.equal(byTarget(page.list, "dept", "21").targetName, "调度室");
    assert.ok(
      !JSON.stringify(page.list).includes("吴迪") && !JSON.stringify(page.list).includes("范围外箱")
    );
    // 祖先单位箱（orgIds 含祖先）与 body.orgId 参与方单：调度员（挂 21，祖先 2）可解析箱，
    // 但管人范围只有 21——祖先单位的人仍回退（下级管不了上级）
    const dispatch = await person(db, "9106", "accept.dispatch", "验收调度员", "21", ["13"]);
    const dispatchPerms = (await resolveAccess(db, dispatch)).perms;
    await box(db, "861234567890105", "分公司箱", "2");
    await log(db, "21", "6", "分配采样箱", "box", "861234567890105");
    await log(db, "21", "6", "创建任务单", "report-policy", "TK-9401-BODY");
    await log(db, "21", "6", "修改用户", "user", "7");
    const page2 = await queryOperationLogs(db, dispatch, { ...RANGE, limit: 100 }, dispatchPerms);
    assert.equal(byTarget(page2.list, "box", "861234567890105").targetName, "分公司箱");
    assert.equal(
      byTarget(page2.list, "report-policy", "TK-9401-BODY").targetName,
      "TK-9401-BODY 采样单位单"
    );
    assert.equal(
      byTarget(page2.list, "user", "7").targetName,
      "人员 #7",
      "祖先单位的人不在管人范围"
    );
  } finally {
    await env.close();
  }
});

test("已删除/未知类型回退；设置类与空编号给类型文案（resolved=true）；role 本批不解析", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    await log(db, "2", "9103", "删除用户", "user", "999"); // 不存在
    await log(db, "2", "9103", "分配采样箱", "box", "861234567890999"); // 已删除箱
    await log(db, "2", "9103", "分配角色权限", "role", "12");
    await log(db, "2", "9103", "修改显示名称", "branding", "");
    await log(db, "2", "9103", "修改公司策略", "company-policy", "");
    await log(db, "2", "9103", "登录", "user", ""); // 失败登录空编号形态
    await log(db, "2", "9103", "操作", "widget", "5"); // 未知类型
    const page = await queryOperationLogs(db, s.admin, { ...RANGE, limit: 100 }, s.perms.admin);
    const deleted = byTarget(page.list, "user", "999");
    assert.equal(deleted.targetName, "人员 #999");
    assert.equal(deleted.targetResolved, false);
    assert.equal(
      byTarget(page.list, "box", "861234567890999").targetName,
      "采样箱 #861234567890999"
    );
    assert.equal(byTarget(page.list, "role", "12").targetName, "角色 #12");
    assert.equal(byTarget(page.list, "role", "12").targetResolved, false);
    const branding = byTarget(page.list, "branding", "");
    assert.equal(branding.targetName, "系统名称和图标");
    assert.equal(branding.targetResolved, true);
    assert.equal(byTarget(page.list, "company-policy", "").targetName, "公司策略");
    const emptyLogin = page.list.find((i) => i.action === "登录");
    assert.equal(emptyLogin.targetName, "人员");
    assert.equal(emptyLogin.targetResolved, true);
    assert.equal(byTarget(page.list, "widget", "5").targetName, "widget #5");
  } finally {
    await env.close();
  }
});

test("箱子脱敏：无 identity 码未起名箱给打码名、回退串也打码；有码见整串；真名不受脱敏影响", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    assert.ok(!identityGranted(s.perms.branch), "branch 模板无设备标识三项");
    assert.ok(identityGranted(s.perms.admin));
    await log(db, "2", "9103", "采样箱改名", "box", IMEI_UNNAMED);
    await log(db, "2", "9103", "分配采样箱", "box", IMEI_NAMED);
    await log(db, "2", "9103", "分配采样箱", "box", "861234567890999"); // 删除箱回退
    const branchPage = await queryOperationLogs(
      db,
      s.branch,
      { ...RANGE, limit: 100 },
      s.perms.branch
    );
    assert.equal(byTarget(branchPage.list, "box", IMEI_UNNAMED).targetName, maskImei(IMEI_UNNAMED));
    assert.equal(
      byTarget(branchPage.list, "box", IMEI_NAMED).targetName,
      "南山01号",
      "真起名箱名不是标识，照给"
    );
    assert.equal(
      byTarget(branchPage.list, "box", "861234567890999").targetName,
      `采样箱 #${maskImei("861234567890999")}`
    );
    assert.ok(!JSON.stringify(branchPage.list).includes(IMEI_UNNAMED), "整串一个字不出现");
    const adminPage = await queryOperationLogs(
      db,
      s.admin,
      { ...RANGE, limit: 100 },
      s.perms.admin
    );
    assert.equal(byTarget(adminPage.list, "box", IMEI_UNNAMED).targetName, IMEI_UNNAMED);
    // perms=null 内部调用不打码（沿用 #26 B-01 口径）
    const internal = await queryOperationLogs(db, s.branch, { ...RANGE, limit: 100 });
    assert.equal(byTarget(internal.list, "box", IMEI_UNNAMED).targetName, IMEI_UNNAMED);
  } finally {
    await env.close();
  }
});

test("仅本人范围（sampler）：本人/自己保管的箱解析，其余回退", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    await log(db, "2", "7", "登录", "user", "7");
    await log(db, "2", "7", "修改用户", "user", "6"); // 他人
    await log(db, "2", "7", "分配采样箱", "box", IMEI_OWNED); // 保管人=7
    await log(db, "2", "7", "分配采样箱", "box", IMEI_NAMED); // 他人单位箱
    await log(db, "2", "7", "创建任务单", "report-policy", "TK-9401-0001");
    const page = await queryOperationLogs(db, s.sampler, { ...RANGE, limit: 100 }, s.perms.sampler);
    assert.equal(byTarget(page.list, "user", "7").targetName, "林夏");
    assert.equal(byTarget(page.list, "user", "6").targetName, "人员 #6");
    assert.equal(byTarget(page.list, "box", IMEI_OWNED).targetName, "保管箱");
    assert.equal(
      byTarget(page.list, "box", IMEI_NAMED).targetName,
      `采样箱 #${maskImei(IMEI_NAMED)}`
    );
    assert.equal(
      byTarget(page.list, "report-policy", "TK-9401-0001").targetName,
      "任务单 #TK-9401-0001"
    );
  } finally {
    await env.close();
  }
});

test("list/export 同口径＋CSV 对象名称列 additive＋防注入沿 csvCell", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    await person(db, "31", "evil.user", '=HYPERLINK("http://evil")', "2", ["15"]);
    await person(db, "32", "comma.user", "名,带逗号", "2", ["15"]);
    await log(db, "2", "9103", "修改用户", "user", "7");
    await log(db, "2", "9103", "修改用户", "user", "31");
    await log(db, "2", "9103", "修改用户", "user", "32");
    await log(db, "2", "9103", "创建任务单", "report-policy", "TK-9401-0001");
    await log(db, "2", "9103", "采样箱改名", "box", IMEI_UNNAMED);
    await log(db, "2", "9103", "修改用户", "user", "5"); // branch 范围外
    const page = await queryOperationLogs(db, s.branch, { ...RANGE, limit: 100 }, s.perms.branch);
    const out = await invokeExport(db, s.branch, s.perms.branch, RANGE);
    assert.ok(out.ok, out.message);
    const lines = out.text.split("\r\n").filter(Boolean);
    assert.ok(lines[0].includes("对象类型,对象编号,对象名称,结果"), "additive 列在编号后");
    assert.ok(lines[0].includes("对象编号"), "编号列保留供追溯");
    // 逐行同口径：CSV 对象名称格 == list targetName（csvCell 同规约转义）
    for (const item of page.list) {
      const line = lines.find(
        (l) =>
          l.includes(`,${item.targetType},${item.targetId},`) ||
          l.includes(`,${item.targetType},"${item.targetId}",`)
      );
      assert.ok(line, `导出要有 ${item.targetType}/${item.targetId} 行`);
      assert.ok(line.includes(csvCell(item.targetName)), `对象名称同口径：${item.targetName}`);
    }
    assert.ok(out.text.includes("'=HYPERLINK"), "公式昵称加单引号前缀");
    assert.ok(out.text.includes('"名,带逗号"'), "逗号昵称双引号转义");
    assert.ok(out.text.includes(maskImei(IMEI_UNNAMED)) && !out.text.includes(IMEI_UNNAMED));
    assert.ok(out.text.includes("人员 #5") && !out.text.includes("吴迪"));
    // admin 对照：整串与范围外名都见
    const adminOut = await invokeExport(db, s.admin, s.perms.admin, RANGE);
    assert.ok(adminOut.text.includes(IMEI_UNNAMED) && adminOut.text.includes("吴迪"));
  } finally {
    await env.close();
  }
});

test("批量 lookup 无 N+1：30 行同类型单条 IN；混合页 ≤4 条；导出 850 对象按 800/批=2 条", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    const calls = [];
    const counted = Object.create(db);
    counted.all = async (sql, params) => {
      calls.push(sql);
      return db.all(sql, params);
    };
    const lookups = () =>
      calls.filter((sql) =>
        /FROM (sys_user|sys_dept|sample_box|sample_task) WHERE id IN/.test(sql)
      );
    for (let i = 0; i < 30; i++) await log(db, "2", "9103", "修改用户", "user", "7");
    calls.length = 0;
    const page = await queryOperationLogs(counted, s.admin, { ...RANGE, limit: 40 }, s.perms.admin);
    assert.equal(page.list.length, 30);
    assert.equal(lookups().length, 1, "30 行同类型只一条 IN 查询");
    assert.match(lookups()[0], /FROM sys_user WHERE id IN/);
    // 混合四类：每类型各一条
    await log(db, "2", "9103", "修改部门", "dept", "21");
    await log(db, "2", "9103", "分配采样箱", "box", IMEI_NAMED);
    await log(db, "2", "9103", "创建任务单", "report-policy", "TK-9401-0001");
    calls.length = 0;
    await queryOperationLogs(counted, s.admin, { ...RANGE, limit: 40 }, s.perms.admin);
    assert.equal(lookups().length, 4, "四类各一条，与行数无关");
    // 导出大表：850 个不同人员对象 → 800/批切 2 条（仍是批量，不是逐行）
    const values = [];
    const params = [];
    for (let i = 0; i < 850; i++) {
      values.push("(?, ?, ?, 'x', '2', 1)");
      params.push(String(2000 + i), `bulk${i}`, `批量${i}`);
    }
    await db.run(
      `INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES ${values.join(", ")}`,
      params
    );
    const logValues = [];
    const logParams = [];
    for (let i = 0; i < 850; i++) {
      logValues.push(
        "(?, ?, '2', '系统管理员', '修改用户', 'user', ?, '成功', '', '2026-10-15 09:00:00.000', '10.0.0.1')"
      );
      logParams.push("2", `单位2`, String(2000 + i));
    }
    await db.run(
      `INSERT INTO sys_operation_log (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip) VALUES ${logValues.join(", ")}`,
      logParams
    );
    calls.length = 0;
    const exp = await queryOperationLogsForExport(counted, s.admin, RANGE, 50000, s.perms.admin);
    assert.ok(exp.rows.length >= 850);
    const userLookups = lookups().filter((sql) => /FROM sys_user WHERE id IN/.test(sql));
    assert.equal(userLookups.length, 2, "850 对象切 2 批，不逐行查");
    assert.ok(exp.rows.every((r) => typeof r.targetName === "string" && r.targetName));
  } finally {
    await env.close();
  }
});

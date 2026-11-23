/**
 * #26 B-01：操作日志 targetId/detail 的 IMEI 读时脱敏。
 * 箱子类审计 target_id=15 位 IMEI（box.id），AGENCY_LEAD/BRANCH_ADMIN/LEADER 无设备标识权限
 * （identityGranted=false），列表/导出/详情只能见 maskImei（前 3 后 4，861********xxxx 形态）；
 * admin/asset（三项标识权限齐全）见整串；user 类短编号不受影响；perms=null 内部调用不打码。
 * 跑法：node --test server/test/operation-log-imei-mask.test.js（全量 npm run test:server）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { identityGranted, maskImei, resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { queryOperationLogs, queryOperationLogsForExport } from "../src/log/operationLog.js";
import { operationLogsExport } from "../src/log/operationLogExport.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oplog-imei-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  await seedOrg(db);
  await seedRolePerms(db);
  await legacyAgency(db);
  return {
    db,
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 组织简化（B1b）：新种子不再含机构子树与 14 AGENCY_LEAD（056 合并进 BRANCH_ADMIN）。
 * 脱敏口径按权限码（identityGranted）判定、组织无关，补迁移前旧形态夹具守住原断言。
 */
async function legacyAgency(db) {
  for (const [id, parent, name] of [
    ["5", "0", "合作采样机构"],
    ["51", "5", "采样机构甲"],
    ["511", "51", "甲现场组"],
    ["52", "5", "采样机构乙"],
    ["521", "52", "乙现场组"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,'公司')",
      [id, parent, name, `L${id}`]
    );
  await db.run(
    "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('14','机构负责人','AGENCY_LEAD',2,8,1)"
  );
  for (const perm of ["sys:oplog:read", "sys:oplog:export"])
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('14', ?, 0)", [
      perm,
    ]);
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

/** 箱子类审计：target_type=box、target_id=整串 IMEI（与 SampleController.record 同形态）。 */
async function boxLog(db, orgId, orgName, targetId, createdAt, detail = "") {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, '6', '陈可', '分配采样箱', 'box', ?, '成功', ?, ?, '10.0.0.1')`,
    [orgId, orgName, targetId, detail, createdAt]
  );
}

async function userLog(db, orgId, orgName, actorId, createdAt) {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, ?, ?, '登录', 'user', ?, '成功', '', ?, '10.0.0.1')`,
    [orgId, orgName, actorId, actorId, actorId, createdAt]
  );
}

/** mock ctx 直调导出处理器（带 access，模拟 requireAccess 已解析）；download 收全 CSV 文本。 */
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

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const AT = "2026-10-15 09:00:00.000";
const IMEI = "861234567890123";
const MASKED = "861********0123";
const IMEI2 = "869876543210987";
const MASKED2 = "869********0987";
const HEADER = "\uFEFF时间,单位,操作者,动作,对象类型,对象编号,对象名称,结果,来源 IP,明细\r\n";

/** 三个无标识权限的管理角色 + 对照 admin/asset，连同各自范围内的箱子审计一起备好。 */
async function scenario(db) {
  const agency = await person(db, "90", "agency.lead", "51", ["14"]);
  const branch = await person(db, "91", "branch.admin", "2", ["12"]);
  const leader = await person(db, "92", "leader.view", "14", ["11"]);
  const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
  const asset = await db.get("SELECT * FROM sys_user WHERE username = 'zhou.ning'");
  // ASSET 模板默认没有日志码：补授 read/export（标识权限三项齐全，作「有权见整串」对照）
  for (const perm of ["sys:oplog:read", "sys:oplog:export"])
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES ('8', ?, 0)", [perm]);

  await boxLog(db, "51", "采样机构甲", IMEI, AT);
  await boxLog(db, "21", "调度室", IMEI2, AT);
  await boxLog(db, "11", "系统管理", IMEI, AT);
  await userLog(db, "51", "采样机构甲", "90", AT);
  // 老数据非 IMEI 形态的箱子编号不受脱敏影响
  await boxLog(db, "51", "采样机构甲", "BOX-001", AT);

  const perms = {};
  for (const [key, user] of Object.entries({ agency, branch, leader, admin, asset }))
    perms[key] = (await resolveAccess(db, user)).perms;
  return { agency, branch, leader, admin, asset, perms };
}

test("agency/branch/leader 列表+导出只见打码 IMEI（861********xxxx），整串一个字不出现", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    assert.equal(maskImei(IMEI), MASKED, "打码形态：前 3 + 8 星 + 后 4");
    for (const key of ["agency", "branch", "leader"]) {
      assert.ok(!identityGranted(s.perms[key]), `${key} 模板不应含设备标识三项`);
      assert.ok(s.perms[key].has("sys:oplog:read"), `${key} 有日志读码（D5/D4）`);
      assert.ok(s.perms[key].has("sys:oplog:export"), `${key} 有导出码（D4）`);

      const page = await queryOperationLogs(db, s[key], { ...RANGE, limit: 100 }, s.perms[key]);
      const boxItems = page.list.filter((i) => i.targetType === "box" && i.targetId !== "BOX-001");
      assert.ok(boxItems.length > 0, `${key} 范围内要有箱子审计`);
      for (const item of boxItems) {
        assert.match(item.targetId, /^\d{3}\*{8}\d{4}$/, `${key} targetId 要是打码形态`);
      }
      assert.ok(
        !JSON.stringify(page.list).includes(IMEI) && !JSON.stringify(page.list).includes(IMEI2),
        `${key} 列表 JSON 里不能出现整串 IMEI`
      );

      const out = await invokeExport(db, s[key], s.perms[key], RANGE);
      assert.ok(out.ok, out.message);
      assert.ok(out.text.includes(MASKED) || out.text.includes(MASKED2), `${key} 导出要有打码串`);
      assert.ok(!out.text.includes(IMEI) && !out.text.includes(IMEI2), `${key} 导出不能泄露整串`);
      assert.equal(out.headers["X-Export-Truncated"], "0");
    }
    // 范围口径不因脱敏改变：agency 只见 51/511，branch 只见 2/21，leader 全量
    const agencyPage = await queryOperationLogs(
      db,
      s.agency,
      { ...RANGE, limit: 100 },
      s.perms.agency
    );
    assert.deepEqual([...new Set(agencyPage.list.map((i) => i.orgId))].sort(), ["51"]);
    const branchPage = await queryOperationLogs(
      db,
      s.branch,
      { ...RANGE, limit: 100 },
      s.perms.branch
    );
    assert.deepEqual([...new Set(branchPage.list.map((i) => i.orgId))].sort(), ["21"]);
    const leaderPage = await queryOperationLogs(
      db,
      s.leader,
      { ...RANGE, limit: 100 },
      s.perms.leader
    );
    assert.equal(leaderPage.list.length, 5);
  } finally {
    await env.close();
  }
});

test("admin/asset（设备标识权限齐全）列表+导出见整串 IMEI", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    for (const key of ["admin", "asset"]) {
      assert.ok(identityGranted(s.perms[key]), `${key} 应有设备标识三项`);
      const page = await queryOperationLogs(db, s[key], { ...RANGE, limit: 100 }, s.perms[key]);
      const boxItems = page.list.filter((i) => i.targetType === "box" && i.targetId !== "BOX-001");
      assert.ok(boxItems.length > 0);
      assert.ok(boxItems.every((i) => i.targetId === IMEI || i.targetId === IMEI2));
      const out = await invokeExport(db, s[key], s.perms[key], RANGE);
      assert.ok(out.ok, out.message);
      assert.ok(out.text.includes(IMEI) && out.text.includes(IMEI2), `${key} 导出见整串`);
      assert.ok(!out.text.includes(MASKED), `${key} 不应被打码`);
    }
  } finally {
    await env.close();
  }
});

test("user 类 targetId 与非 IMEI 箱子编号不受影响；detail 内嵌 IMEI 同样打码", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    const detail = JSON.stringify({
      boxId: IMEI,
      note: `分配采样箱 ${IMEI} 给甲现场组`,
      iccid: "89860123456789012345",
      ts: 1760000000000,
    });
    await boxLog(db, "51", "采样机构甲", IMEI, "2026-10-16 09:00:00.000", detail);

    const page = await queryOperationLogs(db, s.agency, { ...RANGE, limit: 100 }, s.perms.agency);
    // user 类短编号原样
    const userItem = page.list.find((i) => i.targetType === "user");
    assert.equal(userItem.targetId, "90");
    // 老数据 BOX-001 原样
    const legacy = page.list.find((i) => i.targetId === "BOX-001");
    assert.ok(legacy, "非 IMEI 形态编号不打码");
    // detail：IMEI 打码，JSON 仍可解析；20 位 ICCID/13 位时间戳不被截断误伤
    const withDetail = page.list.find((i) => i.detail);
    assert.ok(!withDetail.detail.includes(IMEI), "detail 里整串 IMEI 要打码");
    const parsed = JSON.parse(withDetail.detail);
    assert.equal(parsed.boxId, MASKED);
    assert.equal(parsed.note, `分配采样箱 ${MASKED} 给甲现场组`);
    assert.equal(parsed.iccid, "89860123456789012345", "长数字串不部分匹配");
    assert.equal(parsed.ts, 1760000000000);

    // 导出明细列同口径
    const out = await invokeExport(db, s.agency, s.perms.agency, RANGE);
    assert.ok(out.text.includes(MASKED));
    assert.ok(!out.text.includes(IMEI));
    assert.ok(out.text.includes("89860123456789012345"), "ICCID 不在本次 IMEI 口径内，原样");

    // admin 对照：detail 原样
    const adminPage = await queryOperationLogs(
      db,
      s.admin,
      { ...RANGE, limit: 100 },
      s.perms.admin
    );
    const adminDetail = adminPage.list.find((i) => i.detail);
    assert.ok(adminDetail.detail.includes(IMEI));
    assert.equal(JSON.parse(adminDetail.detail).boxId, IMEI);
  } finally {
    await env.close();
  }
});

test("空范围仍 fail-closed：角色停用/越权 orgId 传 perms 也只给空表，不因脱敏报错", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    // 越权 orgId：收敛为空（不报错泄露）
    const foreign = await queryOperationLogs(
      db,
      s.agency,
      { ...RANGE, orgId: "52" },
      s.perms.agency
    );
    assert.deepEqual(foreign.list, []);
    const foreignExport = await invokeExport(db, s.agency, s.perms.agency, {
      ...RANGE,
      orgId: "52",
    });
    assert.ok(foreignExport.ok);
    assert.equal(foreignExport.text, HEADER);
    assert.equal(foreignExport.headers["X-Export-Row-Count"], "0");

    // 角色停用 → none：列表空、导出仅表头
    await db.run("UPDATE sys_role SET status = 0 WHERE id = '14'");
    const disabledPerms = (await resolveAccess(db, s.agency)).perms;
    const disabled = await queryOperationLogs(db, s.agency, RANGE, disabledPerms);
    assert.deepEqual(disabled.list, []);
    assert.equal(disabled.nextCursor, null);
    const disabledExport = await invokeExport(db, s.agency, disabledPerms, RANGE);
    assert.ok(disabledExport.ok);
    assert.equal(disabledExport.text, HEADER);
    const disabledRows = await queryOperationLogsForExport(
      db,
      s.agency,
      RANGE,
      50000,
      disabledPerms
    );
    assert.deepEqual(disabledRows.rows, []);
    assert.equal(disabledRows.truncated, false);
  } finally {
    await env.close();
  }
});

test("perms 缺省（内部调用）不打码；接线事实：列表/导出处理器都传 ctx.access.perms", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const s = await scenario(db);
    // 默认 null＝内部调用（无查看者上下文）：保持原样，供审计取证等内部用途
    const internal = await queryOperationLogs(db, s.agency, { ...RANGE, limit: 100 });
    assert.ok(internal.list.some((i) => i.targetId === IMEI));
    const internalExport = await queryOperationLogsForExport(db, s.agency, RANGE);
    assert.ok(internalExport.rows.some((i) => i.targetId === IMEI));
    // mock ctx 不带 access（旧单测口径）也不打码、不报错
    const noAccess = await invokeExport(db, s.agency, undefined, RANGE);
    assert.ok(noAccess.ok);
    assert.ok(noAccess.text.includes(IMEI));

    // 接线事实（源码断言，同 operation-log-export.test.js 写法）：
    // HTTP 通路必须把 requireAccess 解析出的 perms 传进取数层，否则脱敏形同虚设
    const indexSrc = await readFile(new URL("../index.js", import.meta.url), "utf8");
    const handler = indexSrc.match(/async function operationLogs\(ctx\) \{[\s\S]*?\n\}/);
    assert.ok(handler, "operationLogs 处理器要在");
    assert.match(
      handler[0],
      /queryOperationLogs\(state\.db, ctx\.user, ctx\.query, ctx\.access\?\.perms/
    );
    const exportSrc = await readFile(
      new URL("../src/log/operationLogExport.js", import.meta.url),
      "utf8"
    );
    assert.match(exportSrc, /ctx\.access\?\.perms \?\? null/);
    // M-01：导出校验错误带 HTTP 400，不再 200 假成功
    assert.match(exportSrc, /ctx\.fail\(result\.error, "A0001", 400\)/);
  } finally {
    await env.close();
  }
});

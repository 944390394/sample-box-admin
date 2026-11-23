/**
 * #26 B2：操作日志导出（D4 上限 5 万行）。
 * 跑法：node --test server/test/operation-log-export.test.js（全量 npm run test:server）。
 * 覆盖：
 * - 机构角色导出只见本单位及下级（D1 actor 口径），org_name 非空，CSV 列与列表一致；
 * - 越权 orgId 收敛为空表（不报错泄露）；空范围（角色停用）只导出表头；
 * - 上限截断：默认 50000，超出截断并在响应头 + CSV 注释行双标明；
 * - 路由挂 sys:oplog:export 权限码，无码用户（采样员）在通用门禁处 A0301/403；
 * - CSV 转义/防表格注入、文件名只含日期、audit 写 detail 可读回、时间范围校验与列表同口径；
 * - #26 M-01：范围/时间校验错误回 HTTP 400 + A0001（不再 200 假成功），失败不下载不写审计。
 * 处理器用 mock ctx 直调（同 user-avatar.test.js 写法）；真实 HTTP 403/下载头另见验收探针。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { audit } from "../src/log/audit.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import {
  OPERATION_LOG_EXPORT_MAX,
  operationLogExportQuery,
  queryOperationLogs,
  queryOperationLogsForExport,
} from "../src/log/operationLog.js";
import {
  csvCell,
  operationLogCsvLines,
  operationLogCsvName,
  operationLogsExport,
} from "../src/log/operationLogExport.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oplog-export-"));
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
 * 组织简化（B1b）：新种子不再含机构子树 5/51/52/511/521 与 14 AGENCY_LEAD（056 合并进 BRANCH_ADMIN）。
 * 本文件验证导出的范围收敛机制（D1 actor 口径，组织无关），补迁移前旧形态夹具守住原断言。
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
  for (const perm of ["sys:oplog:read", "sys:oplog:export", "sys:user:view", "sys:dept:view"])
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

async function log(db, orgId, actorId, createdAt, orgName = "", detail = "") {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, ?, ?, '登录', 'user', ?, '成功', ?, ?, '10.0.0.1')`,
    [orgId, orgName, actorId, actorId, actorId, detail, createdAt]
  );
}

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const AT = "2026-10-15 09:00:00.000";
const HEADER = "\uFEFF时间,单位,操作者,动作,对象类型,对象编号,对象名称,结果,来源 IP,明细\r\n";

/** mock ctx 直调导出处理器：download 收全 CSV 文本与附加头，fail 收错误口径。 */
async function invokeExport(db, user, query = {}) {
  let result;
  await operationLogsExport({
    db,
    user,
    query,
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

const csvRows = (text) => text.split("\r\n").filter((line) => line && !line.startsWith("#"));

test("机构角色导出只见本单位及下级，org_name 非空，CSV 列与列表一致", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const lead = await person(db, "90", "agency.lead", "51", ["14"]);
    await log(db, "51", "90", AT, "采样机构甲", '{"added":["sys:oplog:export"]}');
    await log(db, "511", "7", AT, "甲现场组");
    await log(db, "52", "91", AT, "采样机构乙");
    await log(db, "521", "8", AT, "乙现场组");
    await log(db, "2", "6", AT, "华南分公司");
    await log(db, "11", "2", AT, "系统管理");

    const out = await invokeExport(db, lead, RANGE);
    assert.ok(out.ok, out.message);
    assert.match(out.filename, /^操作日志-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.equal(out.headers["X-Export-Truncated"], "0");
    assert.equal(out.headers["X-Export-Row-Count"], "2");
    assert.ok(out.text.startsWith(HEADER), "BOM + 表头列与列表页一致");

    const rows = csvRows(out.text);
    assert.equal(rows.length, 3, "表头 + 2 行数据");
    // 与列表同口径：条数、单位集合、明细字段一致
    const page = await queryOperationLogs(db, lead, { ...RANGE, limit: 100 });
    assert.equal(page.list.length, 2);
    assert.deepEqual([...new Set(page.list.map((i) => i.orgId))].sort(), ["51", "511"]);
    assert.ok(page.list.every((i) => i.orgName));
    // 列序逐格核对（detail 含引号/逗号 → 双引号转义）
    const leadRow = rows.find((line) => line.includes("采样机构甲"));
    assert.equal(
      leadRow,
      `${AT},采样机构甲,90,登录,user,90,agency.lead,成功,10.0.0.1,"{""added"":[""sys:oplog:export""]}"`
    );
    assert.ok(
      rows.some((line) => line.startsWith(`${AT},甲现场组,7,登录,user,7,人员 #7,成功,10.0.0.1,`))
    );
    // 范围外单位一个字都不出现
    for (const leak of ["采样机构乙", "乙现场组", "华南分公司", "系统管理"])
      assert.ok(!out.text.includes(leak), `${leak} 泄露到导出里`);

    // 导出本身写审计（orgName 由 audit 收敛补齐），且不进本次导出结果
    const auditRow = await db.get(
      "SELECT org_id, org_name, action, target_type FROM sys_operation_log WHERE action = '导出操作日志'"
    );
    assert.equal(auditRow.org_id, "51");
    assert.equal(auditRow.org_name, "采样机构甲");
    assert.equal(auditRow.target_type, "oplog");
  } finally {
    await env.close();
  }
});

test("越权 orgId 收敛为空表不报错；空范围只导出表头；范围内 orgId 只给该单位", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const lead = await person(db, "90", "agency.lead", "51", ["14"]);
    await log(db, "51", "90", AT, "采样机构甲");
    await log(db, "511", "7", AT, "甲现场组");
    await log(db, "52", "91", AT, "采样机构乙");

    // 越权 orgId：200 空表（仅表头），不是错误，也不泄露兄弟机构存在性
    const foreign = await invokeExport(db, lead, { ...RANGE, orgId: "52" });
    assert.ok(foreign.ok);
    assert.equal(foreign.text, HEADER);
    assert.equal(foreign.headers["X-Export-Row-Count"], "0");
    assert.equal(foreign.headers["X-Export-Truncated"], "0");

    // 范围内 orgId：只给该单位
    const own = await invokeExport(db, lead, { ...RANGE, orgId: "511" });
    assert.deepEqual(
      csvRows(own.text)
        .slice(1)
        .map((line) => line.split(",")[1]),
      ["甲现场组"]
    );

    // 角色停用 → none 空范围：同样只给表头
    await db.run("UPDATE sys_role SET status = 0 WHERE id = '14'");
    const disabled = await invokeExport(db, lead, RANGE);
    assert.ok(disabled.ok);
    assert.equal(disabled.text, HEADER);
    await db.run("UPDATE sys_role SET status = 1 WHERE id = '14'");

    // 对照：admin（all）按 orgId=52 过滤能拿到兄弟机构
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    const adminForeign = await invokeExport(db, admin, { ...RANGE, orgId: "52" });
    assert.equal(csvRows(adminForeign.text).length, 2);

    // 仅本人范围（采样员）：导出与列表同口径，只有自己的行
    const sampler = await db.get("SELECT * FROM sys_user WHERE username = 'lin.xia'");
    const samplerOut = await invokeExport(db, sampler, RANGE);
    const samplerPage = await queryOperationLogs(db, sampler, { ...RANGE, limit: 100 });
    assert.equal(csvRows(samplerOut.text).length - 1, samplerPage.list.length);
    assert.ok(
      csvRows(samplerOut.text)
        .slice(1)
        .every((line) => line.split(",")[2] === "7")
    );

    // 时间范围校验与列表同口径：超 31 天给同一句错误，不导出（#26 M-01：HTTP 400，不再 200 假成功）
    const tooLong = await invokeExport(db, admin, { from: "2026-01-01", to: "2026-03-01" });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.message, "一次最长查询 31 天");
    assert.equal(tooLong.code, "A0001");
    assert.equal(tooLong.status, 400);
  } finally {
    await env.close();
  }
});

test("上限截断（D4）：默认 5 万行，超出截断并在响应头与 CSV 注释行双标明", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    assert.equal(OPERATION_LOG_EXPORT_MAX, 50000);
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");

    // 机制：小上限同样截断，保留最近（DESC）的 max 行
    for (let i = 0; i < 8; i++) await log(db, "51", "90", AT, "采样机构甲");
    const small = await queryOperationLogsForExport(db, admin, RANGE, 5);
    assert.equal(small.rows.length, 5);
    assert.equal(small.truncated, true);
    assert.equal(small.max, 5);
    const smallCsv = [...operationLogCsvLines(small.rows, small)].join("");
    const smallLines = smallCsv.split("\r\n").filter(Boolean);
    assert.equal(smallLines.length, 7, "表头 + 5 行 + 注释行");
    assert.match(smallLines[6], /^# 已达单次导出上限 5 行/);
    // 上限硬顶：传比 5 万大的值也收敛到 5 万
    assert.equal(operationLogExportQuery({ kind: "all" }, RANGE, 999999).max, 50000);

    // 真·5 万上限：补到 50001 行（分批多行 INSERT，参数数在 sqlite 变量上限内）
    const batch = 1000;
    const total = 50001;
    for (let start = 8; start < total; start += batch) {
      const count = Math.min(batch, total - start);
      const values = Array.from(
        { length: count },
        () => "(?, ?, ?, ?, '登录', 'user', ?, '成功', '', ?, '10.0.0.1')"
      ).join(", ");
      const params = [];
      for (let i = 0; i < count; i++) params.push("51", "采样机构甲", "90", "90", "90", AT);
      await db.run(
        `INSERT INTO sys_operation_log (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip) VALUES ${values}`,
        params
      );
    }
    const out = await invokeExport(db, admin, RANGE);
    assert.ok(out.ok);
    assert.equal(out.headers["X-Export-Truncated"], "1");
    assert.equal(out.headers["X-Export-Row-Count"], "50000");
    assert.equal(out.headers["X-Export-Max"], "50000");
    const lines = out.text.split("\r\n").filter(Boolean);
    assert.equal(lines.length, 50002, "表头 + 50000 行 + 注释行");
    assert.match(lines[lines.length - 1], /^# 已达单次导出上限 50000 行/);
  } finally {
    await env.close();
  }
});

test("导出路由挂 sys:oplog:export 码：无码用户（采样员）在通用门禁处 A0301/403", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 路由注册事实（同 schema-upgrade.test.js 的源码断言写法）：
    // export 路由必须带 perm sys:oplog:export；通用门禁对缺码统一回 A0301/403
    const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
    const block = routes.match(
      /path: "\/api\/v1\/system\/operation-logs\/export",[\s\S]*?handler: operationLogsExport,/
    );
    assert.ok(block, "export 路由要注册");
    assert.match(block[0], /perm: "sys:oplog:export"/);
    assert.match(routes, /return ctx\.fail\("没有这项操作权限", "A0301", 403\)/);

    // 码集事实：D4 随 read 补授后机构负责人/管理员有 export 码，采样员（无 read）没有
    const lead = await person(db, "90", "agency.lead", "51", ["14"]);
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    const sampler = await db.get("SELECT * FROM sys_user WHERE username = 'lin.xia'");
    assert.ok((await resolveAccess(db, lead)).perms.has("sys:oplog:export"));
    assert.ok((await resolveAccess(db, admin)).perms.has("sys:oplog:export"));
    const samplerPerms = (await resolveAccess(db, sampler)).perms;
    assert.ok(!samplerPerms.has("sys:oplog:export"), "采样员没有导出码 → 门禁 403");
    assert.ok(!samplerPerms.has("sys:oplog:read"));
  } finally {
    await env.close();
  }
});

test("CSV 转义与防表格注入；文件名只含日期不含敏感信息", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell("普通"), "普通");
    assert.equal(csvCell('含"引号,和逗号'), '"含""引号,和逗号"');
    assert.equal(csvCell("换\n行"), '"换\n行"');
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("+cmd"), "'+cmd");
    assert.equal(csvCell("-cmd"), "'-cmd");
    assert.equal(csvCell("@cmd"), "'@cmd");

    // 文件名：固定前缀 + 日期，不带账号/单位/筛选值
    const name = operationLogCsvName(new Date(2026, 10, 20, 15, 30));
    assert.equal(name, "操作日志-2026-11-20.csv");

    // 恶意内容落库后导出仍安全
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await db.run(
      `INSERT INTO sys_operation_log
        (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
       VALUES ('11', '系统管理', '2', '=HYPERLINK("http://evil")', '登录', 'user', '2', '成功', 'a,b"c', ?, '10.0.0.1')`,
      [AT]
    );
    const out = await invokeExport(db, admin, RANGE);
    assert.ok(out.text.includes("'=HYPERLINK"), "公式注入要加单引号前缀");
    assert.ok(out.text.includes('"a,b""c"'), "明细里的逗号引号要转义");
  } finally {
    await env.close();
  }
});

test("audit 写 detail（grant diff 等）落库，列表与导出都读得回", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await audit(db, {
      orgId: "11",
      actorId: String(admin.id),
      actorName: admin.nickname,
      action: "修改角色",
      targetType: "role",
      targetId: "14",
      result: "成功",
      detail: { added: ["sys:oplog:export"], removed: [], scopeBefore: 3, scopeAfter: 2 },
      createdAt: AT,
    });
    const page = await queryOperationLogs(db, admin, { ...RANGE, limit: 10 });
    const item = page.list.find((i) => i.action === "修改角色");
    assert.ok(item, "audit 写入要能查回");
    assert.equal(item.orgName, "系统管理", "orgName 由 audit 收敛补齐");
    const parsed = JSON.parse(item.detail);
    assert.deepEqual(parsed.added, ["sys:oplog:export"]);
    assert.equal(parsed.scopeAfter, 2);

    const out = await invokeExport(db, admin, RANGE);
    const row = csvRows(out.text).find((line) => line.includes("修改角色"));
    assert.ok(row.includes("scopeAfter"), "导出明细列带 grant diff");
  } finally {
    await env.close();
  }
});

test("#26 M-01：导出校验错误回 HTTP 400 + A0001，不下载文件、不写成功审计", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    // 三类范围/时间错误都带 HTTP 400：blob 下载通路据此走失败分支，不再把 JSON 错误体当 CSV 下载
    const cases = [
      [{ from: "2026-01-01", to: "2026-03-01" }, "一次最长查询 31 天"],
      [{ from: "不是日期", to: "2026-10-31" }, "时间格式不正确"],
      [{ from: "2026-10-31", to: "2026-10-01" }, "开始时间不能晚于结束时间"],
    ];
    for (const [query, message] of cases) {
      const out = await invokeExport(db, admin, query);
      assert.equal(out.ok, false, "要走 fail 而不是 download");
      assert.equal(out.message, message);
      assert.equal(out.code, "A0001");
      assert.equal(out.status, 400);
      assert.equal(out.text, undefined, "不能产出 CSV 文本");
    }
    // 失败通路不写「导出操作日志·成功」审计
    const auditRow = await db.get(
      "SELECT COUNT(*) AS n FROM sys_operation_log WHERE action = '导出操作日志'"
    );
    assert.equal(Number(auditRow.n), 0);
    // 对照：合法范围照常 200 下载（错误码改造不影响成功通路）
    const okOut = await invokeExport(db, admin, RANGE);
    assert.ok(okOut.ok);
    assert.ok(okOut.text.startsWith(HEADER));
  } finally {
    await env.close();
  }
});

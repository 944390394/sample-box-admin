/**
 * #26 review-26 minor 修复第二批（m-05/m-08/m-09）的行为断言：
 * - m-08：csvCell 防注入升级——前导空白（空格/制表符/换行/Unicode 空白）后接 =+-@ 也加单引号前缀，
 *   其余转义（引号/逗号/换行）不变；前导空白+非公式字符不加前缀（钉死 - 转义，防 [=+-@] 区间误伤数字）；
 * - m-09：导出审计在流式下载完成后才写「成功」（流写完瞬间审计尚未落库）；下载中途/立即抛错 →
 *   写「失败」并重抛原错误，不留「成功」；校验错误（超 31 天）不下载也不写审计；
 * - m-05：updateRole 空 deptIds + scope≠5 = 合法 no-op（与不带字段同语义：残留清理分支照常清自定义行）；
 *   非空 deptIds + scope≠5 仍拒但带 A0400/400；旧客户端不带 deptIds 保留原值不回归；
 *   scope5 + 空数组仍清空自定义行（既有语义，不得因修复归一成「保留」）。
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { csvCell, operationLogsExport } from "../src/log/operationLogExport.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review26-minors-2-"));
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

async function call(fn, ctx) {
  let out;
  await fn({
    query: {},
    params: {},
    body: {},
    ...ctx,
    ok: (data, message) => (out = { ok: true, data, message }),
    fail: (message, code, status) => (out = { ok: false, error: message, code, status }),
  });
  return out;
}

async function ctxOf(db, username) {
  const user = await db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
  return { db, user, access: await resolveAccess(db, user) };
}

async function role(db, id, code, scope) {
  await db.run(
    "INSERT INTO sys_role (id, name, code, data_scope, sort, status) VALUES (?, ?, ?, ?, 90, 1)",
    [id, `角色${code}`, code, scope]
  );
}

const deptIdsOf = async (db, roleId) =>
  (
    await db.all("SELECT dept_id FROM sys_role_dept WHERE role_id = ? ORDER BY dept_id", [roleId])
  ).map((row) => String(row.dept_id));

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const AT = "2026-10-15 09:00:00.000";
const HEADER = "\uFEFF时间,单位,操作者,动作,对象类型,对象编号,对象名称,结果,来源 IP,明细\r\n";

async function log(db, orgId, actorId, orgName, actorName = actorId, detail = "") {
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, ?, ?, '登录', 'user', ?, '成功', ?, ?, '10.0.0.1')`,
    [orgId, orgName, actorId, actorName, actorId, detail, AT]
  );
}

/** mock ctx 直调导出处理器：download 可注入成功/失败形状，fail 收错误口径。 */
function exportCtx(db, user, download, query = RANGE) {
  const out = {};
  return {
    out,
    ctx: {
      db,
      user,
      query,
      ip: "10.0.0.9",
      ok: (data) => (out.ok = { data }),
      fail: (message, code, status) => (out.fail = { message, code, status }),
      download,
    },
  };
}

const exportAudits = (db) =>
  db.all("SELECT * FROM sys_operation_log WHERE action = '导出操作日志' ORDER BY id");

test("m-08 csvCell：前导空白后的 =+-@ 加前缀；其余转义不变；非公式不加前缀", () => {
  // 前导空白/制表符后接公式（旧规约只查首字符会漏掉这些）
  assert.equal(csvCell("\t=cmd"), "'\t=cmd");
  assert.equal(csvCell(" =1+1"), "' =1+1");
  assert.equal(csvCell("  +cmd"), "'  +cmd");
  assert.equal(csvCell(" \t-cmd"), "' \t-cmd");
  assert.equal(csvCell("\r\n@cmd"), '"\'\r\n@cmd"');
  assert.equal(csvCell("\u00a0=cmd"), "'\u00a0=cmd");
  assert.equal(
    csvCell(' \t=HYPERLINK("http://evil","click")'),
    '"\' \t=HYPERLINK(""http://evil"",""click"")"',
    "前导空白公式 + 引号逗号转义叠加"
  );
  // 首字符公式（既有行为不变）
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell("@cmd"), "'@cmd");
  // 前导空白 + 非公式字符：不加前缀（钉死正则里 - 已转义，[=+-@] 的 +–@ 区间会误伤数字）
  assert.equal(csvCell(" 普通"), " 普通");
  assert.equal(csvCell("\t普通"), "\t普通");
  assert.equal(csvCell(" 123"), " 123");
  assert.equal(csvCell(" 9.5"), " 9.5");
  // 其余转义规约不变
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(123), "123");
  assert.equal(csvCell("普通"), "普通");
  assert.equal(csvCell('含"引号,和逗号'), '"含""引号,和逗号"');
  assert.equal(csvCell("换\n行"), '"换\n行"');
});

test("m-08 端到端：前导空白公式落库后导出仍加前缀，正常单元格不过度加前缀", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await log(db, "11", "2", "系统管理", ' \t=HYPERLINK("http://evil","click")', "\t=cmd|calc");
    await log(db, "11", "2", "系统管理", " 普通用户", " 123");
    let text = "";
    const { ctx, out } = exportCtx(db, admin, async (filename, chunks) => {
      for await (const chunk of chunks) text += chunk;
    });
    await operationLogsExport(ctx);
    assert.equal(out.fail, undefined);
    assert.ok(text.startsWith(HEADER));
    assert.ok(
      text.includes('"\' \t=HYPERLINK(""http://evil"",""click"")"'),
      "操作者列的前导空白公式要加前缀并转义"
    );
    assert.ok(text.includes("'\t=cmd|calc"), "明细列的制表符公式要加前缀");
    assert.ok(text.includes(" 普通用户") && !text.includes("' 普通用户"), "正常名称不加前缀");
    assert.ok(text.includes(" 123\r\n") && !text.includes("' 123"), "前导空白数字不加前缀");
  } finally {
    await env.close();
  }
});

test("m-09 成功审计在下载完成后才写：流写完瞬间未落库，处理器返回后恰一条「成功」", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await log(db, "11", String(admin.id), "系统管理");
    let text = "";
    let headersSeen = null;
    let auditDuringDownload = -1;
    const { ctx, out } = exportCtx(db, admin, async (filename, chunks, headers) => {
      headersSeen = headers;
      for await (const chunk of chunks) text += chunk;
      // 全部 chunk 已写完（streamDownload 形状：此后才 res.end() 并 resolve）：此刻审计必须还没写
      auditDuringDownload = (await exportAudits(db)).length;
    });
    await operationLogsExport(ctx);
    assert.equal(out.fail, undefined);
    assert.equal(auditDuringDownload, 0, "成功审计不得先于下载完成落库");
    assert.ok(text.startsWith(HEADER));
    assert.equal(headersSeen["X-Export-Row-Count"], "1");
    assert.equal(headersSeen["X-Export-Truncated"], "0");
    const rows = await exportAudits(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "成功");
    assert.equal(rows[0].org_id, String(admin.dept_id));
    assert.ok(rows[0].org_name, "orgName 由 audit 收敛补齐");
    assert.equal(rows[0].actor_id, String(admin.id));
    assert.equal(rows[0].target_type, "oplog");
  } finally {
    await env.close();
  }
});

test("m-09 下载中途抛错：写「失败」并重抛原错误，不留「成功」", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await log(db, "11", String(admin.id), "系统管理");
    await log(db, "11", String(admin.id), "系统管理");
    const boom = new Error("连接中断");
    let consumed = 0;
    let received = 0;
    const { ctx } = exportCtx(db, admin, async (filename, chunks) => {
      for await (const chunk of chunks) {
        received += chunk.length;
        consumed += 1;
        if (consumed === 2) throw boom; // 表头 + 第一行数据后断流
      }
    });
    await assert.rejects(operationLogsExport(ctx), (err) => err === boom);
    assert.equal(consumed, 2);
    assert.ok(received > 0, "断流前确实已写出部分数据");
    const rows = await exportAudits(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "失败");
    assert.equal(rows[0].actor_id, String(admin.id));
    assert.ok(!rows.some((row) => row.result === "成功"), "失败路径不得留「成功」审计");
  } finally {
    await env.close();
  }
});

test("m-09 下载立即抛错同样写「失败」；校验错误不下载不写审计", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
    await log(db, "11", String(admin.id), "系统管理");
    const boom = new Error("响应不可写");
    const { ctx } = exportCtx(db, admin, async () => {
      throw boom; // 一个 chunk 都没写就失败
    });
    await assert.rejects(operationLogsExport(ctx), (err) => err === boom);
    let rows = await exportAudits(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "失败");

    // 校验错误（超 31 天）：fail 400，不下载、不写任何审计（含「成功」）
    const bad = exportCtx(
      db,
      admin,
      async () => {
        throw new Error("校验失败不应触发下载");
      },
      { from: "2026-01-01", to: "2026-03-01" }
    );
    await operationLogsExport(bad.ctx);
    assert.equal(bad.out.fail?.message, "一次最长查询 31 天");
    assert.equal(bad.out.fail?.code, "A0001");
    assert.equal(bad.out.fail?.status, 400);
    rows = await exportAudits(db);
    assert.equal(rows.length, 1, "校验失败不新增审计行");
    assert.ok(!rows.some((row) => row.result === "成功"));
  } finally {
    await env.close();
  }
});

test("m-05 空 deptIds + 非自定义范围 = 合法 no-op，残留清理与不带字段同语义", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    await role(db, "80", "CUSTOM", 3);
    // 旧版对 [] + scope≠5 直接拒（A0001/200）；现在合法通过，范围不变
    const noop = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { deptIds: [] },
    });
    assert.equal(noop.ok, true, noop.error);
    assert.equal(
      Number((await db.get("SELECT data_scope FROM sys_role WHERE id = '80'")).data_scope),
      3
    );
    // 显式非 5 范围 + 空数组 + 改名：同样通过
    const renamed = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 4, deptIds: [], name: "改名通过" },
    });
    assert.equal(renamed.ok, true, renamed.error);
    assert.equal((await db.get("SELECT name FROM sys_role WHERE id = '80'")).name, "改名通过");

    // 自定义 5 → 非 5 携带空数组：清掉残留自定义行（与不带字段完全同语义）
    assert.equal(
      (
        await call(org.updateRole, {
          ...admin,
          params: { id: "80" },
          body: { dataScope: 5, deptIds: ["2", "21"] },
        })
      ).ok,
      true
    );
    assert.deepEqual(await deptIdsOf(db, "80"), ["2", "21"]);
    const moved = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 3, deptIds: [] },
    });
    assert.equal(moved.ok, true, moved.error);
    assert.deepEqual(await deptIdsOf(db, "80"), []);
    // 对照：同样的范围迁移不带 deptIds（旧客户端）结果一致
    await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 5, deptIds: ["2"] },
    });
    const movedLegacy = await call(org.updateRole, {
      ...admin,
      params: { id: "80" },
      body: { dataScope: 3 },
    });
    assert.equal(movedLegacy.ok, true, movedLegacy.error);
    assert.deepEqual(await deptIdsOf(db, "80"), []);

    // 范围保持非 5 但有历史残留行：空数组 ≡ 不带字段，残留清理分支照常清
    for (const body of [{ deptIds: [] }, {}]) {
      await db.run("INSERT INTO sys_role_dept (role_id, dept_id) VALUES ('80', '2')");
      const stay = await call(org.updateRole, { ...admin, params: { id: "80" }, body });
      assert.equal(stay.ok, true, stay.error);
      assert.deepEqual(await deptIdsOf(db, "80"), []);
    }
  } finally {
    await env.close();
  }
});

test("m-05 非空 deptIds + 非自定义范围仍拒：带 A0400/400，失败留痕且角色未变", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    await role(db, "81", "TARGET", 3);
    for (const body of [{ deptIds: ["2"] }, { dataScope: 4, deptIds: ["2"] }]) {
      const denied = await call(org.updateRole, { ...admin, params: { id: "81" }, body });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /自定义部门只在/);
      assert.equal(denied.code, "A0400", "校验类拒绝统一带码");
      assert.equal(denied.status, 400);
    }
    assert.equal(
      Number((await db.get("SELECT data_scope FROM sys_role WHERE id = '81'")).data_scope),
      3
    );
    assert.deepEqual(await deptIdsOf(db, "81"), []);
    const failRows = await db.all(
      "SELECT result FROM sys_operation_log WHERE action = '修改角色' AND target_id = '81'"
    );
    assert.equal(failRows.length, 2);
    assert.ok(failRows.every((row) => row.result === "失败"));
  } finally {
    await env.close();
  }
});

test("m-05 旧客户端不带 deptIds 保留自定义行不回归；scope5 + 空数组仍清空", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const admin = await ctxOf(db, "admin");
    await role(db, "82", "KEEP", 5);
    assert.equal(
      (
        await call(org.updateRole, {
          ...admin,
          params: { id: "82" },
          body: { dataScope: 5, deptIds: ["2", "21"] },
        })
      ).ok,
      true
    );
    // 只改名 / 空 body：自定义行原样保留（deptIds 缺省 → null → 不动 sys_role_dept）
    for (const body of [{ name: "只改名" }, {}]) {
      const kept = await call(org.updateRole, { ...admin, params: { id: "82" }, body });
      assert.equal(kept.ok, true, kept.error);
      assert.deepEqual(await deptIdsOf(db, "82"), ["2", "21"]);
    }
    // scope5 + 空数组 = 清空自定义行（既有语义；m-05 修复不得把 [] 归一成「保留」）
    const cleared = await call(org.updateRole, {
      ...admin,
      params: { id: "82" },
      body: { dataScope: 5, deptIds: [] },
    });
    assert.equal(cleared.ok, true, cleared.error);
    assert.deepEqual(await deptIdsOf(db, "82"), []);
  } finally {
    await env.close();
  }
});

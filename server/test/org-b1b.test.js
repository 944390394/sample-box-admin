/**
 * 组织简化 B1b（服务端组织/总览/迁移域）契约测试。
 *
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占服务端口。守住：
 * 1. 迁移 056：类型归一（总公司下恰一个采样机构→检测站，其余→公司；已有检测站/多候选/停用不指定）、
 *    角色合并（14→BRANCH_ADMIN 去重、14 停用不物理删）、备份表 _bak_org_simplify_*、幂等、
 *    P7 历史单 kind/status 映射落库（B1c：送检→采样＋状态映射，原值进 _bak_org_simplify_task；
 *    全矩阵/body JSON 同步/IN- 前缀保留/终态语义/异常跨 kind 幂等加固）、
 *    快照/日志不动（P4 其余面）；
 * 2. org-api：DEPT_TYPES=[公司,检测站]；检测站全局唯一＋属总公司子树（新建/改类型/改挂）；
 *    摄像头 gate 检测站禁配、公司可配，改类型为检测站时清理已有通道；
 * 3. resolveStation 三态：配置优先（非法配置→null）／未配置 DB 恰一个自动认定／零个或多个→null；
 *    assertStationSavable（saveBox 校验）友好报错；
 * 4. 总览四数（P13）：moving=合并单[在途,待签收]＋legacy 调拨/送检映射期兼容；
 *    arrivedTotal=[待检测,已检测,退回中,已退回] 箱数；openedTotal=inspected_at 非空箱数（跨日累计）；
 *    unopenedNow=待检测且 inspected_at 空；todayOpened 仅当日；集团侧与单位侧同口径；旧字段别名保留。
 * 5. B4a 小同步：056 ②b BRANCH_ADMIN/DISPATCH 幂等补 task:create:sample（默认码/模板同钉）；
 *    权限目录「寄回」旧文案改合并流口径；按日任务 to＝合并单接收方（与工作台 brief 同源，B3 遗留①）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { up as up056 } from "../migrations/056_org_simplify.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import {
  applyBoxSettings,
  assertStationSavable,
  resolveStation,
} from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { OverviewController } from "../src/http/OverviewController.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import {
  ALL_PERMS,
  CARD_PERMS,
  DEFAULT_ROLE_PERMS,
  ROLE_TEMPLATES,
  TASK_PERMS,
  upgradeCodes,
} from "../src/auth/permCatalog.js";
import { ENDED_OK, ENDED_VOID, SAMPLE_FLOW, SAMPLE_RETURN_FLOW } from "../src/settings/taskFlow.js";

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

const adminCtx = async (db) => {
  const user = await db.get("SELECT * FROM sys_user WHERE username = 'admin'");
  return { db, user, access: await resolveAccess(db, user), ip: "127.0.0.1" };
};

const insertDept = (db, id, parent, name, type = "公司", status = 1) =>
  db.run("INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,?,?)", [
    id,
    parent,
    name,
    `C${id}`,
    status,
    type,
  ]);

/* ---------------- 迁移 056 ---------------- */

test("056：类型归一＋角色合并（去重）＋备份表＋幂等；P7 历史单映射落库、快照/日志不动（P4）", async () => {
  const env = await tempDb("org-b1b-migrate-");
  const { db } = env;
  try {
    // 旧形态：13 是总公司下唯一启用的采样机构；51 挂在分公司下（非总公司子树）；52 停用
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "13", "1", "核验中心", "采样机构");
    await insertDept(db, "2", "0", "华南分公司");
    await insertDept(db, "51", "2", "采样机构甲", "采样机构");
    await insertDept(db, "52", "1", "采样机构乙", "采样机构", 0);
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('12','分公司管理员','BRANCH_ADMIN',2,6,1)"
    );
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('14','机构负责人','AGENCY_LEAD',2,8,1)"
    );
    for (const [id, dept] of [
      ["90", "51"],
      ["91", "51"],
      ["92", "2"],
    ])
      await db.run(
        "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
        [id, `u${id}`, `u${id}`, dept]
      );
    // 90 只有 14；91 已有 12+14（去重）；92 只有 12（不受影响）
    await db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES ('90','14')");
    await db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES ('91','12')");
    await db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES ('91','14')");
    await db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES ('92','12')");
    // 历史单/快照/日志（P7：kind/status 按映射落库；P4：快照/日志不得改写）
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES ('IN-1','历史送检','送检','运送中','{\"inspect\":true}','2026-10-01T00:00:00.000Z','2','13',1)"
    );
    await db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES ('IN-1','BOX-X','2','',0)"
    );
    await db.run(
      "INSERT INTO sys_operation_log (org_id,org_name,actor_id,actor_name,action,target_type,target_id,result,created_at,ip) VALUES ('51','采样机构甲','90','u90','登录','user','90','成功','2026-10-01 09:00:00.000','10.0.0.1')"
    );

    // migrate 已对空库跑过一次 056（备份表是空壳）；先删掉再跑，验证「改动前备份」语义
    for (const t of ["sys_dept", "sys_role", "sys_user_role"])
      await db.run(`DROP TABLE IF EXISTS _bak_org_simplify_${t}`);
    await db.run("DROP TABLE IF EXISTS _bak_org_simplify_task");
    await up056(db);
    // ① 类型归一：13→检测站（总公司下恰一个启用采样机构）；51/52→公司
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='13'")).type, "检测站");
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='51'")).type, "公司");
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='52'")).type, "公司");
    // ② 角色合并：90 补绑 12；91 去重后只一条 12；14 绑定清空、角色停用不物理删
    const rolesOf = async (id) =>
      (
        await db.all("SELECT role_id FROM sys_user_role WHERE user_id=? ORDER BY role_id", [id])
      ).map((r) => String(r.role_id));
    assert.deepEqual(await rolesOf("90"), ["12"]);
    assert.deepEqual(await rolesOf("91"), ["12"]);
    assert.deepEqual(await rolesOf("92"), ["12"]);
    assert.equal(Number((await db.get("SELECT status FROM sys_role WHERE id='14'")).status), 0);
    assert.ok(await db.get("SELECT id FROM sys_role WHERE id='14'"), "14 不物理删");
    // ④ 备份表留改动前行
    assert.equal(
      (await db.get("SELECT type FROM _bak_org_simplify_sys_dept WHERE id='13'")).type,
      "采样机构"
    );
    assert.equal(
      Number((await db.get("SELECT status FROM _bak_org_simplify_sys_role WHERE id='14'")).status),
      1
    );
    assert.equal(
      Number(
        (
          await db.get(
            "SELECT COUNT(*) AS n FROM _bak_org_simplify_sys_user_role WHERE role_id='14'"
          )
        ).n
      ),
      2
    );
    // P7（B1c）：历史送检单映射落库——kind 送检→采样、运送中→在途；原 id/IN- 前缀保留；
    // body 无 kind 键时不强塞（只改列），inspect 快照原样；原 kind/status 进备份表
    const task = await db.get("SELECT kind,status,body FROM sample_task WHERE id='IN-1'");
    assert.equal(task.kind, "采样");
    assert.equal(task.status, "在途");
    assert.equal(JSON.parse(task.body).inspect, true);
    const bakTask = await db.get("SELECT kind,status FROM _bak_org_simplify_task WHERE id='IN-1'");
    assert.equal(bakTask.kind, "送检");
    assert.equal(bakTask.status, "运送中");
    // P4 其余面：箱单快照/操作日志原样
    assert.ok(await db.get("SELECT box_id FROM sample_task_box WHERE task_id='IN-1'"));
    assert.equal(
      (await db.get("SELECT org_name FROM sys_operation_log WHERE actor_id='90'")).org_name,
      "采样机构甲"
    );

    // 幂等：再跑一次结果不变，备份仍是首次快照（含 sample_task 备份不被覆盖）
    await up056(db);
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='13'")).type, "检测站");
    assert.deepEqual(await rolesOf("90"), ["12"]);
    assert.deepEqual(await rolesOf("91"), ["12"]);
    assert.equal(Number((await db.get("SELECT status FROM sys_role WHERE id='14'")).status), 0);
    assert.equal(
      (await db.get("SELECT type FROM _bak_org_simplify_sys_dept WHERE id='13'")).type,
      "采样机构"
    );
    const again = await db.get("SELECT kind,status,body FROM sample_task WHERE id='IN-1'");
    assert.deepEqual(again, task, "重跑不改已映射单");
    assert.deepEqual(
      await db.get("SELECT kind,status FROM _bak_org_simplify_task WHERE id='IN-1'"),
      bakTask,
      "重跑不覆盖首次备份"
    );
  } finally {
    await env.close();
  }
});

test("056：多候选/已有检测站/停用候选都不自动指定，采样机构一律归公司", async () => {
  const env = await tempDb("org-b1b-migrate-multi-");
  const { db } = env;
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "13", "1", "甲", "采样机构");
    await insertDept(db, "14", "1", "乙", "采样机构");
    await up056(db);
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='13'")).type, "公司");
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='14'")).type, "公司");
    assert.equal(
      Number((await db.get("SELECT COUNT(*) AS n FROM sys_dept WHERE type='检测站'")).n),
      0,
      "多候选不指定"
    );
    // 已有检测站：不再指定第二个（全局唯一）
    await insertDept(db, "15", "1", "丙", "采样机构");
    await insertDept(db, "16", "1", "既有检测站", "检测站");
    await up056(db);
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='15'")).type, "公司");
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='16'")).type, "检测站");
    // 唯一候选但停用：不指定
    await db.run("UPDATE sys_dept SET type='采样机构' WHERE id='15'");
    await db.run("UPDATE sys_dept SET status=0 WHERE id='15'");
    await db.run("DELETE FROM sys_dept WHERE id='16'");
    await up056(db);
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='15'")).type, "公司");
  } finally {
    await env.close();
  }
});

/* ---------------- 迁移 056 P7 全矩阵（B1c） ---------------- */

/** 按 P7 映射表算期望 kind/status（单测内独立复算，不与迁移共用实现，钉死映射契约）。 */
const p7Expect = (kind, status) => ({
  kind: kind === "送检" ? "采样" : kind,
  status:
    kind === "送检"
      ? ({ 待寄出: "已封箱", 运送中: "在途" }[status] ?? status)
      : kind === "采样"
        ? ({ 待核验: "待检测", 已签收: "已检测", 已完成: "已检测" }[status] ?? status)
        : status,
});

test("056 P7 全矩阵：送检9态＋旧采样trip态落库、body JSON 同步、IN- 前缀保留、备份留原值、终态语义、调拨/划拨/新单不动", async () => {
  const env = await tempDb("org-b1c-matrix-");
  const { db } = env;
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "13", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    const spec = [];
    // 送检 9 态（body 带 kind/status 快照键＋inspect/boxIds/note 应原样保留）
    const insStatuses = [
      "待寄出",
      "运送中",
      "待签收",
      "待检测",
      "已检测",
      "退回中",
      "已退回",
      "已拒收",
      "已取消",
    ];
    insStatuses.forEach((st, i) =>
      spec.push({
        id: `IN-m${i + 1}`,
        kind: "送检",
        status: st,
        body: JSON.stringify({
          kind: "送检",
          status: st,
          inspect: true,
          boxIds: ["B1"],
          fromOrgId: "2",
          toOrgId: "13",
          note: "保留",
        }),
        from: "2",
        to: "13",
        inspect: 1,
        syncBody: true,
      })
    );
    // 旧采样 trip=双向：终态对齐 3 态（待核验/已签收/已完成）＋同名保留 4 态（trip 只读不动）
    for (const st of ["待核验", "已签收", "已完成", "待执行", "执行中", "待寄出", "运送中"])
      spec.push({
        id: `TK-leg-${st}`,
        kind: "采样",
        status: st,
        body: JSON.stringify({
          kind: "采样",
          status: st,
          trip: st === "待执行" || st === "执行中" ? "单向" : "双向",
          inspect: true,
          boxIds: ["B2"],
        }),
        from: "2",
        to: "13",
        inspect: 1,
        syncBody: true,
      });
    // 合并流新单/调拨/划拨：kind/status/body 一律不动
    spec.push({
      id: "TK-new-1",
      kind: "采样",
      status: "待采样",
      body: JSON.stringify({ kind: "采样", inspect: true, boxIds: ["B3"] }),
      from: "2",
      to: "13",
      inspect: 1,
      syncBody: false,
    });
    spec.push({
      id: "TK-new-2",
      kind: "采样",
      status: "在途",
      body: JSON.stringify({ kind: "采样", inspect: true, boxIds: ["B4"] }),
      from: "2",
      to: "13",
      inspect: 1,
      syncBody: false,
    });
    spec.push({
      id: "TK-dis-1",
      kind: "调拨",
      status: "运送中",
      body: JSON.stringify({ kind: "调拨", inspect: true, boxIds: ["B5"] }),
      from: "2",
      to: "13",
      inspect: 1,
      syncBody: false,
    });
    spec.push({
      id: "AL-1",
      kind: "划拨",
      status: "已划拨",
      body: JSON.stringify({ kind: "划拨", boxIds: ["B6"] }),
      from: null,
      to: "2",
      inspect: 0,
      syncBody: false,
    });
    // 异常 body：损坏 JSON 只改列不动 JSON；无 kind/status 键不强塞
    spec.push({
      id: "IN-bad",
      kind: "送检",
      status: "运送中",
      body: "{broken",
      from: "2",
      to: "13",
      inspect: 1,
      syncBody: false,
    });
    spec.push({
      id: "IN-nok",
      kind: "送检",
      status: "待寄出",
      body: '{"inspect":true}',
      from: "2",
      to: "13",
      inspect: 1,
      syncBody: false,
    });
    for (const r of spec)
      await db.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          r.id,
          `矩阵-${r.id}`,
          r.kind,
          r.status,
          r.body,
          "2026-10-01T00:00:00.000Z",
          r.from,
          r.to,
          r.inspect,
        ]
      );
    await db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES ('IN-m1','B1','2','',0)"
    );
    await db.run(
      "INSERT INTO sys_operation_log (org_id,org_name,actor_id,actor_name,action,target_type,target_id,result,created_at,ip) VALUES ('2','华南分公司','90','u90','创建','task','IN-m1','成功','2026-10-01 09:00:00.000','10.0.0.1')"
    );

    // migrate 已对空库跑过一次 056（备份表是空壳）；先删掉再跑，验证「改动前备份」语义
    for (const t of ["sys_dept", "sys_role", "sys_user_role"])
      await db.run(`DROP TABLE IF EXISTS _bak_org_simplify_${t}`);
    await db.run("DROP TABLE IF EXISTS _bak_org_simplify_task");
    await up056(db);

    const mergedStates = [...SAMPLE_FLOW, ...SAMPLE_RETURN_FLOW, "已拒收", "已取消"];
    const inspectImages = [];
    for (const r of spec) {
      const want = p7Expect(r.kind, r.status);
      const now = await db.get("SELECT id,kind,status,body FROM sample_task WHERE id=?", [r.id]);
      assert.ok(now, `${r.id} 原 id 保留（不删不改建）`);
      assert.equal(now.kind, want.kind, `${r.id} kind`);
      assert.equal(now.status, want.status, `${r.id} status`);
      // body：映射单同步 kind/status 快照键、其余键原样；未映射/异常 body 字节级不动
      if (r.syncBody && (now.kind !== r.kind || now.status !== r.status)) {
        const body = JSON.parse(now.body);
        const orig = JSON.parse(r.body);
        assert.equal(body.kind, want.kind, `${r.id} body.kind 同步`);
        if ("status" in orig) assert.equal(body.status, want.status, `${r.id} body.status 同步`);
        for (const key of Object.keys(orig))
          if (key !== "kind" && key !== "status")
            assert.deepEqual(body[key], orig[key], `${r.id} body.${key} 原样`);
      } else {
        assert.equal(now.body, r.body, `${r.id} body 原样`);
      }
      // 备份留改动前原值（body 字节级）
      const bak = await db.get("SELECT kind,status,body FROM _bak_org_simplify_task WHERE id=?", [
        r.id,
      ]);
      assert.deepEqual(
        { kind: bak.kind, status: bak.status, body: bak.body },
        { kind: r.kind, status: r.status, body: r.body },
        `${r.id} 备份留原值`
      );
      // 终态语义：OK→OK、VOID→VOID、非终态仍非终态
      if (ENDED_OK.includes(r.status))
        assert.ok(ENDED_OK.includes(now.status), `${r.id} 终态OK保持`);
      else if (ENDED_VOID.includes(r.status))
        assert.ok(ENDED_VOID.includes(now.status), `${r.id} 终态VOID保持`);
      else
        assert.ok(
          !ENDED_OK.includes(now.status) && !ENDED_VOID.includes(now.status),
          `${r.id} 非终态保持`
        );
      if (r.kind === "送检" && r.id.startsWith("IN-m")) inspectImages.push(now.status);
    }
    // 双射（单射到像集）：送检 9 态→9 个互不相同的合并流合法态
    assert.equal(new Set(inspectImages).size, 9, "送检状态映射单射");
    for (const st of inspectImages) assert.ok(mergedStates.includes(st), `${st} 是合并流合法态`);
    // IN- 前缀作历史事实保留：11 张 IN- 单 id 不改
    assert.equal(
      Number((await db.get("SELECT COUNT(*) AS n FROM sample_task WHERE id LIKE 'IN-%'")).n),
      11
    );
    assert.equal(
      Number((await db.get("SELECT COUNT(*) AS n FROM sample_task")).n),
      spec.length,
      "不增删单"
    );
    // P4 其余面：箱单快照/操作日志原样
    assert.ok(
      await db.get("SELECT box_id FROM sample_task_box WHERE task_id='IN-m1' AND box_id='B1'")
    );
    assert.equal(
      (await db.get("SELECT org_name FROM sys_operation_log WHERE target_id='IN-m1'")).org_name,
      "华南分公司"
    );

    // 幂等：连跑两次，全表 kind/status/body 与备份逐行不变
    const snap = await db.all("SELECT id,kind,status,body FROM sample_task ORDER BY id");
    const bakSnap = await db.all(
      "SELECT id,kind,status,body FROM _bak_org_simplify_task ORDER BY id"
    );
    await up056(db);
    await up056(db);
    assert.deepEqual(
      await db.all("SELECT id,kind,status,body FROM sample_task ORDER BY id"),
      snap,
      "重跑不改已映射单"
    );
    assert.deepEqual(
      await db.all("SELECT id,kind,status,body FROM _bak_org_simplify_task ORDER BY id"),
      bakSnap,
      "重跑不覆盖首次备份"
    );
  } finally {
    await env.close();
  }
});

test("056 P7 幂等加固：异常送检单停旧采样态不二次映射；迁移后新建单不受重跑影响；备份不收录后插单", async () => {
  const env = await tempDb("org-b1c-idempotent-");
  const { db } = env;
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "13", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    const insert = (id, kind, status, body) =>
      db.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,1)",
        [id, id, kind, status, body, "2026-10-01T00:00:00.000Z", "2", "13"]
      );
    // 异常跨 kind 数据：送检单停在旧采样专属态——P7「其余同名保留」只改 kind，重跑不得二次映射
    for (const st of ["已签收", "待核验", "已完成"])
      await insert(
        `IN-x-${st}`,
        "送检",
        st,
        JSON.stringify({ kind: "送检", status: st, inspect: true, boxIds: [] })
      );
    await insert(
      "IN-y1",
      "送检",
      "运送中",
      JSON.stringify({ kind: "送检", status: "运送中", inspect: true, boxIds: [] })
    );
    await insert(
      "TK-y2",
      "采样",
      "已完成",
      JSON.stringify({ kind: "采样", status: "已完成", trip: "双向", inspect: true, boxIds: [] })
    );
    for (const t of ["sys_dept", "sys_role", "sys_user_role"])
      await db.run(`DROP TABLE IF EXISTS _bak_org_simplify_${t}`);
    await db.run("DROP TABLE IF EXISTS _bak_org_simplify_task");
    await up056(db);
    for (const st of ["已签收", "待核验", "已完成"]) {
      const row = await db.get("SELECT kind,status,body FROM sample_task WHERE id=?", [
        `IN-x-${st}`,
      ]);
      assert.equal(row.kind, "采样", `IN-x-${st} kind 改采样`);
      assert.equal(row.status, st, `IN-x-${st} 状态同名保留`);
      assert.equal(JSON.parse(row.body).status, st, `IN-x-${st} body.status 同名保留`);
      assert.equal(JSON.parse(row.body).kind, "采样");
    }
    assert.equal((await db.get("SELECT status FROM sample_task WHERE id='IN-y1'")).status, "在途");
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id='TK-y2'")).status,
      "已检测"
    );

    // 迁移后新建：合并流新单重跑不受影响；后插旧态单不在备份里，重跑按采样映射归一一次后稳定
    await insert(
      "TK-post-1",
      "采样",
      "在途",
      JSON.stringify({ kind: "采样", inspect: true, boxIds: [] })
    );
    await insert(
      "TK-post-2",
      "采样",
      "已签收",
      JSON.stringify({ kind: "采样", status: "已签收", inspect: true, boxIds: [] })
    );
    await up056(db);
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id='TK-post-1'")).status,
      "在途",
      "合并流新单不动"
    );
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id='TK-post-2'")).status,
      "已检测",
      "后插旧态单归一"
    );
    const snap = await db.all("SELECT id,kind,status,body FROM sample_task ORDER BY id");
    await up056(db);
    assert.deepEqual(
      await db.all("SELECT id,kind,status,body FROM sample_task ORDER BY id"),
      snap,
      "第三次跑全表稳定"
    );
    for (const st of ["已签收", "待核验", "已完成"])
      assert.equal(
        (await db.get("SELECT status FROM sample_task WHERE id=?", [`IN-x-${st}`])).status,
        st,
        `IN-x-${st} 重跑不二次映射`
      );
    // 备份仍是首次快照：5 张原单、不收录迁移后新单
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM _bak_org_simplify_task")).n), 5);
    assert.equal(
      Number(
        (await db.get("SELECT COUNT(*) AS n FROM _bak_org_simplify_task WHERE id LIKE 'TK-post-%'"))
          .n
      ),
      0
    );
    assert.equal(
      (await db.get("SELECT status FROM _bak_org_simplify_task WHERE id='IN-y1'")).status,
      "运送中"
    );
  } finally {
    await env.close();
  }
});

/* ---------------- org-api 类型/唯一性/摄像头 gate ---------------- */

test("org-api：检测站全局唯一＋属总公司子树（新建/改类型/改挂），摄像头检测站禁配、公司可配、改类型清理", async () => {
  const env = await tempDb("org-b1b-dept-");
  const { db } = env;
  try {
    await seedOrg(db);
    await seedRolePerms(db);
    const admin = await adminCtx(db);
    // 默认种子：13 总部检测站（type=检测站）已在总公司下
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='13'")).type, "检测站");

    // 新建第二个检测站 → 全局唯一拒绝
    const second = await call(org.createDept, {
      ...admin,
      body: { name: "第二检测站", code: "ST2", parentId: "1", type: "检测站" },
    });
    assert.equal(second.ok, false);
    assert.match(second.error, /全局唯一/);
    // 改类型撞唯一 → 拒绝
    const retype = await call(org.updateDept, {
      ...admin,
      params: { id: "11" },
      body: { type: "检测站" },
    });
    assert.equal(retype.ok, false);
    assert.match(retype.error, /全局唯一/);
    // 13 改回公司（释放唯一名额）→ 成功
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: "13" }, body: { type: "公司" } })).ok,
      true
    );
    // 新建检测站挂分公司下（非总公司子树）→ 拒绝
    const outside = await call(org.createDept, {
      ...admin,
      body: { name: "分公司检测站", code: "STX", parentId: "2", type: "检测站" },
    });
    assert.equal(outside.ok, false);
    assert.match(outside.error, /总公司子树/);
    // 新建检测站带通道 → 拒绝（检测站禁配）
    const withCam = await call(org.createDept, {
      ...admin,
      body: {
        name: "带通道检测站",
        code: "STC",
        parentId: "1",
        type: "检测站",
        cameras: [{ name: "通道1" }],
      },
    });
    assert.equal(withCam.ok, false);
    assert.match(withCam.error, /检测站不设监控通道/);
    // 合法新建：总公司下、无通道
    const created = await call(org.createDept, {
      ...admin,
      body: { name: "总部检测站二", code: "ST2", parentId: "1", type: "检测站" },
    });
    assert.equal(created.ok, true, created.error);
    const st2 = (await db.get("SELECT id FROM sys_dept WHERE code='ST2'")).id;
    // 改挂到分公司下 → 拒绝（仍须属总公司子树）
    const move = await call(org.updateDept, {
      ...admin,
      params: { id: st2 },
      body: { parentId: "2" },
    });
    assert.equal(move.ok, false);
    assert.match(move.error, /总公司子树/);
    // 检测站显式带通道 → 拒绝
    const camOnStation = await call(org.updateDept, {
      ...admin,
      params: { id: st2 },
      body: { cameras: [{ name: "通道1" }] },
    });
    assert.equal(camOnStation.ok, false);
    assert.match(camOnStation.error, /检测站不设监控通道/);
    // 公司可配通道：改回公司后配通道成功
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: st2 }, body: { type: "公司" } })).ok,
      true
    );
    assert.equal(
      (
        await call(org.updateDept, {
          ...admin,
          params: { id: st2 },
          body: { cameras: [{ name: "通道1" }] },
        })
      ).ok,
      true
    );
    assert.equal(
      (await call(org.deptForm, { ...admin, params: { id: st2 } })).data.cameras.length,
      1
    );
    // 再改回检测站：已有通道被清理（检测站禁配、公司可配的清理规则）
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: st2 }, body: { type: "检测站" } })).ok,
      true
    );
    assert.deepEqual(
      (await call(org.deptForm, { ...admin, params: { id: st2 } })).data.cameras,
      []
    );
    assert.equal((await db.get("SELECT cameras FROM sys_dept WHERE id=?", [st2])).cameras, "[]");
  } finally {
    await env.close();
  }
});

/* ---------------- resolveStation 三态 + saveBox 校验 ---------------- */

test("resolveStation 三态：配置优先（非法→null）／未配置恰一个自动认定／零个或多个→null", async () => {
  const env = await tempDb("org-b1b-resolve-");
  const { db } = env;
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "6", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    const config = (stationDeptId) =>
      applyBoxSettings({
        box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId },
      });

    // 配置优先
    config("6");
    assert.equal(String((await resolveStation(db)).id), "6");
    // 未配置：DB 恰一个启用检测站（总公司子树）→ 自动认定
    config("");
    assert.equal(String((await resolveStation(db)).id), "6");
    // 非法配置：不存在 / 非检测站 / 停用 → null（不回退 DB）
    config("999");
    assert.equal(await resolveStation(db), null);
    config("2");
    assert.equal(await resolveStation(db), null);
    await db.run("UPDATE sys_dept SET status=0 WHERE id='6'");
    config("6");
    assert.equal(await resolveStation(db), null);
    config("");
    assert.equal(await resolveStation(db), null, "停用候选不算");
    await db.run("UPDATE sys_dept SET status=1 WHERE id='6'");
    // 多个候选 → null
    await insertDept(db, "7", "1", "第二检测站", "检测站");
    config("");
    assert.equal(await resolveStation(db), null);
    // 配置优先于多候选：显式指定仍生效
    config("6");
    assert.equal(String((await resolveStation(db)).id), "6");
    await db.run("DELETE FROM sys_dept WHERE id='7'");
    // 检测站不在总公司子树（顶级）→ 不算候选
    await db.run("UPDATE sys_dept SET parent_id='0' WHERE id='6'");
    config("");
    assert.equal(await resolveStation(db), null);
    config("6");
    assert.equal(await resolveStation(db), null);
    await db.run("UPDATE sys_dept SET parent_id='1' WHERE id='6'");
    // 总公司自身不能作检测站
    await db.run("UPDATE sys_dept SET type='检测站' WHERE id='1'");
    config("1");
    assert.equal(await resolveStation(db), null);
    await db.run("UPDATE sys_dept SET type='公司' WHERE id='1'");
    config("");
    assert.equal(String((await resolveStation(db)).id), "6");
  } finally {
    applyBoxSettings({});
    await env.close();
  }
});

test("assertStationSavable（saveBox 校验）：存在/启用/类型/总公司子树/唯一，友好报错", async () => {
  const env = await tempDb("org-b1b-savable-");
  const { db } = env;
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "6", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    await insertDept(db, "21", "2", "调度室");
    // 合法
    await assertStationSavable(db, "6");
    // 清空不校验
    await assertStationSavable(db, "");
    // 不存在
    await assert.rejects(() => assertStationSavable(db, "999"), /不存在/);
    // 非检测站类型
    await assert.rejects(() => assertStationSavable(db, "2"), /不是检测站类型/);
    // 停用
    await db.run("UPDATE sys_dept SET status=0 WHERE id='6'");
    await assert.rejects(() => assertStationSavable(db, "6"), /已停用/);
    await db.run("UPDATE sys_dept SET status=1 WHERE id='6'");
    // 非总公司子树
    await db.run("UPDATE sys_dept SET parent_id='2' WHERE id='6'");
    await assert.rejects(() => assertStationSavable(db, "6"), /总公司子树/);
    await db.run("UPDATE sys_dept SET parent_id='1' WHERE id='6'");
    // 全局唯一冲突
    await insertDept(db, "7", "1", "第二检测站", "检测站");
    await assert.rejects(() => assertStationSavable(db, "6"), /全局唯一/);
  } finally {
    await env.close();
  }
});

/* ---------------- 总览四数（P13） ---------------- */

test("四数口径：moving 含 legacy 调拨/送检；arrivedTotal/openedTotal 累计跨日；unopenedNow/todayOpened；集团=单位同口径＋旧别名", async () => {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const env = await tempDb("org-b1b-overview-");
  const { db } = env;
  const boxes = new SqlBoxStore(db);
  const policies = new ReportPolicy(db);
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "6", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    await insertDept(db, "3", "0", "华东分公司");
    // 13 台探针箱（挂华南/华东，未使用）
    let seq = 0;
    const makeBox = async (orgId) => {
      seq += 1;
      const id = `8611999000${String(10000 + seq)}`;
      await db.run(
        "INSERT INTO sample_box (id,imei,org,org_id,owner,owner_id,life,name,activate_step,opens) VALUES (?,?,?,?,?,?,?,?,0,0)",
        [
          id,
          id,
          orgId === "2" ? "华南分公司" : "华东分公司",
          orgId,
          "—",
          "",
          "未使用",
          `探针箱${seq}`,
        ]
      );
      return id;
    };
    const task = async (kind, boxIds, status, { from = "2", inspect = true } = {}) => {
      const id = await policies.createTask({
        name: `四数-${kind}-${status}`,
        kind,
        boxIds,
        fromOrgId: from,
        fromOrg: from === "2" ? "华南分公司" : "华东分公司",
        toOrgId: "6",
        toOrg: "总部检测站",
        orgId: from,
        org: from === "2" ? "华南分公司" : "华东分公司",
        sender: "寄件人",
        signer: "检测站长",
        inspect,
      });
      await db.run("UPDATE sample_task SET status=? WHERE id=?", [status, id]);
      return id;
    };
    const inspectBox = async (taskId, boxId, when) =>
      db.run(
        "UPDATE sample_task_box SET inspected_at=?, inspected_by='检测员' WHERE task_id=? AND box_id=?",
        [when, taskId, boxId]
      );
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();

    // 在途：合并单 在途2台＋待签收1台；legacy 调拨 运送中2台；legacy 送检 运送中1台 → moving 6
    await task("采样", [await makeBox("2"), await makeBox("2")], "在途");
    await task("采样", [await makeBox("2")], "待签收");
    await task("调拨", [await makeBox("3"), await makeBox("3")], "运送中", { from: "3" });
    await task("送检", [await makeBox("3")], "运送中", { from: "3" });
    // 待检测2台：1台今日开箱、1台未开 → arrivedTotal2 openedTotal1 unopenedNow1 todayOpened1
    const t5 = await task("采样", [await makeBox("2"), await makeBox("2")], "待检测");
    const links5 = await db.all(
      "SELECT box_id FROM sample_task_box WHERE task_id=? ORDER BY box_id",
      [t5]
    );
    await inspectBox(t5, links5[0].box_id, today);
    // 已检测1台（昨日开箱）→ 累计到站/开箱各1，今日0
    const t6 = await task("采样", [await makeBox("2")], "已检测");
    await inspectBox(
      t6,
      (await db.get("SELECT box_id FROM sample_task_box WHERE task_id=?", [t6])).box_id,
      yesterday
    );
    // 退回中1台（昨日开箱）→ 累计到站/开箱各1
    const t7 = await task("采样", [await makeBox("2")], "退回中");
    await inspectBox(
      t7,
      (await db.get("SELECT box_id FROM sample_task_box WHERE task_id=?", [t7])).box_id,
      yesterday
    );
    // 已退回1台（未开箱）→ 累计到站1，不算当前未开箱（单已结束）
    await task("采样", [await makeBox("2")], "已退回");
    // 待采样1台 → 什么都不计
    await task("采样", [await makeBox("2")], "待采样");
    // legacy 调拨待检测1台（未开箱，华东寄出）→ arrivedTotal1 unopenedNow1
    await task("调拨", [await makeBox("3")], "待检测", { from: "3" });

    const expected = {
      moving: 6,
      arrivedTotal: 6,
      openedTotal: 3,
      unopenedNow: 2,
      todayOpened: 1,
      arrived: 2,
      inspected: 1,
    };
    const o = new OverviewController(boxes, db);
    const admin = {
      user: { id: "2", nickname: "管理员" },
      access: {
        perms: new Set(ALL_PERMS.map((p) => p.code)),
        scope: { all: true, orgIds: [], ownerIds: [] },
      },
    };
    // 集团侧
    const group = (await call(o.group.bind(o), { ...admin, query: {} })).data;
    const stationUnit = group.units.find((u) => u.id === "6");
    assert.equal(stationUnit.type, "检测站");
    assert.deepEqual(stationUnit.station, expected);
    assert.deepEqual(group.stationTotal, expected, "唯一检测站合计=单站");
    // 单位侧同口径
    const unit = (await call(o.unit.bind(o), { ...admin, params: { orgId: "6" }, query: {} })).data;
    for (const key of Object.keys(expected))
      assert.equal(unit.station[key], expected[key], `单位侧 ${key} 应与集团侧一致`);
    // 明细：待检测箱 2 台、今日已检测 1 台、在途单 4 张
    assert.equal(unit.station.boxes.waiting, 2);
    assert.equal(unit.station.boxes.done, 1);
    assert.equal(unit.station.boxes.inbound, 4);
    // 按来源公司：华南 moving3/到站5/开箱3/未开1/今开1；华东 moving3/到站1/未开1
    const south = unit.station.companies.find((c) => c.key === "2");
    const east = unit.station.companies.find((c) => c.key === "3");
    assert.deepEqual(
      {
        moving: south.moving,
        arrivedTotal: south.arrivedTotal,
        openedTotal: south.openedTotal,
        unopenedNow: south.unopenedNow,
        todayOpened: south.todayOpened,
      },
      { moving: 3, arrivedTotal: 5, openedTotal: 3, unopenedNow: 1, todayOpened: 1 }
    );
    assert.deepEqual(
      {
        moving: east.moving,
        arrivedTotal: east.arrivedTotal,
        openedTotal: east.openedTotal,
        unopenedNow: east.unopenedNow,
        todayOpened: east.todayOpened,
      },
      { moving: 3, arrivedTotal: 1, openedTotal: 0, unopenedNow: 1, todayOpened: 0 }
    );
    // company 筛选：counts 只算那一家（与列表同口径）
    const filtered = (
      await call(o.unit.bind(o), {
        ...admin,
        params: { orgId: "6" },
        query: { company: "3" },
      })
    ).data;
    assert.equal(filtered.station.moving, 3);
    assert.equal(filtered.station.arrivedTotal, 1);
    assert.equal(filtered.station.unopenedNow, 1);
    assert.equal(filtered.station.openedTotal, 0);
    // taskOptions：未配置时回退 DB 自动认定（B1b resolveStation），stationDeptId 回生效值
    applyBoxSettings({
      box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "" },
    });
    const c = new ReportPolicyController(boxes, policies);
    const opts = (
      await call(c.taskOptions.bind(c), {
        ...admin,
        access: {
          perms: new Set(upgradeCodes(["task:create:sample"])),
          scope: { all: true, orgIds: [], ownerIds: [] },
        },
        query: {},
      })
    ).data;
    assert.equal(opts.stationDeptId, "6");
    assert.equal(opts.station.id, "6");
  } finally {
    applyBoxSettings({});
    await boxes.flush();
    await env.close();
  }
});

test("056 ②b（B4a）：BRANCH_ADMIN/DISPATCH 幂等补 task:create:sample；默认码/模板同钉；自定义角色与 ADMIN 不动", async () => {
  // 默认码（新库 seedRolePerms 口径）：分公司自采建单是 P11 主路径
  assert.ok(DEFAULT_ROLE_PERMS.BRANCH_ADMIN.includes("task:create:sample"));
  assert.ok(DEFAULT_ROLE_PERMS.DISPATCH.includes("task:create:sample"));
  for (const key of ["BRANCH_ADMIN", "DISPATCH"]) {
    const template = ROLE_TEMPLATES.find((t) => t.key === key);
    assert.ok(template.codes.includes("task:create:sample"), `${key} 模板含建单码`);
  }
  const env = await tempDb("org-b4a-perm-");
  const { db } = env;
  try {
    // 存量旧形态：12 分公司管理员（有 sys:user:role → 补码可转授）、13 调度员（无授权码 → 不可转授）、
    // 80 自定义角色（持 create:sample 也不动）、2 ADMIN（按码短路不落行）
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('12','分公司管理员','BRANCH_ADMIN',2,6,1)"
    );
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('13','调度员','DISPATCH',2,7,1)"
    );
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('80','自定义','CUSTOM',2,80,1)"
    );
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('2','系统管理员','ADMIN',1,1,1)"
    );
    for (const perm of ["device:box:task", "sys:user:view", "sys:user:role"])
      await db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('12',?,1)", [perm]);
    for (const perm of ["device:box:task", "task:create:transfer"])
      await db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('13',?,0)", [perm]);
    await db.run(
      "INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('80','task:create:sample',0)"
    );
    await up056(db);
    const permsOf = async (rid) =>
      (await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id=?", [rid])).map(
        (r) => [String(r.perm), Number(r.grantable)]
      );
    const p12 = await permsOf("12");
    assert.ok(
      p12.some(([p]) => p === "task:create:sample"),
      "BRANCH_ADMIN 补码"
    );
    assert.equal(
      p12.find(([p]) => p === "task:create:sample")[1],
      1,
      "有 sys:user:role → 可转授（grantsAll 口径）"
    );
    const p13 = await permsOf("13");
    assert.ok(
      p13.some(([p]) => p === "task:create:sample"),
      "DISPATCH 补码"
    );
    assert.equal(p13.find(([p]) => p === "task:create:sample")[1], 0, "无授权码 → 不可转授");
    assert.deepEqual(await permsOf("80"), [["task:create:sample", 0]], "自定义角色不动");
    assert.deepEqual(await permsOf("2"), [], "ADMIN 不落行");
    // 幂等：重跑不重复补、不改已有行
    await up056(db);
    assert.deepEqual(await permsOf("12"), p12);
    assert.deepEqual(await permsOf("13"), p13);
    assert.equal(
      Number(
        (await db.get("SELECT COUNT(*) AS n FROM sys_role_perm WHERE perm='task:create:sample'")).n
      ),
      3,
      "全库恰 3 行（12/13/80），重跑不增"
    );
  } finally {
    await env.close();
  }
});

test("权限目录文案（B4a，B3 遗留③）：task:send-back 改合并流「寄出（寄检测站）」，采样待推进卡片不再写「寄回」", () => {
  const sendBack = TASK_PERMS.find((p) => p.code === "task:send-back");
  assert.equal(sendBack.label, "寄出（寄检测站）");
  assert.ok(sendBack.hint.includes("唯一检测站"), "描述写合并流去向");
  assert.ok(!sendBack.label.includes("寄回"), "旧「寄回」标签退役");
  const finish = TASK_PERMS.find((p) => p.code === "task:finish");
  assert.ok(finish.hint.includes("历史权限码保留"), "旧单向完成步标注只读保留");
  const samplingCard = CARD_PERMS.find((p) => p.code === "monitor:card:sampling");
  assert.ok(!samplingCard.hint.includes("寄回"), "卡片描述改合并流口径");
  assert.ok(samplingCard.hint.includes("检测站"));
  // 码本身不删（存量角色/部门上限仍引用）
  assert.ok(ALL_PERMS.some((p) => p.code === "task:send-back"));
  assert.ok(ALL_PERMS.some((p) => p.code === "task:finish"));
});

test("按日任务 to 口径（B4a，B3 遗留①）：合并采样单＝接收方检测站（与工作台 brief 同源），旧采样/调拨各按原口径", async () => {
  const env = await tempDb("org-b4a-daytask-");
  const { db } = env;
  const boxes = new SqlBoxStore(db);
  const policies = new ReportPolicy(db);
  try {
    await insertDept(db, "1", "0", "总公司");
    await insertDept(db, "6", "1", "总部检测站", "检测站");
    await insertDept(db, "2", "0", "华南分公司");
    let seq = 0;
    const makeBox = async () => {
      seq += 1;
      const id = `8611999000${String(20000 + seq)}`;
      await db.run(
        "INSERT INTO sample_box (id,imei,org,org_id,owner,owner_id,life,name,activate_step,opens) VALUES (?,?,?,?,?,?,?,?,0,0)",
        [id, id, "华南分公司", "2", "—", "", "未使用", `按日探针${seq}`]
      );
      return id;
    };
    const base = {
      fromOrgId: "2",
      fromOrg: "华南分公司",
      toOrgId: "6",
      toOrg: "总部检测站",
      orgId: "2",
      org: "华南分公司",
      sender: "寄件人",
      signer: "检测站长",
    };
    // 合并采样单（新建口径：无 trip、状态在合并流里）
    const merged = await policies.createTask({
      ...base,
      name: "按日-合并单",
      kind: "采样",
      boxIds: [await makeBox()],
      inspect: true,
    });
    await db.run("UPDATE sample_task SET status='在途' WHERE id=?", [merged]);
    // 旧双向采样单（trip 只读兼容）：to 仍＝采样单位
    const legacy = await policies.createTask({
      ...base,
      name: "按日-旧双向",
      kind: "采样",
      boxIds: [await makeBox()],
      inspect: true,
      trip: "双向",
    });
    await db.run("UPDATE sample_task SET status='待核验' WHERE id=?", [legacy]);
    // 旧调拨（只读兼容）：to＝接收单位
    const transfer = await policies.createTask({
      ...base,
      name: "按日-旧调拨",
      kind: "调拨",
      boxIds: [await makeBox()],
      inspect: true,
    });
    await db.run("UPDATE sample_task SET status='运送中' WHERE id=?", [transfer]);

    const o = new OverviewController(boxes, db);
    const admin = {
      user: { id: "2", nickname: "管理员" },
      access: {
        perms: new Set(ALL_PERMS.map((p) => p.code)),
        scope: { all: true, orgIds: [], ownerIds: [] },
      },
    };
    const day = new Date();
    const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    // 寄出分公司视角：三张单都相关（from/org 在子树）
    const unit = (
      await call(o.unit.bind(o), { ...admin, params: { orgId: "2" }, query: { day: dayStr } })
    ).data;
    const byId = new Map(unit.tasks.map((t) => [t.id, t]));
    assert.equal(byId.get(merged).to, "总部检测站", "合并单 to＝接收方（不再与 from 重复名）");
    assert.equal(byId.get(merged).from, "华南分公司");
    assert.equal(byId.get(legacy).to, "华南分公司", "旧双向采样单 to＝采样单位（只读兼容）");
    assert.equal(byId.get(transfer).to, "总部检测站", "旧调拨 to＝接收单位");
    // 检测站视角：合并单/调拨按 to_org_id 收录，to 同样是检测站
    const station = (
      await call(o.unit.bind(o), { ...admin, params: { orgId: "6" }, query: { day: dayStr } })
    ).data;
    const stationIds = new Set(station.tasks.map((t) => t.id));
    assert.ok(stationIds.has(merged) && stationIds.has(transfer));
    assert.equal(station.tasks.find((t) => t.id === merged).to, "总部检测站");
  } finally {
    await boxes.flush();
    await env.close();
  }
});

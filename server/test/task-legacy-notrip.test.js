/**
 * review-org M2 回归：旧无 trip 采样单读兼容（一次性临时库，不碰开发库/线上库，不占服务端口）。
 *
 * 背景：旧采样单建单从不写 inspect（恒 falsy），旧流 待采样→采样中→已封箱→在途→待核验→已签收。
 * 056 只映射 待核验→待检测、已签收/已完成→已检测，「在途」同名保留。改造前 isLegacySample 按
 * 状态名单识别，停共享态「在途」的旧无 trip 单被误判合并单：nextOf 给 待签收（应为 待核验）、
 * 全范围用户签收时 handOverBoxes 以 undefined 归属绑参→事务回滚 500、单子卡死。
 *
 * 守住：
 * 1. 旧无 trip 停「在途」：按旧流推进 待核验→已签收，不 500、不交接归属（箱子仍属采样单位）；
 * 2. 旧无 trip 停「待核验」：签收/拒收/取消分支可用；
 * 3. 056 映射子集（待核验→待检测，inspect 仍 falsy）：分公司（非全范围）能收尾 已检测/已拒收，
 *    不进合并单新退回分支；已签收/已完成→已检测 终态不再推进；
 * 4. 合并单（inspect=true）不受影响：签收仍交接归属给检测站；
 * 5. 056 映射后的旧送检（inspect=true）走合并流：7 步渲染＋签收交接；
 * 6. handOver 绑参兜底：inspect=true 但缺 toOrgId/toOrg 的异常单签收不 500，归属兜底原寄出单位。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { up as up056 } from "../migrations/056_org_simplify.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SAMPLE_FLOW, isLegacySample, nextOf, stepsOf } from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:opens",
  "device:box:lid",
  "device:box:status",
  "device:box:event",
  "task:create:sample",
  "task:sample-start",
  "task:seal",
  "task:send-back",
  "task:arrive",
  "task:sign",
  "task:reject",
  "task:reject-return",
  "task:accept-return",
  "task:force-sign",
  "task:inspect",
  "task:cancel",
  "task:policy",
]);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-notrip-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["6", "1", "总部检测站", "检测站"],
    ["2", "0", "华南分公司", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  for (const [id, nickname, deptId] of [
    ["20", "华南采样员", "2"],
    ["60", "检测站长", "6"],
  ])
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
      [id, `u${id}`, nickname, deptId]
    );
  const boxes = new SqlBoxStore(db);
  const policies = new ReportPolicy(db);
  const controller = new ReportPolicyController(boxes, policies);
  const ingest = new IngestService({
    boxes,
    policies,
    cache: new MemoryStateCache(),
    hub: { publish() {} },
    clock: { now: () => new Date() },
    parser: new UplinkParser(),
  });
  const ctx = (userId, orgIds) => ({
    user: { id: userId, nickname: `u${userId}`, dept_id: userId === "60" ? "6" : "2" },
    access: {
      perms: new Set(PERMS),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
      roles: [],
    },
    ip: "127.0.0.1",
  });
  const admin = ctx("20", null); // 全范围
  const south = ctx("20", ["2"]); // 分公司（非全范围）
  const stationCtx = ctx("60", ["1", "6"]);
  const run = async (fn, actor, extra = {}) => {
    let out;
    try {
      await fn({
        query: {},
        params: {},
        ...actor,
        ...extra,
        ok: (data, msg) => (out = { ok: true, data, msg }),
        fail: (msg, code, status) => (out = { ok: false, msg, code, status }),
      });
      return out;
    } catch (error) {
      return {
        ok: false,
        code: error.publicCode || "B0001",
        status: error.httpStatus || 500,
        message: error.message,
      };
    }
  };
  let imeiSeq = 0;
  let seq = 1;
  const makeBox = async (orgId = "2") => {
    imeiSeq += 1;
    const imei = `8643170809${String(30000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(
      packet({ imei, uart: `why=boot,opens=0,fw=1.0.16,seq=${seq++}` })
    );
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
      item.org = orgId === "2" ? "华南分公司" : "总部检测站";
    });
    return box.id;
  };
  /** 直插历史单（模拟迁移前存量）：旧无 trip 采样单 body 无 inspect/trip/fromOrgId/toOrgId。 */
  const insertLegacy = async (id, status, boxId, extraBody = {}, columns = {}) => {
    const body = {
      kind: "采样",
      name: `旧无trip-${id}`,
      boxIds: [boxId],
      orgId: "2",
      org: "华南分公司",
      sender: "华南采样员",
      place: "华南采样点",
      ...extraBody,
    };
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        id,
        body.name,
        "采样",
        status,
        JSON.stringify(body),
        new Date().toISOString(),
        columns.from ?? null,
        columns.to ?? null,
        columns.inspect ?? 0,
      ]
    );
    await db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
      [id, boxId, "2", ""]
    );
    await db.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [boxId, id]);
    await db.run("UPDATE sample_box SET life='在途' WHERE id=?", [boxId]);
    return body;
  };
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const boxRow = (id) => db.get("SELECT org_id,org,owner_id,life FROM sample_box WHERE id=?", [id]);
  const detail = (id, actor = admin) =>
    run(controller.taskDetail.bind(controller), actor, { params: { id } });
  const advance = async (id, status, actor = admin, note = "") => {
    const res = await run(controller.transition.bind(controller), actor, {
      params: { id },
      body: { status, note },
    });
    assert.ok(res.ok, `${id} → ${status} 失败：${res.code} ${res.message || res.msg}`);
    return res;
  };
  const teardown = async () => {
    applyBoxSettings({});
    await boxes.flush?.();
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    db,
    boxes,
    policies,
    controller,
    admin,
    south,
    stationCtx,
    run,
    makeBox,
    insertLegacy,
    taskRow,
    boxRow,
    detail,
    advance,
    teardown,
  };
}

test("M2：旧无 trip 采样单停「在途」——按旧流推进 待核验→已签收，不 500、归属不交接", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const id = "TK-legacy-transit";
    await s.insertLegacy(id, "在途", boxId);
    // 判别与推进集合：旧流 在途→待核验（不是合并单的 待签收）
    const body = JSON.parse((await s.taskRow(id)).body);
    assert.equal(isLegacySample({ ...body, status: "在途" }), true);
    assert.deepEqual(nextOf({ ...body, status: "在途" }, "在途"), ["待核验", "已取消"]);
    const d = await s.detail(id);
    assert.ok(d.ok, d.message);
    assert.deepEqual(d.data.task.steps, ["待采样", "采样中", "已封箱", "在途", "待核验", "已签收"]);
    assert.equal(d.data.can["待核验"], true);
    assert.equal(d.data.can["待签收"], undefined, "旧流没有合并单的待签收步");
    // 全范围用户推进＋签收：改造前这里 undefined 绑参→500 卡死
    await s.advance(id, "待核验");
    const sign = await s.advance(id, "已签收");
    assert.equal(sign.data.handOver, null, "旧采样单签收不做归属交接");
    assert.equal((await s.taskRow(id)).status, "已签收");
    const row = await s.boxRow(boxId);
    assert.equal(row.org_id, "2", "箱子仍属采样单位");
    assert.equal(row.life, "未使用", "终态释放占用");
    // 流转记录动作名沿用旧流
    const logs = await s.db.all(
      "SELECT action FROM sample_task_log WHERE task_id=? ORDER BY created_at,id",
      [id]
    );
    assert.deepEqual(logs.map((l) => l.action).slice(-2), ["到达核验点", "签收"]);
  } finally {
    await s.teardown();
  }
});

test("M2：旧无 trip 采样单停「待核验」——签收/拒收/取消分支可用", async () => {
  const s = await setup();
  try {
    // 签收
    const b1 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-verify", "待核验", b1);
    const d = await s.detail("TK-legacy-verify");
    assert.equal(d.data.can["已签收"], true);
    assert.equal(d.data.can["已拒收"], true);
    assert.equal(d.data.can["已取消"], true);
    await s.advance("TK-legacy-verify", "已签收");
    assert.equal((await s.boxRow(b1)).org_id, "2");
    // 拒收（原因由前端 NEEDS_REASON 强制，服务端仅对退回中强校验——旧单无退回分支）
    const b2 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-reject", "待核验", b2);
    await s.advance("TK-legacy-reject", "已拒收", s.admin, "样品破损");
    assert.equal((await s.taskRow("TK-legacy-reject")).status, "已拒收");
    assert.equal((await s.boxRow(b2)).life, "未使用");
    // 取消
    const b3 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-cancel", "待核验", b3);
    await s.advance("TK-legacy-cancel", "已取消");
    assert.equal((await s.boxRow(b3)).life, "未使用");
  } finally {
    await s.teardown();
  }
});

test("M2：056 映射子集（待核验→待检测，inspect 仍 falsy）——分公司非全范围可收尾，不进新退回分支", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-mapped", "待核验", b1);
    const b2 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-mapped-reject", "待核验", b2);
    const b3 = await s.makeBox("2");
    await s.insertLegacy("TK-legacy-mapped-done", "已签收", b3);
    // 真跑 056：待核验→待检测、已签收→已检测；旧建单 body 无 status 键（列才是权威），inspect 不写
    await up056(s.db);
    const mapped = await s.taskRow("TK-legacy-mapped");
    assert.equal(mapped.status, "待检测");
    assert.equal(JSON.parse(mapped.body).inspect, undefined);
    assert.equal((await s.taskRow("TK-legacy-mapped-done")).status, "已检测");
    // 分公司（非全范围）视角：合并流渲染检测段，能收尾；没有合并单的新退回分支
    const d = await s.detail("TK-legacy-mapped", s.south);
    assert.ok(d.ok, d.message);
    assert.deepEqual(d.data.task.steps, SAMPLE_FLOW);
    assert.equal(d.data.can["已检测"], true, "分公司可收尾（旧核验语义，home 放行）");
    assert.equal(d.data.can["已拒收"], true);
    assert.equal(d.data.can["已取消"], true);
    assert.equal(d.data.can["退回中"], undefined, "旧单不进合并单新退回分支");
    await s.advance("TK-legacy-mapped", "已检测", s.south);
    assert.equal((await s.taskRow("TK-legacy-mapped")).status, "已检测");
    const row = await s.boxRow(b1);
    assert.equal(row.org_id, "2", "收尾不交接归属");
    assert.equal(row.life, "未使用");
    // 拒收分支同样可收尾
    await s.advance("TK-legacy-mapped-reject", "已拒收", s.south, "样品不合格");
    assert.equal((await s.boxRow(b2)).life, "未使用");
    // 终态（已签收→已检测 映射像）不再推进
    const ended = await s.detail("TK-legacy-mapped-done", s.south);
    assert.deepEqual(ended.data.can, {});
  } finally {
    await s.teardown();
  }
});

test("M2：合并单不受影响——签收仍交接归属给检测站（inspect=true 判别）", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const created = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "合并单回归",
        kind: "采样",
        boxIds: [boxId],
        fromOrgId: "2",
        senderId: "20",
        signerId: "60",
        placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
      },
    });
    assert.ok(created.ok, created.message);
    const id = created.data.id;
    assert.equal(JSON.parse((await s.taskRow(id)).body).inspect, true);
    for (const status of ["采样中", "已封箱", "在途", "待签收"]) await s.advance(id, status);
    const sign = await s.advance(id, "待检测", s.stationCtx);
    assert.deepEqual(sign.data.handOver.moved, [boxId]);
    assert.equal((await s.boxRow(boxId)).org_id, "6");
    await s.advance(id, "已检测", s.stationCtx);
    assert.equal((await s.boxRow(boxId)).life, "未使用");
  } finally {
    await s.teardown();
  }
});

test("M2：056 映射后的旧送检（inspect=true）走合并流——7 步渲染＋签收交接", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    // 旧送检单：body.inspect=true（旧建单恒写），停 待签收
    await s.db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,1)",
      [
        "IN-legacy-mapped",
        "旧送检映射",
        "送检",
        "待签收",
        JSON.stringify({
          kind: "送检",
          name: "旧送检映射",
          inspect: true,
          boxIds: [boxId],
          fromOrgId: "2",
          fromOrg: "华南分公司",
          toOrgId: "6",
          toOrg: "总部检测站",
          orgId: "2",
          org: "华南分公司",
          signerId: "60",
          signer: "检测站长",
        }),
        new Date().toISOString(),
        "2",
        "6",
      ]
    );
    await s.db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
      ["IN-legacy-mapped", boxId, "2", ""]
    );
    await s.db.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [
      boxId,
      "IN-legacy-mapped",
    ]);
    await s.db.run("UPDATE sample_box SET life='在途' WHERE id=?", [boxId]);
    await up056(s.db);
    const row = await s.taskRow("IN-legacy-mapped");
    assert.equal(row.kind, "采样");
    assert.equal(row.status, "待签收", "送检 待签收 同名保留");
    assert.equal(JSON.parse(row.body).kind, "采样");
    assert.equal(JSON.parse(row.body).inspect, true);
    const d = await s.detail("IN-legacy-mapped", s.stationCtx);
    assert.deepEqual(d.data.task.steps, SAMPLE_FLOW);
    assert.equal(isLegacySample({ ...d.data.task }), false);
    assert.equal(d.data.can["待检测"], true);
    const sign = await s.advance("IN-legacy-mapped", "待检测", s.stationCtx);
    assert.deepEqual(sign.data.handOver.moved, [boxId]);
    assert.equal((await s.boxRow(boxId)).org_id, "6");
  } finally {
    await s.teardown();
  }
});

test("M2：handOver 绑参兜底——inspect=true 但缺 toOrgId/toOrg 的异常单签收不 500，归属兜底原寄出单位", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    // 异常数据：合并单形状（inspect=true）但 body 缺 toOrgId/toOrg（损坏/极旧），列 to_org_id 也为空
    await s.db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,1)",
      [
        "TK-anomaly-noorg",
        "异常缺接收方",
        "采样",
        "待签收",
        JSON.stringify({
          kind: "采样",
          name: "异常缺接收方",
          inspect: true,
          boxIds: [boxId],
          fromOrgId: "2",
          fromOrg: "华南分公司",
          orgId: "2",
          org: "华南分公司",
        }),
        new Date().toISOString(),
        "2",
        null,
      ]
    );
    await s.db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
      ["TK-anomaly-noorg", boxId, "2", ""]
    );
    await s.db.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [
      boxId,
      "TK-anomaly-noorg",
    ]);
    await s.db.run("UPDATE sample_box SET life='在途' WHERE id=?", [boxId]);
    // 改造前：handOverBoxes 绑 undefined org→node:sqlite 拒绝→事务回滚 500。兜底后正常落库。
    const sign = await s.advance("TK-anomaly-noorg", "待检测");
    assert.deepEqual(sign.data.handOver.moved, [boxId]);
    const row = await s.boxRow(boxId);
    assert.equal(row.org_id, "2", "缺接收方时兜底原寄出单位 fromOrg");
    assert.equal(row.org, "华南分公司");
    assert.equal((await s.taskRow("TK-anomaly-noorg")).status, "待检测");
  } finally {
    await s.teardown();
  }
});

test("M2：纯函数判别面——旧无 trip 各态/映射态/合并态/旧带 trip 态", () => {
  // 旧无 trip（inspect falsy）：共享态与旧专属态都是 legacy
  for (const status of [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待核验",
    "已签收",
    "已完成",
    "待执行",
    "执行中",
  ]) {
    assert.equal(isLegacySample({ kind: "采样", status }), true, `旧无trip ${status}`);
  }
  // 合并单（inspect=true）恒非 legacy；056 映射后的旧送检同形
  for (const status of [...SAMPLE_FLOW, "退回中", "已退回", "已拒收", "已取消"]) {
    assert.equal(isLegacySample({ kind: "采样", inspect: true, status }), false, `合并 ${status}`);
  }
  // 旧带 trip 恒 legacy（含旧双向 inspect=true）
  assert.equal(
    isLegacySample({ kind: "采样", trip: "双向", inspect: true, status: "待核验" }),
    true
  );
  assert.equal(isLegacySample({ kind: "采样", trip: "单向", status: "已完成" }), true);
  // 其他 kind 不受判别影响
  assert.equal(isLegacySample({ kind: "送检", status: "待签收" }), false);
  assert.equal(isLegacySample({ kind: "调拨", status: "待签收" }), false);
  // 旧无 trip 停在途：旧流渲染＋推进；映射态按合并流渲染、旧核验语义收尾
  assert.deepEqual(stepsOf({ kind: "采样", status: "在途" }).slice(-2), ["待核验", "已签收"]);
  assert.deepEqual(nextOf({ kind: "采样", status: "在途" }, "在途"), ["待核验", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", status: "待核验" }, "待核验"), [
    "已签收",
    "已拒收",
    "已取消",
  ]);
  assert.deepEqual(stepsOf({ kind: "采样", status: "待检测" }), SAMPLE_FLOW);
  assert.deepEqual(nextOf({ kind: "采样", status: "待检测" }, "待检测"), [
    "已检测",
    "已拒收",
    "已取消",
  ]);
  // 旧双向 inspect=true 的自然 待检测 仍按旧流（不受映射子句影响）
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向", inspect: true }, "待检测"), [
    "已检测",
    "已取消",
  ]);
});

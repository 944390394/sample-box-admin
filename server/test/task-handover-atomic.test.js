/**
 * R-5：签收与归属交接的原子性 + 跳过明细可见化。
 *
 * 修复前：policies.transition 先提交自己的事务，控制器 #handOver 在其后逐台调
 * boxes.updateBox（各自独立事务）——第 N 台失败会留下「已签收但归属只移了一半」，
 * 且 handOverSkipped 没有任何前端/小程序消费方，操作者只看到「签收成功」。
 *
 * 这里守住四条不变量：
 * 1. 交接中途注入失败 → 状态、归属、占用、生命周期、流转记录整体回滚，不留半成品；
 *    失败后重试能正常签收（没有卡死的状态）。
 * 2. 运送中直接扫码签收时失败：自动「确认到达」是独立的一步保留，签收与归属仍整体回滚。
 * 3. 跳过守卫语义不变（已改挂他单位/箱子已删除的跳过、不拉走），且跳过明细在
 *    签收响应（handOver.skipped）与任务详情读模型（handOver）里都可见，不依赖位置权限。
 * 4. 全部合格时 handOver.moved 给全量、skipped 为空；非签收步骤 handOver 为 null。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:event",
  "task:create:transfer",
  "task:send",
  "task:arrive",
  "task:sign",
  "task:reject",
  "task:force-sign",
  "task:cancel",
]);

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "handover-atomic-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name] of [
    ["2", "0", "A单位"],
    ["3", "0", "B单位"],
    ["4", "0", "C单位"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,?,?, ?,1,1)",
      [id, parent, name, `C${id}`]
    );
  const people = {
    a: { id: "101", nickname: "A单位员工", deptId: "2" },
    c: { id: "401", nickname: "C单位员工", deptId: "4" },
  };
  for (const p of Object.values(people))
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,'x','x',?,1)",
      [p.id, `u${p.id}`, p.deptId]
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
  const ctx = (person, orgIds, perms = PERMS) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: { perms: new Set(perms), scope: { all: false, orgIds, ownerIds: [] }, roles: [] },
    ip: "127.0.0.1",
  });
  const run = async (fn, ctx, extra = {}) => {
    let out;
    try {
      await fn({
        ...ctx,
        ...extra,
        ok: (data) => (out = { ok: true, data }),
        fail: () => (out = { ok: false }),
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
  const makeBox = async (imei, orgId) => {
    const { box } = await ingest.accept(packet({ imei, uart: "why=boot,opens=0,seq=1" }));
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
    });
    return box.id;
  };
  const boxRow = (id) => db.get("SELECT org_id,owner_id,life FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT status,body FROM sample_task WHERE id=?", [id]);
  const create = async (boxIds) => {
    const created = await run(controller.createTask.bind(controller), ctx(people.a, ["2"]), {
      body: {
        name: "调拨到C",
        kind: "调拨",
        fromOrgId: "2",
        toOrgId: "4",
        boxIds,
        senderId: "101",
        signerId: "401",
      },
    });
    assert.ok(created.ok, created.message);
    return created.data.id;
  };
  const advance = async (id, steps) => {
    for (const [actor, status] of steps) {
      const res = await run(controller.transition.bind(controller), actor, {
        params: { id },
        body: { status },
      });
      assert.ok(res.ok, `${status} 失败：${res.code} ${res.message}`);
    }
  };
  /**
   * 失败注入：包住事务会话的 run，命中指定箱子的归属 UPDATE 时抛错。
   * 只影响这一条语句，其余写入照常——模拟「第 N 台 updateBox 抛错」的并发删除/DB 抖动。
   */
  const injectHandOverFailure = (boxId) => {
    const original = db.transaction.bind(db);
    db.transaction = (fn) =>
      original(async (tx) => {
        const run = tx.run.bind(tx);
        tx.run = (sql, params = []) => {
          if (boxId && sql.startsWith("UPDATE sample_box SET org_id=") && params[4] === boxId)
            return Promise.reject(new Error("注入：归属写入失败"));
          return run(sql, params);
        };
        return fn(tx);
      });
    return () => {
      db.transaction = original;
    };
  };
  return {
    db,
    dir,
    boxes,
    controller,
    ctx,
    run,
    makeBox,
    boxRow,
    taskRow,
    people,
    create,
    advance,
    injectHandOverFailure,
  };
}

test("交接中途失败：状态与归属整体回滚，不留「已签收但半移归属」；重试可成功", async () => {
  const s = await setup();
  try {
    const first = await s.makeBox("864317080900101", "2");
    const middle = await s.makeBox("864317080900102", "2");
    const last = await s.makeBox("864317080900103", "2");
    const id = await s.create([first, middle, last]);
    await s.advance(id, [
      [s.ctx(s.people.a, ["2"]), "运送中"],
      [s.ctx(s.people.a, ["2"]), "待签收"],
    ]);
    const before = {
      status: (await s.taskRow(id)).status,
      boxes: await Promise.all([first, middle, last].map((b) => s.boxRow(b))),
      active: (await s.db.get("SELECT COUNT(*) AS n FROM box_active_task WHERE task_id=?", [id])).n,
      logs: (await s.db.get("SELECT COUNT(*) AS n FROM sample_task_log WHERE task_id=?", [id])).n,
    };
    assert.equal(before.status, "待签收");
    // 排序后逐台交接：第一台已写成、第二台抛错——修复前这里会留下半移归属
    const restore = s.injectHandOverFailure(middle);
    const failed = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    restore();
    assert.equal(failed.ok, false, "注入失败后签收不能成功");
    assert.equal((await s.taskRow(id)).status, "待签收", "状态必须回滚");
    for (const [index, boxId] of [first, middle, last].entries()) {
      assert.deepEqual(
        await s.boxRow(boxId),
        before.boxes[index],
        `${boxId} 归属/生命周期必须回滚`
      );
    }
    assert.equal(
      (await s.db.get("SELECT COUNT(*) AS n FROM box_active_task WHERE task_id=?", [id])).n,
      before.active,
      "占用登记必须回滚"
    );
    assert.equal(
      (await s.db.get("SELECT COUNT(*) AS n FROM sample_task_log WHERE task_id=?", [id])).n,
      before.logs,
      "不能留下签收流转记录"
    );
    // 没有半成品卡死：排除故障后重试，整单正常签收、全部改归属
    const retry = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    assert.ok(retry.ok, retry.message);
    assert.equal((await s.taskRow(id)).status, "已签收");
    for (const boxId of [first, middle, last]) {
      const row = await s.boxRow(boxId);
      assert.equal(row.org_id, "4");
      assert.equal(row.owner_id, "401", "签收人成为保管人");
    }
    assert.deepEqual(retry.data.handOver, { moved: [first, middle, last], skipped: [] });
    assert.deepEqual(retry.data.handOverSkipped, []);
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("运送中直接扫码签收失败：确认到达保留，签收与归属仍整体回滚", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("864317080900111", "2");
    const b = await s.makeBox("864317080900112", "2");
    const id = await s.create([a, b]);
    await s.advance(id, [[s.ctx(s.people.a, ["2"]), "运送中"]]);
    const restore = s.injectHandOverFailure(b);
    const failed = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    restore();
    assert.equal(failed.ok, false);
    // 自动「确认到达」是独立的一步（扫码事实已发生）：保留在待签收，不是半成品
    assert.equal((await s.taskRow(id)).status, "待签收");
    for (const boxId of [a, b]) {
      const row = await s.boxRow(boxId);
      assert.equal(row.org_id, "2", "归属不能动");
      assert.equal(row.owner_id, "");
    }
    const retry = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    assert.ok(retry.ok, retry.message);
    assert.equal((await s.taskRow(id)).status, "已签收");
    assert.equal((await s.boxRow(a)).org_id, "4");
    assert.equal((await s.boxRow(b)).org_id, "4");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("跳过的箱子：响应 handOver.skipped 与任务详情都可见，不依赖位置权限；守卫语义不变", async () => {
  const s = await setup();
  try {
    const staying = await s.makeBox("864317080900121", "2");
    const movedAway = await s.makeBox("864317080900122", "2");
    const deleted = await s.makeBox("864317080900123", "2");
    const id = await s.create([staying, movedAway, deleted]);
    await s.advance(id, [
      [s.ctx(s.people.a, ["2"]), "运送中"],
      [s.ctx(s.people.a, ["2"]), "待签收"],
    ]);
    // 建单后一台被 B 单位资产纠错改挂走；另一台档案被抹除删除
    await s.boxes.updateBox(movedAway, (item) => {
      item.orgId = "3";
    });
    await s.db.run("DELETE FROM sample_box WHERE id=?", [deleted]);
    const signed = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    assert.ok(signed.ok, signed.message);
    assert.equal((await s.taskRow(id)).status, "已签收");
    // 守卫语义不变：只带走还挂在寄出单位名下的
    assert.equal((await s.boxRow(staying)).org_id, "4");
    assert.equal((await s.boxRow(staying)).owner_id, "401");
    assert.equal((await s.boxRow(movedAway)).org_id, "3", "已改挂他单位的不能被带走");
    // 响应：新字段 handOver 给全量 moved/skipped，旧字段 handOverSkipped 兼容保留
    assert.deepEqual(signed.data.handOver, {
      moved: [staying],
      skipped: [
        { boxId: movedAway, reason: "已改挂到B单位" },
        { boxId: deleted, reason: "箱子已删除" },
      ],
    });
    assert.deepEqual(
      signed.data.handOverSkipped.map((item) => item.id),
      [movedAway, deleted]
    );
    // 操作日志有跳过汇总；运行日志逐台（hand-over-skipped）
    const summary = await s.db.get(
      "SELECT action FROM sys_operation_log WHERE target_id=? AND action LIKE '调拨签收跳过%'",
      [id]
    );
    assert.ok(summary, "跳过台数要进操作日志");
    // 任务详情：最近一次交接的 skipped 可见（含总数与经手人）
    const detail = await s.run(
      s.controller.taskDetail.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
      }
    );
    assert.ok(detail.ok, detail.message);
    assert.equal(detail.data.handOver.skippedCount, 2);
    assert.equal(detail.data.handOver.movedCount, 1);
    assert.deepEqual(detail.data.handOver.skipped, [
      { boxId: movedAway, reason: "已改挂到B单位" },
      { boxId: deleted, reason: "箱子已删除" },
    ]);
    assert.equal(detail.data.handOver.by, "C单位员工");
    assert.ok(detail.data.handOver.at);
    // 签收流转记录的 detail 里持久化了交接结果（有位置权限时随 logs 下发）
    const signLog = detail.data.logs.find((log) => log.action === "签收");
    assert.equal(signLog.detail.handOver.skippedCount, 2);
    // 没有位置权限：logs.detail 照旧遮挡，但交接警示不含位置、必须仍可见
    const noPlace = PERMS.filter((code) => code !== "device:box:location");
    const blind = await s.run(
      s.controller.taskDetail.bind(s.controller),
      s.ctx(s.people.c, ["4"], noPlace),
      { params: { id } }
    );
    assert.ok(blind.ok, blind.message);
    assert.equal(blind.data.handOver.skippedCount, 2);
    assert.deepEqual(blind.data.handOver.skipped, signed.data.handOver.skipped);
    assert.ok(blind.data.logs.every((log) => log.detail === null));
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("全部合格与未签收步骤：moved 全量、skipped 空；非签收步骤 handOver 为 null", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("864317080900131", "2");
    const b = await s.makeBox("864317080900132", "2");
    const id = await s.create([a, b]);
    const sent = await s.run(s.controller.transition.bind(s.controller), s.ctx(s.people.a, ["2"]), {
      params: { id },
      body: { status: "运送中" },
    });
    assert.ok(sent.ok, sent.message);
    assert.equal(sent.data.handOver, null, "非签收步骤不做交接");
    assert.deepEqual(sent.data.handOverSkipped, []);
    await s.advance(id, [[s.ctx(s.people.a, ["2"]), "待签收"]]);
    const signed = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    assert.ok(signed.ok, signed.message);
    assert.deepEqual(signed.data.handOver, { moved: [a, b], skipped: [] });
    const detail = await s.run(
      s.controller.taskDetail.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
      }
    );
    assert.ok(detail.ok, detail.message);
    assert.deepEqual(detail.data.handOver.skipped, []);
    assert.equal(detail.data.handOver.movedCount, 2);
    assert.equal(detail.data.handOver.skippedCount, 0);
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

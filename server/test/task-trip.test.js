import test from "node:test";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrate, openDatabase } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { nextOf, stepsOf } from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

async function call(fn, ctx) {
  let out;
  await fn({ ...ctx, ok: (data) => (out = data), fail: (message) => (out = { error: message }) });
  return out;
}

test("流程：采样单按寄送方式分步骤，旧单和调拨不变", () => {
  assert.deepEqual(stepsOf({ kind: "采样" }), [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待核验",
    "已签收",
  ]);
  assert.deepEqual(stepsOf({ kind: "采样", trip: "单向" }), [
    "待寄出",
    "运送中",
    "待采样",
    "采样中",
    "已封箱",
    "已完成",
  ]);
  assert.deepEqual(stepsOf({ kind: "采样", trip: "双向" }), [
    "待寄出",
    "运送中",
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待核验",
    "已签收",
  ]);
  assert.deepEqual(nextOf({ kind: "调拨" }, "运送中"), ["待签收", "已取消"]);
  assert.deepEqual(nextOf({ kind: "调拨" }, "待签收"), ["已签收", "已拒收", "退回中", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "单向" }, "运送中"), ["待采样", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "单向" }, "已封箱"), ["已完成", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向" }, "已封箱"), ["在途", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样" }, "已签收"), []);
  assert.deepEqual(nextOf({ kind: "采样" }, "待执行"), ["执行中", "已取消"]);
});

test("寄送采样单：寄出单位寄出，采样单位确认到达和采样；双向封箱后寄回寄出单位核验签收", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-trip-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    for (const [id, name, type] of [
      ["2", "总仓", "公司"],
      ["5", "检测机构甲", "采样机构"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, "0", name, `C${id}`, type]
      );
    }
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(
      packet({ uart: "why=boot,opens=0,seq=1", gpsfix: 1, lng: 114.1, lat: 22.6 })
    );
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
      b.orgId = "2";
      b.org = "总仓";
    });
    const c = new ReportPolicyController(boxes, policies);
    const perms = new Set(
      upgradeCodes(["device:box:task", "device:box:policyTask", "task:sign", "task:cancel"])
    );
    const admin = {
      user: { id: "1", nickname: "管理员" },
      access: { roles: ["ADMIN"], perms, scope: { all: true, orgIds: [], ownerIds: [] } },
    };
    // 采样机构的人：管不到总仓的箱子，只有签收权限
    const sampler = {
      user: { id: "9", nickname: "林夏" },
      access: {
        roles: [],
        perms: new Set(upgradeCodes(["device:box:task", "task:sign"])),
        scope: { all: false, orgIds: ["5"], ownerIds: [] },
      },
    };
    const base = {
      name: "寄送采样",
      kind: "采样",
      boxIds: [box.id],
      orgId: "5",
      fromOrgId: "2",
      sender: "张三",
      placeAt: { address: "机构甲", lng: 114.3, lat: 22.8 },
      fromPlace: { address: "总仓", lng: 114.1, lat: 22.6 },
    };

    await assert.rejects(
      call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "三向" } }),
      /单向或双向/
    );
    await assert.rejects(
      call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "单向", orgId: "2" } }),
      /不能相同/
    );
    await assert.rejects(
      call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "单向", sender: "" } }),
      /寄出人/
    );

    // 单向：寄到采样单位，封箱后完成
    const one = (await call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "单向" } }))
      .id;
    let detail = await call(c.taskDetail.bind(c), { ...admin, params: { id: one } });
    assert.equal(detail.task.status, "待寄出");
    assert.equal(detail.task.fromOrg, "总仓");
    assert.deepEqual(detail.task.steps, [
      "待寄出",
      "运送中",
      "待采样",
      "采样中",
      "已封箱",
      "已完成",
    ]);
    assert.equal(detail.target.role, "寄出地址");
    // 采样单位的人能看到这张单（箱子不归他管），但不能代寄出
    detail = await call(c.taskDetail.bind(c), { ...sampler, params: { id: one } });
    assert.equal(detail.can.运送中, false);
    await call(c.transition.bind(c), { ...admin, params: { id: one }, body: { status: "运送中" } });
    assert.equal(
      (await db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [box.id])).task_id,
      one
    );
    detail = await call(c.taskDetail.bind(c), { ...sampler, params: { id: one } });
    assert.equal(detail.target.role, "计划地点");
    assert.equal(detail.can.待采样, true);
    assert.equal((await c.todo(sampler)).arrive.total, 1);
    for (const status of ["待采样", "采样中", "已封箱", "已完成"]) {
      await call(c.transition.bind(c), { ...sampler, params: { id: one }, body: { status } });
    }
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id=?", [one])).status,
      "已完成"
    );
    assert.equal(
      await db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [box.id]),
      undefined
    );
    assert.equal((await boxes.findById(box.id)).life, "未使用");

    // 双向：封箱后寄回，寄出单位核验签收；采样单位不能替寄出单位签收
    const two = (await call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "双向" } }))
      .id;
    for (const [who, status] of [
      [admin, "运送中"],
      [sampler, "待采样"],
      [sampler, "采样中"],
      [sampler, "已封箱"],
      [sampler, "在途"],
    ]) {
      await call(c.transition.bind(c), { ...who, params: { id: two }, body: { status } });
    }
    detail = await call(c.taskDetail.bind(c), { ...admin, params: { id: two } });
    assert.equal(detail.target.role, "寄回地址");
    assert.equal(detail.can.待核验, true);
    assert.equal(
      (await call(c.taskDetail.bind(c), { ...sampler, params: { id: two } })).can.待核验,
      false
    );
    await call(c.transition.bind(c), { ...admin, params: { id: two }, body: { status: "待核验" } });
    await call(c.transition.bind(c), { ...admin, params: { id: two }, body: { status: "已签收" } });
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id=?", [two])).status,
      "已签收"
    );
    // 采样单不改箱子归属
    assert.equal((await boxes.findById(box.id)).orgId, "2");

    // 封箱后又开箱：签收核验列为异常，不能直接签收；可以拒收（样品作废）
    const three = (await call(c.createTask.bind(c), { ...admin, body: { ...base, trip: "双向" } }))
      .id;
    for (const [who, status] of [
      [admin, "运送中"],
      [sampler, "待采样"],
      [sampler, "采样中"],
    ]) {
      await call(c.transition.bind(c), { ...who, params: { id: three }, body: { status } });
    }
    await ingest.accept(
      packet({ uart: "why=pad,opens=1,seq=2", gpsfix: 1, lng: 114.3, lat: 22.8 })
    );
    await call(c.transition.bind(c), {
      ...sampler,
      params: { id: three },
      body: { status: "已封箱" },
    });
    detail = await call(c.taskDetail.bind(c), { ...admin, params: { id: three } });
    assert.equal(detail.boxes[0].opensDuring, 1);
    assert.equal(detail.boxes[0].opensAfterSeal, 0);
    await ingest.accept(
      packet({ uart: "why=pad,opens=2,seq=3", gpsfix: 1, lng: 114.3, lat: 22.8 })
    );
    for (const [who, status] of [
      [sampler, "在途"],
      [admin, "待核验"],
    ]) {
      await call(c.transition.bind(c), { ...who, params: { id: three }, body: { status } });
    }
    detail = await call(c.taskDetail.bind(c), { ...admin, params: { id: three } });
    assert.equal(detail.boxes[0].opensAfterSeal, 1);
    // 这里的管理员没有「查看开箱次数」，只说开过、不给次数
    assert.match(detail.check.problems.map((p) => p.text).join("；"), /封箱后又开过箱/);
    await assert.rejects(
      call(c.transition.bind(c), { ...admin, params: { id: three }, body: { status: "已签收" } }),
      /封箱后又开过箱/
    );
    await call(c.transition.bind(c), {
      ...admin,
      params: { id: three },
      body: { status: "已拒收", note: "封箱后被打开，样品作废" },
    });
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id=?", [three])).status,
      "已拒收"
    );
    assert.equal((await boxes.findById(box.id)).life, "未使用");
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

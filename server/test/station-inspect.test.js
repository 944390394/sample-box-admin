import test from "node:test";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { IngestService } from "../src/service/IngestService.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { OverviewController } from "../src/http/OverviewController.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { nextOf, stepsOf } from "../src/settings/taskFlow.js";
import { packet } from "./fixture.js";

const ALL = [
  "device:box:task",
  "device:box:list",
  "device:box:policyTask",
  "device:box:location",
  "device:box:policyRead",
  "task:sign",
  "task:cancel",
];
const ctxOf = (orgIds, perms = ALL, user = { id: "9", nickname: "测试员" }) => ({
  user,
  access: {
    perms: new Set(upgradeCodes(perms)),
    scope: orgIds ? { all: false, orgIds, ownerIds: [] } : { all: true, orgIds: [], ownerIds: [] },
  },
});
async function call(fn, ctx) {
  let out;
  await fn({
    query: {},
    params: {},
    ...ctx,
    ok: (d) => (out = d),
    fail: (m) => (out = { error: m }),
  });
  return out;
}

test("流程：送检测站的单签收后待检测、全部开始检测后已检测；双向寄回检测站时待核验可拒收", () => {
  assert.deepEqual(stepsOf({ kind: "调拨", inspect: true }), [
    "待寄出",
    "运送中",
    "待签收",
    "待检测",
    "已检测",
  ]);
  assert.deepEqual(stepsOf({ kind: "调拨" }), ["待寄出", "运送中", "待签收", "已签收"]);
  assert.deepEqual(nextOf({ kind: "调拨", inspect: true }, "待签收"), [
    "待检测",
    "已拒收",
    "退回中",
    "已取消",
  ]);
  assert.deepEqual(stepsOf({ kind: "调拨", status: "退回中" }), [
    "待寄出",
    "运送中",
    "待签收",
    "退回中",
    "已退回",
  ]);
  assert.deepEqual(nextOf({ kind: "调拨" }, "退回中"), ["已退回"]);
  assert.deepEqual(nextOf({ kind: "调拨", inspect: true }, "待检测"), ["已检测", "已取消"]);
  assert.deepEqual(nextOf({ kind: "调拨", inspect: true }, "已检测"), []);
  assert.deepEqual(stepsOf({ kind: "采样", trip: "双向", inspect: true }).slice(-4), [
    "在途",
    "待核验",
    "待检测",
    "已检测",
  ]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向", inspect: true }, "待核验"), [
    "待检测",
    "已拒收",
    "已取消",
  ]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向" }, "待核验"), [
    "已签收",
    "已拒收",
    "已取消",
  ]);
  // 旧采样单（箱子本来就在采样单位）寄回核验时同样可以拒收作废
  assert.deepEqual(nextOf({ kind: "采样" }, "待核验"), ["已签收", "已拒收", "已取消"]);
});

test("检测站：扫码签收后逐台开始检测，开箱次数定在签收那刻、箱子随即可用；总览按单位统计在途、待检测、已检测", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "station-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, parent, name, type] of [
      ["1", "0", "总公司", "公司"],
      ["6", "1", "总部检测站", "采样机构"],
      ["2", "0", "华南分公司", "公司"],
      ["21", "2", "调度室", "公司"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, parent, name, `C${id}`, type]
      );
    }
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('60','s1','检测员','x','6',1)"
    );
    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const imeiB = "864317080992518";
    const { box: a } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.16,seq=1" }));
    const { box: b } = await ingest.accept(
      packet({ imei: imeiB, uart: "why=boot,opens=0,fw=1.0.16,seq=1" })
    );
    for (const id of [a.id, b.id])
      await boxes.updateBox(id, (x) => {
        x.life = "未使用";
        x.org = "华南分公司";
        x.orgId = "2";
      });

    const c = new ReportPolicyController(boxes, policies);
    const o = new OverviewController(boxes, db);
    const south = ctxOf(["2", "21"]);
    const station = ctxOf(
      ["1", "6"],
      ["device:box:task", "device:box:list", "device:box:location", "task:sign"],
      { id: "60", nickname: "检测员" }
    );

    const { id } = await call(c.createTask.bind(c), {
      ...south,
      body: {
        name: "送检",
        kind: "调拨",
        boxIds: [a.id, b.id],
        fromOrgId: "2",
        toOrgId: "6",
        sender: "华南寄件人",
        signerId: "60",
        maxOpens: 2,
      },
    });
    let detail = await call(c.taskDetail.bind(c), { ...station, params: { id } });
    assert.equal(detail.task.inspect, true);
    assert.deepEqual(detail.task.steps, ["待寄出", "运送中", "待签收", "待检测", "已检测"]);

    // 不送检测站的单照旧到「已签收」结束
    const plain = await call(c.createTask.bind(c), {
      ...ctxOf(null),
      body: {
        name: "普通调拨",
        kind: "调拨",
        boxIds: [],
        fromOrgId: "1",
        toOrgId: "2",
        sender: "x",
        signer: "y",
      },
    }).catch((e) => ({ error: e.message }));
    assert.match(String(plain.error || ""), /箱子|1–10000/);

    await call(c.transition.bind(c), { ...south, params: { id }, body: { status: "运送中" } });
    // 途中开了一次箱
    await ingest.accept(packet({ uart: "why=pad,opens=1,seq=2" }));
    let group = await call(o.group.bind(o), { ...ctxOf(null) });
    assert.deepEqual(
      group.units.map((u) => [u.name, u.type]),
      [
        ["总公司", "公司"],
        ["总部检测站", "采样机构"],
        ["华南分公司", "公司"],
      ]
    );
    assert.deepEqual(group.units.find((u) => u.id === "6").station, {
      moving: 2,
      arrived: 0,
      inspected: 0,
    });
    // 分公司的人只看到自己
    const own = await call(o.group.bind(o), { ...south });
    assert.deepEqual(
      own.units.map((u) => u.name),
      ["华南分公司"]
    );
    await assert.rejects(
      call(o.unit.bind(o), { ...south, params: { orgId: "6" } }),
      /不在你的数据范围/
    );

    // 检测站：确认到达、扫码看到开箱次数后签收
    await call(c.transition.bind(c), { ...station, params: { id }, body: { status: "待签收" } });
    let scan = await call(c.scan.bind(c), { ...station, params: { id: a.id } });
    assert.equal(scan.tasks[0].opensDuring, 1);
    assert.equal(scan.tasks[0].maxOpens, 2);
    assert.equal(scan.tasks[0].can["待检测"], true);
    assert.equal(scan.tasks[0].can["已拒收"], true);
    await call(c.transition.bind(c), { ...station, params: { id }, body: { status: "待检测" } });
    assert.equal((await boxes.findById(a.id)).orgId, "6");
    // 检测时开箱：不算进本次任务
    await ingest.accept(packet({ uart: "why=pad,opens=2,seq=3" }));

    let unit = await call(o.unit.bind(o), { ...station, params: { orgId: "6" }, query: {} });
    assert.equal(unit.unit.type, "采样机构");
    assert.equal(unit.station.arrived, 2);
    assert.equal(unit.station.waiting.find((w) => w.boxId === a.id).opensDuring, 1);
    assert.equal(unit.tasks.length, 1);
    assert.ok(Object.values(unit.calendar).some((n) => n >= 1));

    // 寄出方不能开始检测
    await assert.rejects(
      call(c.inspect.bind(c), { ...south, params: { id, boxId: a.id } }),
      /检测站/
    );
    scan = await call(c.scan.bind(c), { ...station, params: { id: a.id } });
    assert.equal(scan.tasks[0].can["开始检测"], true);
    const first = await call(c.inspect.bind(c), { ...station, params: { id, boxId: a.id } });
    assert.deepEqual(first, { done: false, left: 1 });
    await assert.rejects(
      call(c.inspect.bind(c), { ...station, params: { id, boxId: a.id } }),
      /已经开始检测/
    );
    // 这台箱子的本次任务结束：不再占用，回到未使用，可以再建单
    assert.equal((await boxes.findById(a.id)).life, "未使用");
    assert.equal(
      await db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [a.id]),
      undefined
    );
    scan = await call(c.scan.bind(c), { ...station, params: { id: a.id } });
    assert.equal(scan.tasks[0].active, false);
    detail = await call(c.taskDetail.bind(c), { ...station, params: { id } });
    assert.equal(detail.task.status, "待检测");
    assert.equal(detail.boxes.find((x) => x.id === a.id).opensDuring, 1);
    assert.ok(detail.boxes.find((x) => x.id === a.id).inspectedAt);
    assert.equal(detail.boxes.find((x) => x.id === b.id).inspectedAt, "");

    unit = await call(o.unit.bind(o), { ...station, params: { orgId: "6" }, query: {} });
    assert.equal(unit.station.arrived, 1);
    assert.equal(unit.station.inspected, 1);
    assert.equal(unit.station.done[0].inspectedBy, "检测员");

    // 最后一台开始检测：整张单变「已检测」，箱子都回到未使用
    const last = await call(c.inspect.bind(c), { ...station, params: { id, boxId: b.id } });
    assert.deepEqual(last, { done: true, left: 0 });
    detail = await call(c.taskDetail.bind(c), { ...station, params: { id } });
    assert.equal(detail.task.status, "已检测");
    assert.deepEqual(
      detail.logs.slice(-3).map((l) => l.action),
      ["开始检测", "开始检测", "检测完成"]
    );
    assert.equal((await boxes.findById(b.id)).life, "未使用");
    const again = await call(c.createTask.bind(c), {
      ...ctxOf(null),
      body: { name: "下一单", kind: "采样", boxIds: [a.id, b.id] },
    });
    assert.ok(again.id);
    group = await call(o.group.bind(o), { ...ctxOf(null) });
    assert.deepEqual(group.units.find((u) => u.id === "6").station, {
      moving: 0,
      arrived: 0,
      inspected: 2,
    });
    const list = await call(c.tasks.bind(c), { ...station, query: { status: "已结束" } });
    assert.deepEqual(
      list.list.map((t) => t.status),
      ["已检测"]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("检测站整张单一起开始检测、拒收照旧结束", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "station-all-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, parent, name, type] of [
      ["2", "0", "华南分公司", "公司"],
      ["6", "0", "检测站", "采样机构"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, parent, name, `C${id}`, type]
      );
    }
    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.16,seq=1" }));
    await boxes.updateBox(box.id, (x) => {
      x.life = "未使用";
      x.org = "华南分公司";
      x.orgId = "2";
    });
    const c = new ReportPolicyController(boxes, policies);
    const admin = ctxOf(null);
    const body = {
      kind: "调拨",
      boxIds: [box.id],
      fromOrgId: "2",
      toOrgId: "6",
      sender: "寄件人",
      signer: "检测站",
    };
    const { id } = await call(c.createTask.bind(c), { ...admin, body: { ...body, name: "整单" } });
    for (const status of ["运送中", "待签收", "待检测", "已检测"])
      await call(c.transition.bind(c), { ...admin, params: { id }, body: { status } });
    const detail = await call(c.taskDetail.bind(c), { ...admin, params: { id } });
    assert.equal(detail.task.status, "已检测");
    assert.ok(detail.boxes[0].inspectedAt);
    assert.equal((await boxes.findById(box.id)).life, "未使用");
    // 第一张单签收时箱子已改归检测站；拒收不改归属
    await boxes.updateBox(box.id, (x) => {
      x.org = "华南分公司";
      x.orgId = "2";
    });
    const rejected = await call(c.createTask.bind(c), {
      ...admin,
      body: { ...body, name: "拒收" },
    });
    for (const status of ["运送中", "待签收", "已拒收"])
      await call(c.transition.bind(c), {
        ...admin,
        params: { id: rejected.id },
        body: { status, note: "开箱次数不对" },
      });
    assert.equal((await boxes.findById(box.id)).life, "未使用");
    assert.equal((await boxes.findById(box.id)).orgId, "2");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("开箱超限作废：强制签收后超限的箱子不能开始检测，其余检测完整张单结束、作废的箱子一起回到未使用", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "station-void-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, parent, name, type] of [
      ["2", "0", "华南分公司", "公司"],
      ["6", "0", "检测站", "采样机构"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, parent, name, `C${id}`, type]
      );
    }
    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const imeiB = "864317080992518";
    const { box: a } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.16,seq=1" }));
    const { box: b } = await ingest.accept(
      packet({ imei: imeiB, uart: "why=boot,opens=0,fw=1.0.16,seq=1" })
    );
    for (const id of [a.id, b.id])
      await boxes.updateBox(id, (x) => {
        x.life = "未使用";
        x.org = "华南分公司";
        x.orgId = "2";
      });
    const c = new ReportPolicyController(boxes, policies);
    const admin = ctxOf(null);
    const { id } = await call(c.createTask.bind(c), {
      ...admin,
      body: {
        name: "超限",
        kind: "调拨",
        boxIds: [a.id, b.id],
        fromOrgId: "2",
        toOrgId: "6",
        sender: "寄件人",
        signer: "检测站",
        maxOpens: 2,
      },
    });
    for (const status of ["运送中", "待签收"])
      await call(c.transition.bind(c), { ...admin, params: { id }, body: { status } });
    // B 途中开了 3 次，超过上限
    await ingest.accept(packet({ imei: imeiB, uart: "why=pad,opens=3,seq=2" }));
    await assert.rejects(
      call(c.transition.bind(c), { ...admin, params: { id }, body: { status: "待检测" } }),
      /强制签收/
    );
    await call(c.transition.bind(c), {
      ...admin,
      params: { id },
      body: { status: "强制签收", note: "现场确认" },
    });
    let detail = await call(c.taskDetail.bind(c), { ...admin, params: { id } });
    assert.equal(detail.boxes.find((x) => x.id === b.id).voided, true);
    assert.equal(detail.boxes.find((x) => x.id === a.id).voided, false);
    await assert.rejects(
      call(c.inspect.bind(c), { ...admin, params: { id, boxId: b.id } }),
      /作废/
    );
    const done = await call(c.inspect.bind(c), { ...admin, params: { id, boxId: a.id } });
    assert.deepEqual(done, { done: true, left: 0 });
    detail = await call(c.taskDetail.bind(c), { ...admin, params: { id } });
    assert.equal(detail.task.status, "已检测");
    assert.equal(detail.boxes.find((x) => x.id === b.id).inspectedAt, "");
    assert.match(detail.logs.at(-1).note, /1 台开箱超限作废/);
    for (const box of [a, b]) assert.equal((await boxes.findById(box.id)).life, "未使用");
    assert.equal(
      await db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [b.id]),
      undefined
    );

    // 整张单一起开始检测：同样跳过作废的箱子
    for (const box of [a, b])
      await boxes.updateBox(box.id, (x) => {
        x.org = "华南分公司";
        x.orgId = "2";
      });
    const whole = await call(c.createTask.bind(c), {
      ...admin,
      body: {
        name: "整单超限",
        kind: "调拨",
        boxIds: [a.id, b.id],
        fromOrgId: "2",
        toOrgId: "6",
        sender: "寄件人",
        signer: "检测站",
        maxOpens: 0,
      },
    });
    for (const status of ["运送中", "待签收"])
      await call(c.transition.bind(c), { ...admin, params: { id: whole.id }, body: { status } });
    await ingest.accept(packet({ imei: imeiB, uart: "why=pad,opens=4,seq=3" }));
    await call(c.transition.bind(c), {
      ...admin,
      params: { id: whole.id },
      body: { status: "强制签收", note: "现场确认" },
    });
    await call(c.transition.bind(c), {
      ...admin,
      params: { id: whole.id },
      body: { status: "已检测" },
    });
    detail = await call(c.taskDetail.bind(c), { ...admin, params: { id: whole.id } });
    assert.ok(detail.boxes.find((x) => x.id === a.id).inspectedAt);
    assert.equal(detail.boxes.find((x) => x.id === b.id).inspectedAt, "");
    for (const box of [a, b]) assert.equal((await boxes.findById(box.id)).life, "未使用");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("签收核验：开箱超限、离收货点远、箱盖开着时不能直接签收，只能拒收或强制签收；拒收可退回寄出单位，寄出方只能接收", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "receive-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, parent, name, type] of [
      ["2", "0", "华南分公司", "公司"],
      ["21", "2", "调度室", "公司"],
      ["6", "0", "检测站", "采样机构"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, parent, name, `C${id}`, type]
      );
    }
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('60','s1','检测员','x','6',1)"
    );
    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(packet({ uart: "why=boot,opens=0,lid=0,fw=1.0.16,seq=1" }));
    // 箱子在检测站门口（收货地址附近）
    await boxes.updateBox(box.id, (x) => {
      x.life = "未使用";
      x.org = "华南分公司";
      x.orgId = "2";
      x.lbsLng = 114.0579;
      x.lbsLat = 22.5431;
    });
    const c = new ReportPolicyController(boxes, policies);
    const south = ctxOf(["2", "21"]);
    const station = ctxOf(
      ["6"],
      [
        "device:box:task",
        "device:box:list",
        "device:box:location",
        "device:box:status",
        "task:sign",
      ],
      { id: "60", nickname: "检测员" }
    );
    const body = {
      kind: "调拨",
      boxIds: [box.id],
      fromOrgId: "2",
      toOrgId: "6",
      sender: "寄件人",
      signerId: "60",
      maxOpens: 2,
      fromPlace: { address: "华南仓库", lng: 114.1175, lat: 22.6795 },
      toPlace: { address: "检测站收发室", lng: 114.0579, lat: 22.5431 },
    };

    // 正常：运送中直接扫码签收（自动补一笔确认到达）
    const ok = await call(c.createTask.bind(c), { ...south, body: { ...body, name: "正常" } });
    await call(c.transition.bind(c), {
      ...south,
      params: { id: ok.id },
      body: { status: "运送中" },
    });
    let scan = await call(c.scan.bind(c), { ...station, params: { id: box.id } });
    assert.equal(scan.tasks[0].receive, "sign");
    let view = await call(c.receive.bind(c), {
      ...station,
      params: { id: ok.id },
      query: { boxId: box.id },
    });
    assert.equal(view.mode, "sign");
    assert.deepEqual(view.check.problems, []);
    assert.equal(view.check.boxes[0].near, true);
    assert.equal(view.can["待检测"], true);
    await call(c.transition.bind(c), {
      ...station,
      params: { id: ok.id },
      body: { status: "待检测" },
    });
    let detail = await call(c.taskDetail.bind(c), { ...station, params: { id: ok.id } });
    assert.equal(detail.task.status, "待检测");
    assert.deepEqual(
      detail.logs.slice(-2).map((l) => l.action),
      ["确认到达", "签收"]
    );
    await call(c.transition.bind(c), {
      ...station,
      params: { id: ok.id },
      body: { status: "已检测" },
    });

    // 有问题：开了 3 次箱、箱盖开着 → 不能直接签收
    await boxes.updateBox(box.id, (x) => {
      x.org = "华南分公司";
      x.orgId = "2";
    });
    const bad = await call(c.createTask.bind(c), { ...south, body: { ...body, name: "异常" } });
    await call(c.transition.bind(c), {
      ...south,
      params: { id: bad.id },
      body: { status: "运送中" },
    });
    await ingest.accept(packet({ uart: "why=pad,opens=3,lid=1,seq=2" }));
    view = await call(c.receive.bind(c), {
      ...station,
      params: { id: bad.id },
      query: { boxId: box.id },
    });
    assert.deepEqual(
      view.check.problems.map((p) => p.text),
      ["开箱 3 次，超过上限 2 次", "箱盖开着"]
    );
    assert.equal(view.can["待检测"], false);
    assert.equal(view.can["强制签收"], true);
    assert.equal(view.can["已拒收"], true);
    assert.equal(view.can["退回中"], true);
    await assert.rejects(
      call(c.transition.bind(c), {
        ...station,
        params: { id: bad.id },
        body: { status: "待检测" },
      }),
      /有异常.*只能拒收或强制签收/
    );
    await assert.rejects(
      call(c.transition.bind(c), {
        ...station,
        params: { id: bad.id },
        body: { status: "退回中" },
      }),
      /拒收原因/
    );

    // 拒收并退回：加返程，寄出方扫码只能接收
    await call(c.transition.bind(c), {
      ...station,
      params: { id: bad.id },
      body: { status: "退回中", note: "开箱次数不对" },
    });
    detail = await call(c.taskDetail.bind(c), { ...south, params: { id: bad.id } });
    assert.equal(detail.task.status, "退回中");
    assert.deepEqual(detail.task.steps, ["待寄出", "运送中", "待签收", "退回中", "已退回"]);
    assert.equal(detail.target.role, "寄出地址");
    assert.equal((await boxes.findById(box.id)).orgId, "2");
    assert.equal((await boxes.findById(box.id)).life, "在途");
    scan = await call(c.scan.bind(c), { ...station, params: { id: box.id } });
    assert.equal(scan.tasks[0].receive, "none");
    scan = await call(c.scan.bind(c), { ...south, params: { id: box.id } });
    assert.equal(scan.tasks[0].receive, "return");
    view = await call(c.receive.bind(c), {
      ...south,
      params: { id: bad.id },
      query: { boxId: box.id },
    });
    assert.equal(view.mode, "return");
    assert.deepEqual(
      Object.entries(view.can)
        .filter(([, v]) => v)
        .map(([k]) => k),
      ["已退回"]
    );
    await assert.rejects(
      call(c.transition.bind(c), {
        ...station,
        params: { id: bad.id },
        body: { status: "已退回" },
      }),
      /权限/
    );
    await call(c.transition.bind(c), {
      ...south,
      params: { id: bad.id },
      body: { status: "已退回" },
    });
    detail = await call(c.taskDetail.bind(c), { ...south, params: { id: bad.id } });
    assert.equal(detail.task.status, "已退回");
    assert.deepEqual(
      detail.logs.slice(-3).map((l) => l.action),
      ["确认到达", "拒收并退回", "接收退回"]
    );
    assert.equal((await boxes.findById(box.id)).life, "未使用");

    // 强制签收：有问题也能签，要写原因
    await ingest.accept(packet({ uart: "why=shut,opens=3,lid=0,seq=3" }));
    const forced = await call(c.createTask.bind(c), {
      ...south,
      body: { ...body, name: "强制", maxOpens: 0 },
    });
    await call(c.transition.bind(c), {
      ...south,
      params: { id: forced.id },
      body: { status: "运送中" },
    });
    await ingest.accept(packet({ uart: "why=pad,opens=4,lid=1,seq=4" }));
    await assert.rejects(
      call(c.transition.bind(c), {
        ...station,
        params: { id: forced.id },
        body: { status: "强制签收" },
      }),
      /原因/
    );
    await call(c.transition.bind(c), {
      ...station,
      params: { id: forced.id },
      body: { status: "强制签收", note: "现场确认样品完好" },
    });
    detail = await call(c.taskDetail.bind(c), { ...station, params: { id: forced.id } });
    assert.equal(detail.task.status, "待检测");
    assert.equal(detail.logs.at(-1).action, "强制签收");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

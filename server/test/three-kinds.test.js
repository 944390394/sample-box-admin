/**
 * R23 三类型（任务 #56）服务端契约：采样（仅本地）/送检（仅寄送）/采样后送检（合并全流）。
 * 一次性临时库，不碰开发/线上库、不占服务端口。守住：
 * 1. 状态机：本地 3 步已封箱终态、送检 5 步、采样后送检合并 7/9 步；
 * 2. 建单字段必需性：送检无采样段、本地无检测站接收；权限码兜底；
 * 3. 本地全流：封箱即终态、箱子释放可复用、无归属交接；
 * 4. 送检全流：寄出→签收交接归属→逐台检测；拒收/退回分支；
 * 5. 060 回填矩阵（按 _bak_org_simplify_task 原 kind）＋幂等＋_bak_060 留底＋调拨/划拨不动。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import {
  SAMPLE_LOCAL_FLOW,
  INSPECT_FLOW,
  SAMPLE_FLOW,
  stepsOf,
  nextOf,
  initialOf,
  isEndedFor,
  isLocalSample,
  isMergedSample,
  isLegacySample,
  prefixOf,
} from "../src/settings/taskFlow.js";
import { up as up060 } from "../migrations/060_three_kinds.js";
import { packet } from "./fixture.js";

const PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:opens",
  "device:box:lid",
  "device:box:status",
  "task:create:sample",
  "task:create:inspect",
  "task:sample-start",
  "task:seal",
  "task:send-back",
  "task:send",
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
const ORG_NAMES = { 1: "总公司", 2: "华南分公司", 6: "总部检测站", 21: "调度室" };

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "three-kinds-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["6", "1", "总部检测站", "检测站"],
    ["2", "0", "华南分公司", "公司"],
    ["21", "2", "调度室", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  await db.run("UPDATE sys_dept SET leader_user_id='60' WHERE id='6'");
  for (const p of [
    { id: "60", nickname: "检测站长", deptId: "6" },
    { id: "20", nickname: "华南寄件人", deptId: "2" },
  ])
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
      [p.id, `u${p.id}`, p.nickname, p.deptId]
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
  const ctx = (id, nickname, deptId, orgIds) => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: {
      perms: new Set(PERMS),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
      roles: [],
    },
    ip: "127.0.0.1",
  });
  const admin = ctx("20", "华南寄件人", "2", null);
  const south = ctx("20", "华南寄件人", "2", ["2", "21"]);
  const station = ctx("60", "检测站长", "6", ["1", "6"]);
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
      item.org = ORG_NAMES[orgId] || "";
    });
    return { id: box.id, imei };
  };
  const boxRow = (id) => db.get("SELECT org_id,org,life FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = (body, actor = admin) =>
    run(controller.createTask.bind(controller), actor, { body });
  const advance = (id, status, actor = admin, note = "") =>
    run(controller.transition.bind(controller), actor, { params: { id }, body: { status, note } });
  const teardown = async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    db,
    boxes,
    policies,
    controller,
    admin,
    south,
    station,
    run,
    makeBox,
    boxRow,
    taskRow,
    create,
    advance,
    teardown,
  };
}

test("R23 状态机：本地 3 步已封箱终态、送检 5 步、采样后送检合并流；判别互不串扰", () => {
  const local = { kind: "采样", localOnly: true };
  assert.deepEqual(SAMPLE_LOCAL_FLOW, ["待采样", "采样中", "已封箱"]);
  assert.deepEqual(stepsOf(local), SAMPLE_LOCAL_FLOW);
  assert.equal(initialOf(local), "待采样");
  assert.deepEqual(nextOf(local, "待采样"), ["采样中", "已取消"]);
  assert.deepEqual(nextOf(local, "采样中"), ["已封箱", "已取消"]);
  assert.deepEqual(nextOf(local, "已封箱"), []);
  assert.equal(isEndedFor({ ...local, status: "已封箱" }), true);
  assert.equal(isEndedFor({ ...local, status: "采样中" }), false);
  assert.ok(isLocalSample(local) && !isMergedSample(local) && !isLegacySample(local));
  // 送检（新＝旧只读同流）
  assert.deepEqual(stepsOf({ kind: "送检" }), INSPECT_FLOW);
  assert.equal(initialOf({ kind: "送检" }), "待寄出");
  assert.equal(prefixOf("送检"), "IN-");
  assert.deepEqual(nextOf({ kind: "送检" }, "待签收"), ["待检测", "已拒收", "退回中", "已取消"]);
  // 采样后送检（显式新 kind）＝合并流；旧合并别名 kind=采样+inspect 仍兼容
  assert.deepEqual(stepsOf({ kind: "采样后送检", inspect: true }), SAMPLE_FLOW);
  assert.equal(initialOf({ kind: "采样后送检", inspect: true }), "待采样");
  assert.ok(isMergedSample({ kind: "采样后送检" }));
  assert.ok(isMergedSample({ kind: "采样", inspect: true }));
  assert.equal(prefixOf("采样后送检"), "TK-");
  // 合并单已封箱仍中间态（不进全局终态）
  assert.equal(isEndedFor({ kind: "采样后送检", status: "已封箱" }), false);
  assert.deepEqual(nextOf({ kind: "采样后送检", inspect: true }, "已封箱"), ["在途", "已取消"]);
  // 旧采样（无 localOnly/inspect/trip）仍 legacy
  assert.ok(isLegacySample({ kind: "采样", status: "在途" }));
});

test("R23 建单：三 kind 字段必需性＋前缀＋初始态＋权限兜底", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const b = await s.makeBox("2");
    const c = await s.makeBox("2");
    // 本地采样：无检测站/签收人/寄出腿，localOnly 标记，inspect=false，to_org 空
    const local = await s.create({
      name: "本地采样",
      kind: "采样",
      localOnly: true,
      boxIds: [a.id],
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
      sample: "水样",
      people: "华南寄件人",
    });
    assert.ok(local.ok, local.message);
    assert.match(local.data.id, /^TK-/);
    const lr = await s.taskRow(local.data.id);
    assert.equal(lr.kind, "采样");
    assert.equal(lr.status, "待采样");
    assert.equal(Number(lr.is_inspect), 0);
    assert.equal(lr.to_org_id, null);
    const lb = JSON.parse(lr.body);
    assert.equal(lb.localOnly, true);
    assert.equal(lb.inspect, false);
    assert.equal(lb.orgId, "2");
    // 送检：无采样段（不传 placeAt/sample/people），接收方固定检测站
    const inspect = await s.create({
      name: "送检",
      kind: "送检",
      boxIds: [b.id],
      senderId: "20",
      signerId: "60",
      toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
    });
    assert.ok(inspect.ok, inspect.message);
    assert.match(inspect.data.id, /^IN-/);
    const ir = await s.taskRow(inspect.data.id);
    assert.equal(ir.kind, "送检");
    assert.equal(ir.status, "待寄出");
    assert.equal(Number(ir.is_inspect), 1);
    assert.equal(ir.to_org_id, "6");
    const ib = JSON.parse(ir.body);
    assert.equal(ib.inspect, true);
    // R28：送检方向可选，默认单向（oneWay）；无 localOnly
    assert.equal(ib.trip, "单向");
    assert.equal(ib.tripMode, "oneWay");
    assert.ok(!ib.localOnly);
    assert.equal(ib.orgId, "2", "送检 orgId＝寄出方（公司策略/来源归属）");
    // 采样后送检：显式新 kind，合并流
    const merged = await s.create({
      name: "采样后送检",
      kind: "采样后送检",
      boxIds: [c.id],
      fromOrgId: "2",
      senderId: "20",
      signerId: "60",
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    assert.ok(merged.ok, merged.message);
    assert.match(merged.data.id, /^TK-/);
    const mr = await s.taskRow(merged.data.id);
    assert.equal(mr.kind, "采样后送检");
    assert.equal(mr.status, "待采样");
    assert.equal(JSON.parse(mr.body).tripDerived, true);
    // 送检缺签收人：拒绝
    const noSigner = await s.create({
      name: "x",
      kind: "送检",
      boxIds: [await s.makeBox("2").then((x) => x.id)],
      senderId: "20",
    });
    assert.match(noSigner.message, /请填写寄出人和签收人/);
    // 送检接收方非检测站：拒绝
    const wrongTo = await s.create({
      name: "x",
      kind: "送检",
      boxIds: [await s.makeBox("2").then((x) => x.id)],
      toOrgId: "2",
      senderId: "20",
      signerId: "60",
    });
    assert.match(wrongTo.message, /接收方固定为唯一检测站/);
    // 未知 kind：拒绝
    const badKind = await s.create({ name: "x", kind: "调拨", boxIds: [a.id] });
    assert.match(badKind.message, /调拨单已停用/);
  } finally {
    await s.teardown();
  }
});

test("R23 本地采样全流：封箱即终态、箱子释放可复用、无归属交接", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const created = await s.create({
      name: "本地采样",
      kind: "采样",
      localOnly: true,
      boxIds: [a.id],
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    const id = created.data.id;
    assert.ok((await s.advance(id, "采样中", s.south)).ok);
    assert.ok((await s.advance(id, "已封箱", s.south)).ok);
    const row = await s.taskRow(id);
    assert.equal(row.status, "已封箱");
    assert.ok(isEndedFor({ ...JSON.parse(row.body), kind: row.kind, status: row.status }));
    // 箱子释放、归属仍在采样单位（无交接）
    const box = await s.boxRow(a.id);
    assert.equal(box.life, "未使用");
    assert.equal(box.org_id, "2");
    assert.equal(
      await s.db
        .get("SELECT COUNT(*) AS n FROM box_active_task WHERE box_id=?", [a.id])
        .then((r) => Number(r.n)),
      0
    );
    // 终态后再推进被拒
    const again = await s.advance(id, "在途", s.south);
    assert.equal(again.ok, false);
    // 同一箱子可再建本地单（已释放）
    const second = await s.create({
      name: "第二批",
      kind: "采样",
      localOnly: true,
      boxIds: [a.id],
    });
    assert.ok(second.ok, second.message);
    // 详情步条 3 步、displayKind=采样
    const detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_LOCAL_FLOW);
    assert.equal(detail.data.task.displayKind, "采样");
  } finally {
    await s.teardown();
  }
});

test("R23 送检全流：寄出→签收交接归属→逐台检测；拒收/退回分支", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const created = await s.create({
      name: "送检",
      kind: "送检",
      boxIds: [a.id],
      senderId: "20",
      signerId: "60",
      fromPlace: { address: "华南仓库", lng: 114.1, lat: 22.6 },
      toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
    });
    const id = created.data.id;
    assert.ok((await s.advance(id, "运送中", s.south)).ok);
    assert.ok((await s.advance(id, "待签收", s.south)).ok);
    // 检测站签收（指定签收人 60）：归属交检测站
    assert.ok((await s.advance(id, "待检测", s.station)).ok);
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    // 逐台开始检测
    const insp = await s.run(s.controller.inspect.bind(s.controller), s.station, {
      params: { id, boxId: a.id },
    });
    assert.ok(insp.ok, insp.message);
    assert.equal(insp.data.done, true);
    assert.equal((await s.taskRow(id)).status, "已检测");
    const detail = await s.run(s.controller.taskDetail.bind(s.controller), s.station, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, INSPECT_FLOW);
    assert.equal(detail.data.task.displayKind, "送检");

    // 拒收分支
    const b = await s.makeBox("2");
    const rej = await s.create({
      name: "拒收",
      kind: "送检",
      boxIds: [b.id],
      senderId: "20",
      signerId: "60",
    });
    await s.advance(rej.data.id, "运送中", s.south);
    await s.advance(rej.data.id, "待签收", s.south);
    const rejected = await s.advance(rej.data.id, "已拒收", s.station, "样品异常");
    assert.ok(rejected.ok, rejected.message);
    assert.equal((await s.taskRow(rej.data.id)).status, "已拒收");
    assert.equal((await s.boxRow(b.id)).org_id, "2", "拒收不交接归属");

    // 退回分支：送检沿旧送检流，待签收「拒收并退回」，已退回回寄出方
    const c = await s.makeBox("2");
    const ret = await s.create({
      name: "退回",
      kind: "送检",
      boxIds: [c.id],
      senderId: "20",
      signerId: "60",
    });
    await s.advance(ret.data.id, "运送中", s.south);
    await s.advance(ret.data.id, "待签收", s.south);
    assert.ok((await s.advance(ret.data.id, "退回中", s.station, "不合格")).ok);
    assert.ok((await s.advance(ret.data.id, "已退回", s.south)).ok);
    assert.equal((await s.taskRow(ret.data.id)).status, "已退回");
    assert.equal((await s.boxRow(c.id)).org_id, "2", "退回回寄出方");
  } finally {
    await s.teardown();
  }
});

/** 060 矩阵专用：直接插 sample_task＋_bak_org_simplify_task，模拟 056 后存量。 */
async function migSetup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "three-kinds-mig-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  const insert = async (table, id, kind, status, body, extra = {}) => {
    await db.run(
      `INSERT INTO ${table} (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        id,
        kind,
        status,
        JSON.stringify(body),
        new Date().toISOString(),
        extra.from ?? "2",
        extra.to ?? null,
        extra.inspect ?? (body.inspect ? 1 : 0),
      ]
    );
  };
  const teardown = async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, insert, teardown };
}

test("R23 060 回填矩阵：原送检还原（逆映射＋去 trip）、原采样按 inspect/状态归位、调拨/划拨不动", async () => {
  const s = await migSetup();
  try {
    const bak = (id, kind, status, body) =>
      s.insert("_bak_org_simplify_task", id, kind, status, body);
    const cur = (id, kind, status, body, extra) =>
      s.insert("sample_task", id, kind, status, body, extra);
    // 原送检 待寄出 → 056 已封箱 → 060 送检 待寄出（去 trip）
    await bak("IN-a", "送检", "待寄出", { kind: "送检", inspect: true });
    await cur(
      "IN-a",
      "采样",
      "已封箱",
      { kind: "采样", inspect: true, trip: "单向", tripDerived: true },
      { to: "6", inspect: 1 }
    );
    // 原送检 运送中 → 056 在途 → 060 送检 运送中
    await bak("IN-b", "送检", "运送中", { kind: "送检", inspect: true });
    await cur(
      "IN-b",
      "采样",
      "在途",
      { kind: "采样", inspect: true, trip: "单向", tripDerived: true },
      { to: "6", inspect: 1 }
    );
    // 原送检 已沿合并流推进到 待检测 → 060 送检 待检测（同名保留进度）
    await bak("IN-c", "送检", "待寄出", { kind: "送检", inspect: true });
    await cur(
      "IN-c",
      "采样",
      "待检测",
      { kind: "采样", inspect: true, trip: "单向", tripDerived: true },
      { to: "6", inspect: 1 }
    );
    // 原采样 inspect=true（059 合并单）→ 采样后送检
    await bak("TK-m", "采样", "待采样", { kind: "采样", inspect: true });
    await cur(
      "TK-m",
      "采样",
      "采样中",
      { kind: "采样", inspect: true, trip: "单向", tripDerived: true },
      { to: "6", inspect: 1 }
    );
    // 原采样 inspect=false 无 trip 停已封箱 → 采样（本地，localOnly，to_org 空）
    await bak("TK-l", "采样", "已封箱", { kind: "采样" });
    await cur("TK-l", "采样", "已封箱", { kind: "采样", toOrg: "核验点" }, { to: "9" });
    // 原采样 inspect=false 无 trip 停已检测（056 映射旧已签收）→ 采样后送检（近似）
    await bak("TK-s", "采样", "已签收", { kind: "采样" });
    await cur("TK-s", "采样", "已检测", { kind: "采样" }, { to: "9" });
    // 原采样 inspect=false 带 trip 停在途 → 采样后送检（近似）
    await bak("TK-t", "采样", "在途", { kind: "采样", trip: "双向" });
    await cur("TK-t", "采样", "在途", { kind: "采样", trip: "双向" }, { to: "2" });
    // 调拨/划拨不动
    await cur("AL-x", "划拨", "已划拨", { kind: "划拨" }, { to: "3" });
    await cur("DB-x", "调拨", "待签收", { kind: "调拨", inspect: true }, { to: "6", inspect: 1 });

    // migrate 已在空表上建过 _bak_060（空壳）；删掉再跑，验证「改动前备份」语义（沿 org-b1b 先例）
    await s.db.run("DROP TABLE IF EXISTS _bak_060_three_kinds_task");
    await up060(s.db);
    const row = async (id) => {
      const r = await s.db.get("SELECT kind,status,body,to_org_id FROM sample_task WHERE id=?", [
        id,
      ]);
      return { ...r, body: JSON.parse(r.body) };
    };
    const a = await row("IN-a");
    assert.equal(a.kind, "送检");
    assert.equal(a.status, "待寄出");
    assert.ok(!a.body.trip && !a.body.tripDerived);
    assert.equal(a.body.kind, "送检");
    assert.equal((await row("IN-b")).status, "运送中");
    assert.equal((await row("IN-c")).status, "待检测");
    const m = await row("TK-m");
    assert.equal(m.kind, "采样后送检");
    assert.equal(m.status, "采样中");
    assert.equal(m.body.trip, "单向", "trip 沿用 059");
    const l = await row("TK-l");
    assert.equal(l.kind, "采样");
    assert.equal(l.body.localOnly, true);
    assert.equal(l.body.inspect, false);
    assert.equal(l.to_org_id, null);
    assert.ok(!l.body.toOrg);
    assert.equal((await row("TK-s")).kind, "采样后送检");
    assert.equal((await row("TK-t")).kind, "采样后送检");
    assert.equal((await row("AL-x")).kind, "划拨");
    assert.equal((await row("DB-x")).kind, "调拨");
    // _bak_060 留底（含改写前原态）
    const bakCount = await s.db.get("SELECT COUNT(*) AS n FROM _bak_060_three_kinds_task");
    assert.equal(Number(bakCount.n), 9);
  } finally {
    await s.teardown();
  }
});

test("R23 060 幂等：重跑逐字节不变；_bak_060 不覆盖首次备份；060 后新建单不受影响", async () => {
  const s = await migSetup();
  try {
    await s.insert("_bak_org_simplify_task", "IN-a", "送检", "待寄出", {
      kind: "送检",
      inspect: true,
    });
    await s.insert(
      "sample_task",
      "IN-a",
      "采样",
      "已封箱",
      { kind: "采样", inspect: true, trip: "单向", tripDerived: true },
      { to: "6", inspect: 1 }
    );
    await s.insert("sample_task", "TK-l", "采样", "已封箱", { kind: "采样" }, { to: "9" });
    await s.db.run("DROP TABLE IF EXISTS _bak_060_three_kinds_task");
    await up060(s.db);
    const snapshot = await s.db.all(
      "SELECT id,kind,status,body,to_org_id FROM sample_task ORDER BY id"
    );
    const bakBefore = await s.db.all(
      "SELECT id,kind,status,body FROM _bak_060_three_kinds_task ORDER BY id"
    );
    // 060 后新建一张本地单（无备份行）
    await s.insert("sample_task", "TK-new", "采样", "待采样", {
      kind: "采样",
      localOnly: true,
      inspect: false,
    });
    await up060(s.db);
    const after = await s.db.all(
      "SELECT id,kind,status,body,to_org_id FROM sample_task ORDER BY id"
    );
    // 原有两行逐字节不变；新建本地单不被改写
    assert.deepEqual(
      after.filter((r) => r.id !== "TK-new"),
      snapshot
    );
    const fresh = after.find((r) => r.id === "TK-new");
    assert.equal(fresh.kind, "采样");
    assert.equal(JSON.parse(fresh.body).localOnly, true);
    const bakAfter = await s.db.all(
      "SELECT id,kind,status,body FROM _bak_060_three_kinds_task ORDER BY id"
    );
    assert.deepEqual(bakAfter, bakBefore, "_bak_060 重跑不覆盖");
  } finally {
    await s.teardown();
  }
});

/**
 * 任务 #69 本人保管参与方门「窄放宽」（D5 采样员自助链，用户拍板）服务端契约矩阵：
 * 仅本地采样步（待采样→采样中→已封箱，含 localOnly 与合并单采样段）的参与方判定接受本人保管
 * （box.owner_id∈scope.ownerIds）；寄出/确认到达/签收/开始检测/拒收/退回/取消等他角色步不放宽
 * （仍 manageOrgIds/ADMIN）；R22 值守全范围越权修保持（DUTY scope1 非 ADMIN 他单位仍 403）。
 * 矩阵：①scope4 本人保管全链＋actions＋sampling 桶；②scope4 他人保管 403/404 状态不变；
 * ③scope4 本人箱寄送/签收/检测/取消步 403；④DUTY 全范围他单位采样步仍 403；⑤ADMIN 不回归；
 * ⑥scope2 参与方分公司管理员不回归；⑦合并单（单向＋双向）采样段本人保管可推进、寄送段不放宽。
 * 一次性临时库，不碰开发/线上库、不占服务端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROLE_PERMS } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const permsOf = (code) => new Set(DEFAULT_ROLE_PERMS[code]);
const SAMPLER_CODES = permsOf("SAMPLER");
// 他角色步全码集（隔离「门」与「码」：持码仍 403 才证明是参与方门不放宽，而非缺码）
const STEP_CODES = [
  "task:send",
  "task:arrive",
  "task:sign",
  "task:inspect",
  "task:send-back",
  "task:cancel",
  "task:reject",
  "task:reject-return",
  "task:accept-return",
  "task:force-sign",
  "task:finish",
];

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "13" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "sampler-gate-relax-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["13", "1", "总部检测站", "检测站"],
    ["2", "0", "华南分公司", "公司"],
    ["21", "2", "调度室", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  for (const p of [
    { id: "7", nickname: "林夏", deptId: "2" },
    { id: "6", nickname: "陈可", deptId: "21" },
    { id: "60", nickname: "检测站长", deptId: "13" },
    { id: "1", nickname: "管理员", deptId: "1" },
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
  const ctx = (id, nickname, deptId, perms, scope, role = "SAMPLER") => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: { perms, scope, roles: [role] },
    ip: "127.0.0.1",
  });
  const all = { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const scope4 = { all: false, orgIds: [], ownerIds: ["7"], manageOrgIds: [] };
  const admin = ctx("1", "管理员", "1", permsOf("ADMIN"), all, "ADMIN");
  // 纯 scope4 采样员（标准夹具 lin.xia 口径：仅本人保管，三码）
  const samplerSelf = ctx("7", "林夏", "2", SAMPLER_CODES, scope4);
  // 纯 scope4＋他角色步全码：隔离门与码（③⑦寄送段持码仍 403）
  const samplerFull = ctx("7", "林夏", "2", new Set([...SAMPLER_CODES, ...STEP_CODES]), scope4);
  // 全码＋org 读可见（签收交接后箱归属移检测站，纯 scope4 读先 404；此变体隔离检测步参与方门 403）
  const samplerFullVisible = ctx("7", "林夏", "2", new Set([...SAMPLER_CODES, ...STEP_CODES]), {
    all: false,
    orgIds: ["2", "21", "13"],
    ownerIds: ["7"],
    manageOrgIds: [],
  });
  // scope4 但给 org 读可见（orgIds 含 21）：他人保管箱隔离参与方门用（②）
  const samplerOrgVisible = ctx("7", "林夏", "2", SAMPLER_CODES, {
    all: false,
    orgIds: ["21"],
    ownerIds: ["7"],
    manageOrgIds: [],
  });
  // DUTY 全范围非 ADMIN（R22 越权修保持）：dutyReal 实际模板；dutyFull 补采样码隔离门
  const dutyReal = ctx("9101", "验收值班员", "13", permsOf("DUTY"), all, "DUTY");
  const dutyFull = ctx(
    "9101",
    "验收值班员",
    "13",
    new Set([...permsOf("DUTY"), "task:sample-start", "task:seal"]),
    all,
    "DUTY"
  );
  // scope2 参与方分公司管理员（manageOrgIds 含 2/21，ownerIds 空＝不靠本人分支）
  const branch = ctx("9103", "华南管理员", "2", permsOf("BRANCH_ADMIN"), {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: [],
    manageOrgIds: ["2", "21"],
  });
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
  const makeBox = async (orgId = "21", ownerId = "") => {
    imeiSeq += 1;
    const imei = `8643170809${String(70000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(
      packet({ imei, uart: `why=boot,opens=0,fw=1.0.16,seq=${seq++}` })
    );
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
      if (ownerId) {
        item.ownerId = ownerId;
        item.owner = "林夏";
      }
    });
    return box.id;
  };
  const create = (body) => run(controller.createTask.bind(controller), admin, { body });
  const advance = (id, status, actor = admin, note = "") =>
    run(controller.transition.bind(controller), actor, { params: { id }, body: { status, note } });
  const detail = (id, actor) =>
    run(controller.taskDetail.bind(controller), actor, { params: { id } });
  const tasks = (actor, query) => run(controller.tasks.bind(controller), actor, { query });
  const todo = (actor) => controller.todo(actor);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const localTask = async (ownerId = "7", orgId = "21") => {
    const b = await makeBox(orgId, ownerId);
    const r = await create({
      name: "本地采样单",
      kind: "采样",
      localOnly: true,
      boxIds: [b],
      orgId,
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    assert.ok(r.ok, r.message);
    return { id: r.data.id, boxId: b };
  };
  // 合并单（采样后送检）：boxOrg 决定派生 trip（13＝双向，其余单向）；signerId="" 省略签收人（ADMIN 正常签收用）
  const mergedTask = async (ownerId = "7", opts = {}) => {
    const orgId = opts.orgId ?? "21";
    const boxOrg = opts.boxOrg ?? orgId;
    const b = await makeBox(boxOrg, ownerId);
    const senderId = boxOrg === "13" ? "60" : boxOrg === "2" ? "7" : "6";
    const signerId = opts.signerId === undefined ? "60" : opts.signerId;
    const r = await create({
      name: opts.name ?? "合并采样单",
      kind: "采样后送检",
      boxIds: [b],
      orgId,
      senderId,
      ...(signerId ? { signerId } : {}),
      signer: "检测站长",
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    assert.ok(r.ok, r.message);
    return { id: r.data.id, boxId: b };
  };
  return {
    db,
    controller,
    boxes,
    admin,
    samplerSelf,
    samplerFull,
    samplerFullVisible,
    samplerOrgVisible,
    dutyReal,
    dutyFull,
    branch,
    run,
    makeBox,
    create,
    advance,
    detail,
    tasks,
    todo,
    taskRow,
    localTask,
    mergedTask,
    teardown: async () => {
      await db.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("① scope4 本人保管箱：sample-start/seal 200 状态推进、actions 含对应动作、todo.sampling>0", async () => {
  const s = await setup();
  try {
    const t = await s.localTask("7");
    // 详情 can 给采样中
    const d0 = await s.detail(t.id, s.samplerSelf);
    assert.ok(d0.ok, d0.message);
    assert.equal(d0.data.can["采样中"], true, "本人保管应给采样中推进权");
    // 列表 mine=1&bucket=sampling 命中且 actions 含采样中（home 行内按钮数据源）
    const list0 = await s.tasks(s.samplerSelf, { mine: "1", bucket: "sampling", pageSize: 50 });
    assert.ok(list0.ok, list0.message);
    const row0 = list0.data.list.find((r) => r.id === t.id);
    assert.ok(row0, "sampling 桶应含本人保管待采样单");
    assert.ok(row0.actions.includes("采样中"), "actions 应含采样中");
    // 工作台 sampling 待办非零
    const todo0 = await s.todo(s.samplerSelf);
    assert.ok(todo0.sampling.total > 0, "todo.sampling 应非零");
    assert.ok(todo0.sampling.list.some((r) => r.id === t.id));
    // 推进采样中
    const a1 = await s.advance(t.id, "采样中", s.samplerSelf);
    assert.ok(a1.ok, a1.message);
    assert.equal((await s.taskRow(t.id)).status, "采样中");
    const list1 = await s.tasks(s.samplerSelf, { mine: "1", bucket: "sampling", pageSize: 50 });
    const row1 = list1.data.list.find((r) => r.id === t.id);
    assert.ok(row1.actions.includes("已封箱"), "采样中态 actions 应含已封箱");
    assert.ok((await s.todo(s.samplerSelf)).sampling.total > 0, "采样中态 sampling 待办仍非零");
    // 封箱终态
    const a2 = await s.advance(t.id, "已封箱", s.samplerSelf);
    assert.ok(a2.ok, a2.message);
    assert.equal((await s.taskRow(t.id)).status, "已封箱");
    // 本地终态后不再占 sampling 待办（activeTaskSql 排除 localOnly 已封箱）
    const todo2 = await s.todo(s.samplerSelf);
    assert.equal(todo2.sampling.total, 0, "本地已封箱终态后 sampling 待办归零");
    const dEnd = await s.detail(t.id, s.samplerSelf);
    assert.deepEqual(dEnd.data.can, {}, "终态无可推进动作");
  } finally {
    await s.teardown();
  }
});

test("② scope4 他人保管箱：403 状态不变（纯 scope4 读先 404 fail-closed；org 可见时门 403）", async () => {
  const s = await setup();
  try {
    // 他人保管（owner 空）＋另一保管人（owner 6）各一单
    const tEmpty = await s.localTask("");
    const tOther = await s.localTask("6");
    // 纯 scope4（orgIds=[]）：他人箱单读不可见 → 详情/推进 404，列表不含（fail-closed）
    for (const t of [tEmpty, tOther]) {
      const d = await s.detail(t.id, s.samplerSelf);
      assert.equal(d.ok, false);
      assert.equal(d.status, 404, "纯 scope4 他人保管箱单应读不可见");
      const a = await s.advance(t.id, "采样中", s.samplerSelf);
      assert.equal(a.ok, false);
      assert.equal(a.status, 404);
      assert.equal((await s.taskRow(t.id)).status, "待采样", "状态不得变");
    }
    const list = await s.tasks(s.samplerSelf, { pageSize: 50 });
    const ids = list.data.list.map((r) => r.id);
    assert.ok(!ids.includes(tEmpty.id) && !ids.includes(tOther.id), "他人保管箱单不应进列表");
    // 给 org 读可见以隔离参与方门：可见但非本人保管 → 门 403（本人分支不命中）
    for (const t of [tEmpty, tOther]) {
      const d = await s.detail(t.id, s.samplerOrgVisible);
      assert.ok(d.ok, d.message);
      assert.equal(d.data.can["采样中"], false, "他人保管不应给采样中推进权");
      const a = await s.advance(t.id, "采样中", s.samplerOrgVisible);
      assert.equal(a.ok, false);
      assert.equal(a.status, 403);
      assert.equal((await s.taskRow(t.id)).status, "待采样", "门挡推进不得改状态");
    }
  } finally {
    await s.teardown();
  }
});

test("③ scope4 本人箱但寄出/签收/检测/取消步：403（不放宽，持码隔离门）", async () => {
  const s = await setup();
  try {
    // 本地单取消不放宽：持 cancel 码＋本人保管，仍 403（取消走严格参与方门）
    const loc = await s.localTask("7");
    const cancel = await s.advance(loc.id, "已取消", s.samplerFull, "取消探针");
    assert.equal(cancel.ok, false);
    assert.equal(cancel.status, 403, "取消不放宽");
    assert.equal((await s.taskRow(loc.id)).status, "待采样");
    // 合并单：本人保管采样段可推进（ADMIN 先推到已封箱），寄送段持码仍 403
    const t = await s.mergedTask("7");
    for (const st of ["采样中", "已封箱"]) assert.ok((await s.advance(t.id, st)).ok);
    const sendBack = await s.advance(t.id, "在途", s.samplerFull, "寄出探针");
    assert.equal(sendBack.ok, false);
    assert.equal(sendBack.status, 403, "寄回（在途 sendBack）不放宽");
    assert.equal((await s.taskRow(t.id)).status, "已封箱");
    // ADMIN 推到在途 → 确认到达（待签收）不放宽
    assert.ok((await s.advance(t.id, "在途")).ok);
    const arrive = await s.advance(t.id, "待签收", s.samplerFull);
    assert.equal(arrive.ok, false);
    assert.equal(arrive.status, 403, "确认到达不放宽");
    // ADMIN 推到待签收 → 签收（待检测）不放宽（签收人 60≠7，接收门也 false）
    assert.ok((await s.advance(t.id, "待签收")).ok);
    const sign = await s.advance(t.id, "待检测", s.samplerFull);
    assert.equal(sign.ok, false);
    assert.equal(sign.status, 403, "签收不放宽");
    // ADMIN 推到待检测（指定签收人 60 的单，管理员走强制签收＋原因）→ 开始检测不放宽（整单＋逐台 inspect 端点）
    assert.ok((await s.advance(t.id, "强制签收", s.admin, "管理员代签")).ok);
    // 签收交接后箱归属已移签收人 60（org13）：纯 scope4 读先 404（fail-closed，本人分支不再命中）
    const inspectSelf = await s.advance(t.id, "已检测", s.samplerFull);
    assert.equal(inspectSelf.ok, false);
    assert.equal(inspectSelf.status, 404, "交接后非本人保管，纯 scope4 读不可见");
    // org 可见变体隔离参与方门：持 inspect 码仍 403（检测步不放宽）
    const inspect = await s.advance(t.id, "已检测", s.samplerFullVisible);
    assert.equal(inspect.ok, false);
    assert.equal(inspect.status, 403, "开始检测不放宽");
    const inspectBox = await s.run(s.controller.inspect.bind(s.controller), s.samplerFullVisible, {
      params: { id: t.id, boxId: t.boxId },
    });
    assert.equal(inspectBox.ok, false);
    assert.equal(inspectBox.status, 403, "逐台开始检测端点不放宽");
    assert.equal((await s.taskRow(t.id)).status, "待检测");
    // 实际 SAMPLER 码集（无 send-back 码）寄出也 403（码级 fail-closed 双保险）
    const t2 = await s.mergedTask("7");
    for (const st of ["采样中", "已封箱"]) assert.ok((await s.advance(t2.id, st)).ok);
    const noCode = await s.advance(t2.id, "在途", s.samplerSelf);
    assert.equal(noCode.ok, false);
    assert.equal(noCode.status, 403);
  } finally {
    await s.teardown();
  }
});

test("④ scope1 非 ADMIN（DUTY）他单位采样步：仍 403（R22 越权修保持）", async () => {
  const s = await setup();
  try {
    const loc = await s.localTask("7"); // org21，duty 非参与方
    // 实际 DUTY 模板（无采样码）：403
    const dReal = await s.detail(loc.id, s.dutyReal);
    assert.ok(dReal.ok, dReal.message);
    assert.equal(dReal.data.can["采样中"], false);
    const aReal = await s.advance(loc.id, "采样中", s.dutyReal, "越权探针");
    assert.equal(aReal.ok, false);
    assert.equal(aReal.status, 403);
    assert.equal((await s.taskRow(loc.id)).status, "待采样");
    // 补采样码隔离门：全范围非 ADMIN 仍 403（scope.all→isAdminRole=false，本人分支 null 不命中）
    const dFull = await s.detail(loc.id, s.dutyFull);
    assert.equal(dFull.data.can["采样中"], false, "DUTY 全范围持采样码也不给推进权");
    const aFull = await s.advance(loc.id, "采样中", s.dutyFull, "越权探针");
    assert.equal(aFull.ok, false);
    assert.equal(aFull.status, 403);
    assert.equal((await s.taskRow(loc.id)).status, "待采样", "越权推进不得改状态");
    // 合并单采样段同样 403
    const m = await s.mergedTask("7");
    const aM = await s.advance(m.id, "采样中", s.dutyFull, "越权探针");
    assert.equal(aM.ok, false);
    assert.equal(aM.status, 403);
    assert.equal((await s.taskRow(m.id)).status, "待采样");
    // DUTY 全范围不因本人放宽获得 sampling 待办
    const todoDuty = await s.todo(s.dutyFull);
    assert.equal(todoDuty.sampling.total, 0, "DUTY 不应有 sampling 待办");
  } finally {
    await s.teardown();
  }
});

test("⑤ ADMIN 全范围仍可推进（不回归）：本地全链＋合并单全链", async () => {
  const s = await setup();
  try {
    const loc = await s.localTask("7");
    assert.ok((await s.advance(loc.id, "采样中", s.admin)).ok);
    assert.ok((await s.advance(loc.id, "已封箱", s.admin)).ok);
    assert.equal((await s.taskRow(loc.id)).status, "已封箱");
    // 合并单（无指定签收人→ADMIN 按接收方正常签收）全链到已检测
    const m = await s.mergedTask("7", { signerId: "" });
    for (const st of ["采样中", "已封箱", "在途", "待签收", "待检测", "已检测"]) {
      const a = await s.advance(m.id, st, s.admin);
      assert.ok(a.ok, `${st}: ${a.message}`);
    }
    assert.equal((await s.taskRow(m.id)).status, "已检测");
    // ADMIN 详情 can 与待办不受窄放宽影响（scope.all→本人分支 null）
    const loc2 = await s.localTask("7");
    const d = await s.detail(loc2.id, s.admin);
    assert.equal(d.data.can["采样中"], true);
  } finally {
    await s.teardown();
  }
});

test("⑥ scope2 参与方分公司管理员仍可推进（不回归，ownerIds 空不靠本人分支）", async () => {
  const s = await setup();
  try {
    const loc = await s.localTask("7");
    const d = await s.detail(loc.id, s.branch);
    assert.equal(d.data.can["采样中"], true, "参与方管理范围应给推进权");
    assert.ok((await s.advance(loc.id, "采样中", s.branch)).ok);
    assert.ok((await s.advance(loc.id, "已封箱", s.branch)).ok);
    assert.equal((await s.taskRow(loc.id)).status, "已封箱");
    // 合并单采样段：参与方（manageOrgIds 含 21）可推进
    const m = await s.mergedTask("7");
    assert.ok((await s.advance(m.id, "采样中", s.branch)).ok);
    assert.ok((await s.advance(m.id, "已封箱", s.branch)).ok);
    assert.equal((await s.taskRow(m.id)).status, "已封箱");
    // 管理范围仅 21 的口径：orgId=2 的单（manageOrgIds 含 2 也可）——分公司管理员含 2，仍可
    const m2 = await s.mergedTask("7", { orgId: "2", boxOrg: "2" });
    assert.ok((await s.advance(m2.id, "采样中", s.branch)).ok);
  } finally {
    await s.teardown();
  }
});

test("⑦ 合并单采样段本人保管可推进、寄送段不放宽（单向＋双向首腿确认到达不放宽）", async () => {
  const s = await setup();
  try {
    // 单向合并单：本人保管采样段全链 200
    const m = await s.mergedTask("7");
    const d0 = await s.detail(m.id, s.samplerSelf);
    assert.equal(d0.data.can["采样中"], true, "合并单采样段本人保管应给推进权");
    assert.ok((await s.todo(s.samplerSelf)).sampling.total > 0, "合并待采样 sampling 待办非零");
    assert.ok((await s.advance(m.id, "采样中", s.samplerSelf)).ok);
    assert.ok((await s.advance(m.id, "已封箱", s.samplerSelf)).ok);
    assert.equal((await s.taskRow(m.id)).status, "已封箱");
    // 寄送段（在途 sendBack）持码仍 403
    const sendBack = await s.advance(m.id, "在途", s.samplerFull, "寄出探针");
    assert.equal(sendBack.ok, false);
    assert.equal(sendBack.status, 403, "合并单寄送段不放宽");
    assert.equal((await s.taskRow(m.id)).status, "已封箱");
    // 双向合并单：箱在检测站（org13）本人保管，采样单位分公司 2；首腿由 ADMIN 推进
    const r = await s.mergedTask("7", { orgId: "2", boxOrg: "13", name: "双向合并单" });
    const row = await s.taskRow(r.id);
    assert.equal(JSON.parse(row.body).trip, "双向", "箱在检测站应派生双向");
    assert.equal(row.status, "待寄出");
    assert.ok((await s.advance(r.id, "运送中")).ok);
    // 首腿确认到达（运送中→待采样）不放宽：持 arrive 码的 scope4 仍 403
    const arrive = await s.advance(r.id, "待采样", s.samplerFull);
    assert.equal(arrive.ok, false);
    assert.equal(arrive.status, 403, "双向首腿确认到达不放宽");
    assert.equal((await s.taskRow(r.id)).status, "运送中");
    // ADMIN 确认到达（归属检测站→分公司，保管人不动＝仍本人）
    assert.ok((await s.advance(r.id, "待采样")).ok);
    const boxAfter = await s.boxes.findById(r.boxId);
    assert.equal(String(boxAfter.toJSON().orgId), "2", "首腿交接归属到采样单位");
    assert.equal(String(boxAfter.toJSON().ownerId), "7", "首腿保管人不动（借出跟踪）");
    // 采样段本人保管可推进（箱 org 已变 2，owner 仍 7）
    const dRound = await s.detail(r.id, s.samplerSelf);
    assert.equal(dRound.data.can["采样中"], true, "双向采样段本人保管应给推进权");
    assert.ok((await s.advance(r.id, "采样中", s.samplerSelf)).ok);
    assert.ok((await s.advance(r.id, "已封箱", s.samplerSelf)).ok);
    assert.equal((await s.taskRow(r.id)).status, "已封箱");
    // 双向寄回段（在途）仍不放宽
    const back = await s.advance(r.id, "在途", s.samplerFull, "寄回探针");
    assert.equal(back.ok, false);
    assert.equal(back.status, 403, "双向寄回段不放宽");
  } finally {
    await s.teardown();
  }
});

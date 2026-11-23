/**
 * R28 寄送方向可选＋双向寄回腿（任务 #92）服务端契约。
 *
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口、不重启任何服务。守住：
 * 1. 方向可选：寄送类（送检/采样后送检）trip 单向/双向，默认单向；非法值 400；
 *    tripMode 分流（oneWay/return/stationFirst），步条/nextOf/终态判定按 mode；
 * 2. 双向全链（合并）：待采样→采样中→已封箱→在途→待签收→待检测→已检测（中间态，占用保持）
 *    →待寄回→寄回在途→待归还→已归还（归属回 fromOrg＋保管人清空＋占用释放＋审计）；
 * 3. 单向终态已检测不回归（7 步、检测即释放）；送检双向 9 步全链；
 * 4. 动作门：待寄回/寄回在途/待归还＝检测站（send‖sign/arrive‖sign 双码门），
 *    已归还签收＝寄出分公司（sign‖acceptReturn）；非检测站寄回 403、非分公司归还签收 403；
 * 5. 箱在检测站建寄送单拒（控制器 400＋服务层锁内 409，文案「箱在检测站：回分公司请用划拨」）；
 * 6. 寄回腿占用：已检测→待归还期间 busy 拦新建单/划拨，bound_task 锚点保持；已归还释放后可再建单；
 * 7. 已检测仍可退回（退回分支保留）；寄回腿途中不可取消；
 * 8. legacy stationFirst：旧形状单渲染旧 9 步步条、首腿流程不变；067 打标 stationFirst/oneWay，
 *    两遍幂等＋_bak 留底，新单/legacy/送检/local 不动；
 * 9. 读时回算兜底（无 trip 存量合并单）保持 R22 口径。
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
import { ReportPolicy, transferBlock } from "../src/settings/ReportPolicy.js";
import {
  activeTaskSql,
  boxHeldSql,
  ENDED,
  ENDED_OK,
  initialOf,
  INSPECT_RETURN_LEG_FLOW,
  isEndedFor,
  isLegacySample,
  nextOf,
  RETURN_LEG_STEPS,
  SAMPLE_FLOW,
  SAMPLE_RETURN_LEG_FLOW,
  SAMPLE_ROUND_FLOW,
  stepsOf,
  tripModeOf,
} from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { up as up067 } from "../migrations/067_trip_mode.js";
import { packet } from "./fixture.js";

const ORG_NAMES = { 1: "总公司", 2: "华南分公司", 3: "华东分公司", 6: "总部检测站" };

/** 检测站侧角色码集（DUTY/VERIFY 形状）：task:sign 的 045 拆分含 TASK_STEPS，但无 task:send。 */
const STATION_PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:opens",
  "task:sign",
  "task:cancel",
]);
/** 分公司侧码集（BRANCH_ADMIN/DISPATCH 形状）：含 task:send（policyTask 拆分）。 */
const BRANCH_PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:opens",
  "device:box:policyTask",
  "task:create:sample",
  "task:create:inspect",
  "task:sign",
  "task:cancel",
]);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "trip-return-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["6", "1", "总部检测站", "检测站"],
    ["2", "0", "华南分公司", "公司"],
    ["3", "0", "华东分公司", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  await db.run("UPDATE sys_dept SET leader_user_id='60' WHERE id='6'");
  const people = {
    leader: { id: "60", nickname: "检测站长", deptId: "6" },
    duty: { id: "61", nickname: "检测站值守", deptId: "6" },
    south: { id: "20", nickname: "华南寄件人", deptId: "2" },
    east: { id: "30", nickname: "华东寄件人", deptId: "3" },
  };
  for (const p of Object.values(people))
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
  const ctx = (person, orgIds, perms = BRANCH_PERMS) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: {
      perms: new Set(perms),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
      roles: [],
    },
    ip: "127.0.0.1",
  });
  const admin = ctx(people.south, null);
  const south = ctx(people.south, ["2"]);
  const east = ctx(people.east, ["3"]);
  const station = ctx(people.duty, ["1", "6"], STATION_PERMS);
  const leader = ctx(people.leader, ["1", "6"], STATION_PERMS);
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
        data: error.data,
      };
    }
  };
  let imeiSeq = 0;
  let seq = 1;
  const makeBox = async (orgId = "2") => {
    imeiSeq += 1;
    const imei = `8643170809${String(40000 + imeiSeq).padStart(5, "0")}`;
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
  const boxRow = (id) =>
    db.get("SELECT org_id,org,owner_id,owner,life,bound_task_id FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = async (boxIds, extra = {}, actor = admin) => {
    const res = await run(controller.createTask.bind(controller), actor, {
      body: {
        name: "R28 方向可选",
        kind: "采样后送检",
        boxIds,
        orgId: "2",
        fromOrgId: "2",
        senderId: "20",
        signerId: "60",
        placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
        fromPlace: { address: "寄出仓库", lng: 114.1, lat: 22.6 },
        toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
        ...extra,
      },
    });
    return res;
  };
  const advance = async (id, steps, actor = admin) => {
    for (const status of steps) {
      const res = await run(controller.transition.bind(controller), actor, {
        params: { id },
        body: { status, note: ["退回中", "已拒收", "强制签收"].includes(status) ? "原因说明" : "" },
      });
      assert.ok(res.ok, `${status} 失败：${res.code} ${res.message || res.msg}`);
    }
  };
  const detailOf = async (id, actor = admin) => {
    const res = await run(controller.taskDetail.bind(controller), actor, { params: { id } });
    assert.ok(res.ok, res.message);
    return res.data;
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
    ingest,
    ctx,
    admin,
    south,
    east,
    station,
    leader,
    people,
    run,
    makeBox,
    boxRow,
    taskRow,
    create,
    advance,
    detailOf,
    teardown,
  };
}

test("R28 共享矩阵：tripMode 分流步条/nextOf/终态；已归还∈ENDED；return-已检测是中间态", () => {
  const ret = {
    kind: "采样后送检",
    inspect: true,
    tripDerived: true,
    trip: "双向",
    tripMode: "return",
  };
  const one = {
    kind: "采样后送检",
    inspect: true,
    tripDerived: true,
    trip: "单向",
    tripMode: "oneWay",
  };
  const legacyRound = { kind: "采样后送检", inspect: true, tripDerived: true, trip: "双向" };
  const inspRet = { kind: "送检", inspect: true, trip: "双向", tripMode: "return" };
  assert.equal(tripModeOf(ret), "return");
  assert.equal(tripModeOf(one), "oneWay");
  assert.equal(tripModeOf(legacyRound), "stationFirst", "无 tripMode 的存量双向推断为站首腿");
  assert.equal(tripModeOf({ kind: "送检" }), "oneWay");
  assert.deepEqual(stepsOf(ret), SAMPLE_RETURN_LEG_FLOW);
  assert.equal(SAMPLE_RETURN_LEG_FLOW.length, 11);
  assert.deepEqual(stepsOf(one), SAMPLE_FLOW);
  assert.deepEqual(stepsOf(legacyRound), SAMPLE_ROUND_FLOW, "legacy 站首腿仍 9 步");
  assert.deepEqual(stepsOf(inspRet), INSPECT_RETURN_LEG_FLOW);
  assert.equal(INSPECT_RETURN_LEG_FLOW.length, 9);
  assert.equal(initialOf(ret), "待采样", "新双向首步仍是本地待采样（无站首腿）");
  assert.equal(initialOf(inspRet), "待寄出");
  assert.deepEqual(nextOf(ret, "已检测"), ["待寄回", "退回中"]);
  assert.deepEqual(nextOf(ret, "待寄回"), ["寄回在途"]);
  assert.deepEqual(nextOf(ret, "寄回在途"), ["待归还"]);
  assert.deepEqual(nextOf(ret, "待归还"), ["已归还"]);
  assert.deepEqual(nextOf(ret, "已归还"), []);
  assert.deepEqual(nextOf(inspRet, "已检测"), ["待寄回"]);
  assert.deepEqual(nextOf(inspRet, "待归还"), ["已归还"]);
  // 单向/legacy 不混新：oneWay 已检测终态无推进；legacy 站首腿已检测只可退回
  assert.deepEqual(nextOf(one, "已检测"), ["退回中"]);
  assert.deepEqual(nextOf(legacyRound, "已检测"), ["退回中"]);
  assert.deepEqual(nextOf(one, "待寄回"), []);
  // 终态/占用口径
  assert.ok(ENDED_OK.includes("已归还"));
  assert.ok(ENDED.includes("已归还"));
  assert.equal(isEndedFor({ ...ret, status: "已检测" }), false, "return 单已检测是中间态");
  assert.equal(isEndedFor({ ...ret, status: "已归还" }), true);
  assert.equal(isEndedFor({ ...one, status: "已检测" }), true, "单向已检测仍终态");
  assert.equal(isEndedFor({ ...legacyRound, status: "已检测" }), true);
  assert.ok(activeTaskSql().includes(`'%"tripMode":"return"%'`));
  assert.ok(boxHeldSql().includes("inspected_at IS NULL"));
  // 退回路径渲染：return 单发起退回后走单向退回 8 步（寄回腿不再渲染）
  assert.deepEqual(stepsOf({ ...ret, status: "退回中" }), [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待签收",
    "待检测",
    "退回中",
    "已退回",
  ]);
  assert.deepEqual(RETURN_LEG_STEPS, ["待寄回", "寄回在途", "待归还", "已归还"]);
  // legacy 判别不被新标记污染
  assert.equal(isLegacySample(ret), false);
  assert.equal(isLegacySample({ kind: "采样", trip: "双向", inspect: true }), true);
});

test("建单方向可选：默认单向；显式双向＝return；非法 trip 400；送检同样可选", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const def = await s.create([a.id]);
    assert.ok(def.ok, def.message);
    let row = await s.taskRow(def.data.id);
    let body = JSON.parse(row.body);
    assert.equal(row.status, "待采样");
    assert.equal(body.trip, "单向", "不传 trip 默认单向");
    assert.equal(body.tripMode, "oneWay");
    assert.equal(body.tripDerived, true);
    assert.deepEqual((await s.detailOf(def.data.id)).task.steps, SAMPLE_FLOW);

    const b = await s.makeBox("2");
    const two = await s.create([b.id], { trip: "双向" });
    assert.ok(two.ok, two.message);
    row = await s.taskRow(two.data.id);
    body = JSON.parse(row.body);
    assert.equal(row.status, "待采样", "新双向首步待采样（本地采样先行）");
    assert.equal(body.trip, "双向");
    assert.equal(body.tripMode, "return");
    assert.equal(body.fromOrgId, "2", "寄出方＝箱归属分公司");
    assert.deepEqual((await s.detailOf(two.data.id)).task.steps, SAMPLE_RETURN_LEG_FLOW);

    const bad = await s.create([b.id], { trip: "往返" });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.match(bad.message, /单向或双向/);

    // 送检：仅寄送，方向同样可选（双向 9 步带寄回腿）
    const c = await s.makeBox("2");
    const insp = await s.create([c.id], { kind: "送检", trip: "双向", orgId: "2" });
    assert.ok(insp.ok, insp.message);
    row = await s.taskRow(insp.data.id);
    body = JSON.parse(row.body);
    assert.equal(row.status, "待寄出");
    assert.equal(body.tripMode, "return");
    assert.deepEqual((await s.detailOf(insp.data.id)).task.steps, INSPECT_RETURN_LEG_FLOW);
    const d = await s.makeBox("2");
    const inspOne = await s.create([d.id], { kind: "送检" });
    assert.ok(inspOne.ok, inspOne.message);
    assert.equal(JSON.parse((await s.taskRow(inspOne.data.id)).body).tripMode, "oneWay");
  } finally {
    await s.teardown();
  }
});

test("箱在检测站建寄送单拒：控制器 400＋服务层锁内 409，文案「箱在检测站：回分公司请用划拨」", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    for (const kind of ["采样后送检", "送检"]) {
      const res = await s.create([a.id], { kind, fromOrgId: "6", orgId: "2", senderId: "61" });
      assert.equal(res.ok, false, `${kind} 箱在检测站应拒`);
      assert.equal(res.status, 400);
      assert.match(res.message, /箱在检测站：回分公司请用划拨/);
    }
    // 服务层锁内复核（绕过控制器直接调 policies.createTask）：同样拒
    let locked = null;
    try {
      await s.policies.createTask({
        name: "锁内复核",
        kind: "采样后送检",
        boxIds: [a.id],
        orgId: "2",
        fromOrgId: "6",
        toOrgId: "6",
        inspect: true,
        trip: "单向",
        tripDerived: true,
        senderId: "61",
        signerId: "60",
      });
    } catch (error) {
      locked = error;
    }
    assert.ok(locked, "服务层应拒");
    assert.match(locked.message, /箱在检测站：回分公司请用划拨/);
    assert.equal(locked.httpStatus, 409);
    // 本地采样不受影响（无寄送腿，但采样单位必须是公司——检测站箱本地采样本就被公司类型门拦）
    const local = await s.create([a.id], {
      kind: "采样",
      localOnly: true,
      fromOrgId: "6",
      orgId: "6",
    });
    assert.equal(local.ok, false);
    assert.match(local.message, /分公司/);
  } finally {
    await s.teardown();
  }
});

test("双向全链（合并）：采样→寄出→签收→检测→寄回腿→分公司签收归还（归属回 fromOrg/保管人空/占用释放/审计）", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id], { trip: "双向", maxOpens: 4 });
    assert.ok(res.ok, res.message);
    const id = res.data.id;
    // 采样段（分公司）→寄出→到达
    await s.advance(id, ["采样中", "已封箱", "在途"], s.south);
    await s.advance(id, ["待签收"], s.south);
    // 检测站签收（指定签收人＝站长本人）：归属 2→6、保管人＝签收人
    await s.advance(id, ["待检测"], s.leader);
    let box = await s.boxRow(a.id);
    assert.equal(box.org_id, "6", "签收后箱归检测站");
    assert.equal(box.owner_id, "60", "保管人＝检测站签收人");
    // 逐台开始检测→已检测：return 单是中间态，占用保持
    const insp = await s.run(s.controller.inspect.bind(s.controller), s.station, {
      params: { id, boxId: a.id },
    });
    assert.ok(insp.ok, insp.message);
    assert.equal(insp.data.done, true);
    let row = await s.taskRow(id);
    assert.equal(row.status, "已检测");
    let detail = await s.detailOf(id, s.station);
    assert.deepEqual(detail.task.steps, SAMPLE_RETURN_LEG_FLOW);
    assert.equal(detail.can["待寄回"], true, "检测站可发起寄回");
    assert.equal(detail.can["退回中"], true, "已检测仍可退回");
    box = await s.boxRow(a.id);
    assert.equal(box.life, "在途", "return 单已检测不释放生命周期");
    assert.equal(box.bound_task_id, id, "占用锚点保持");
    assert.ok(
      await s.db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [a.id]),
      "box_active_task 保持"
    );
    // 占用期间 busy 拦划拨（transferBlock 与建单 busy 同谓词；箱在检测站期间划拨是回分公司的另一条路）
    const rawBox = await s.db.get("SELECT * FROM sample_box WHERE id=?", [a.id]);
    const hit = await transferBlock(s.db, rawBox);
    assert.equal(hit?.reasonCode, "IN_ACTIVE_TASK", "寄回腿期间箱子仍被本单占用");
    // 非检测站角色（分公司）不能发起寄回/确认寄回/确认到达
    for (const status of ["待寄回"]) {
      const wrong = await s.run(s.controller.transition.bind(s.controller), s.south, {
        params: { id },
        body: { status },
      });
      assert.equal(wrong.ok, false, `分公司不能推进 ${status}`);
      assert.equal(wrong.status, 403);
      assert.match(wrong.message, /检测站/);
    }
    // 检测站值守（仅 sign 拆分码，无 send）也能推进寄回腿（双码门）
    await s.advance(id, ["待寄回", "寄回在途", "待归还"], s.station);
    box = await s.boxRow(a.id);
    assert.equal(box.org_id, "6", "寄回途中归属仍检测站");
    assert.equal(box.life, "在途");
    detail = await s.detailOf(id, s.south);
    assert.equal(detail.can["已归还"], true, "分公司可签收归还");
    assert.equal(detail.target.role, "寄出地址", "待归还朝寄出分公司去");
    // 非分公司角色（检测站）不能签收归还
    const wrongSign = await s.run(s.controller.transition.bind(s.controller), s.station, {
      params: { id },
      body: { status: "已归还" },
    });
    assert.equal(wrongSign.ok, false);
    assert.equal(wrongSign.status, 403);
    assert.match(wrongSign.message, /寄出分公司/);
    // 分公司签收归还：归属回 fromOrg＋保管人清空＋占用释放
    const back = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "已归还" },
    });
    assert.ok(back.ok, back.message);
    assert.deepEqual(back.data.handOver.moved, [a.id]);
    box = await s.boxRow(a.id);
    assert.equal(box.org_id, "2", "归属回寄出分公司");
    assert.equal(box.org, "华南分公司");
    assert.equal(box.owner_id, "", "保管人清空（可重新分配）");
    assert.equal(box.owner, "—");
    assert.equal(box.life, "未使用", "占用释放");
    assert.equal(box.bound_task_id, "", "锚点清空");
    assert.equal(
      await s.db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [a.id]),
      undefined
    );
    row = await s.taskRow(id);
    assert.equal(row.status, "已归还");
    assert.equal(
      await s.db.get(`SELECT id FROM sample_task t WHERE t.id=? AND ${activeTaskSql()}`, [id]),
      undefined,
      "已归还不计入进行中"
    );
    // 审计：流转记录含寄回腿四动作＋归还交接明细
    const logs = await s.db.all(
      "SELECT status,action,detail FROM sample_task_log WHERE task_id=? ORDER BY created_at,id",
      [id]
    );
    const actions = logs.map((l) => l.action);
    for (const act of ["发起寄回", "确认寄回", "签收归还"])
      assert.ok(actions.includes(act), `流转记录应含 ${act}：${actions.join(",")}`);
    const backLog = logs.find((l) => l.status === "已归还");
    assert.ok(backLog.detail && JSON.parse(backLog.detail).handOver.movedCount === 1);
    // 释放后可再建单（可重新分配的行为证明）
    const again = await s.create([a.id]);
    assert.ok(again.ok, `已归还后应可再建单：${again.message}`);
  } finally {
    await s.teardown();
  }
});

test("单向终态不回归：7 步、已检测即释放（归属检测站/保管人签收人/占用清空）", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id]);
    assert.ok(res.ok, res.message);
    const id = res.data.id;
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"], s.south);
    await s.advance(id, ["待检测"], s.leader);
    await s.advance(id, ["已检测"], s.station);
    const row = await s.taskRow(id);
    assert.equal(row.status, "已检测");
    const detail = await s.detailOf(id);
    assert.deepEqual(detail.task.steps, SAMPLE_FLOW);
    assert.equal(detail.can["待寄回"], undefined, "单向无寄回腿动作");
    assert.equal(detail.can["已归还"], undefined);
    const box = await s.boxRow(a.id);
    assert.equal(box.org_id, "6", "单向检测完箱留检测站");
    assert.equal(box.owner_id, "60");
    assert.equal(box.life, "未使用");
    assert.equal(box.bound_task_id, "");
    // 单向已检测仍可退回（既有分支），但无寄回腿
    assert.deepEqual(nextOf(JSON.parse(row.body), "已检测"), ["退回中"]);
  } finally {
    await s.teardown();
  }
});

test("送检双向全链：9 步，已检测→寄回腿→已归还归属回寄出方", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id], { kind: "送检", trip: "双向", orgId: "2" });
    assert.ok(res.ok, res.message);
    const id = res.data.id;
    await s.advance(id, ["运送中", "待签收"], s.south);
    await s.advance(id, ["待检测"], s.leader);
    await s.advance(id, ["已检测"], s.station);
    assert.equal((await s.boxRow(a.id)).life, "在途", "送检 return 单已检测保持占用");
    await s.advance(id, ["待寄回", "寄回在途", "待归还"], s.station);
    await s.advance(id, ["已归还"], s.south);
    const box = await s.boxRow(a.id);
    assert.equal(box.org_id, "2");
    assert.equal(box.owner_id, "");
    assert.equal(box.life, "未使用");
    assert.deepEqual((await s.detailOf(id)).task.steps, INSPECT_RETURN_LEG_FLOW);
  } finally {
    await s.teardown();
  }
});

test("寄回腿边界：已检测可改退回（保管人写回寄出人）；寄回途中不可取消；whole-batch 已检测记检测事实", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id], { trip: "双向" });
    const id = res.data.id;
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"], s.south);
    await s.advance(id, ["待检测"], s.leader);
    // 整张单一起开始检测（transition 路径）：检测事实照记，占用不释放
    await s.advance(id, ["已检测"], s.station);
    const link = await s.db.get(
      "SELECT inspected_at,inspected_by FROM sample_task_box WHERE task_id=? AND box_id=?",
      [id, a.id]
    );
    assert.ok(link.inspected_at, "whole-batch 已检测应记 inspected_at");
    assert.equal((await s.boxRow(a.id)).life, "在途");
    // 改走退回：退回中→已退回，归属回 fromOrg、保管人写回寄出人（仍在分公司）
    await s.advance(id, ["退回中"], s.station);
    await s.advance(id, ["已退回"], s.south);
    const box = await s.boxRow(a.id);
    assert.equal(box.org_id, "2");
    assert.equal(box.owner_id, "20", "退回保管人写回寄出人（与归还清空不同）");
    assert.equal(box.life, "未使用");

    // 另一张：寄回途中不可取消
    const b = await s.makeBox("2");
    const r2 = await s.create([b.id], { trip: "双向" });
    const id2 = r2.data.id;
    await s.advance(id2, ["采样中", "已封箱", "在途", "待签收"], s.south);
    await s.advance(id2, ["待检测"], s.leader);
    await s.advance(id2, ["已检测", "待寄回"], s.station);
    for (const status of ["待寄回", "寄回在途", "待归还"]) {
      assert.ok(!nextOf({ kind: "采样后送检", tripMode: "return" }, status).includes("已取消"));
    }
    const cancel = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id: id2 },
      body: { status: "已取消" },
    });
    assert.equal(cancel.ok, false, "寄回腿途中不能取消");
  } finally {
    await s.teardown();
  }
});

test("legacy stationFirst：旧形状单旧 9 步步条＋首腿流程不变；067 打标后渲染不变", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    // R22 派生形状存量行（tripDerived＋trip 双向、无 tripMode）：直接造库行模拟 059 回填后的历史单
    // （R28 服务层已拒箱在检测站新建，历史行只能由迁移/旧库存在）
    const id = `TK-legacy-${Date.now()}`;
    const body = {
      kind: "采样",
      name: "R22 站首腿历史单",
      boxIds: [a.id],
      orgId: "2",
      org: "华南分公司",
      fromOrgId: "6",
      fromOrg: "总部检测站",
      toOrgId: "6",
      toOrg: "总部检测站",
      inspect: true,
      trip: "双向",
      tripDerived: true,
      senderId: "61",
      sender: "检测站值守",
      signerId: "60",
      signer: "检测站长",
      fromPlace: { address: "检测站寄出", lng: 114.3, lat: 22.8 },
      toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    };
    await s.db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, body.name, "采样", "待寄出", JSON.stringify(body), new Date().toISOString(), "6", "6", 1]
    );
    await s.db.run(
      "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
      [id, a.id, "6", ""]
    );
    await s.db.run(
      "INSERT INTO sample_task_log (id,task_id,status,action,actor_id,actor_name,note,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [`log-${id}`, id, "待寄出", "创建", "61", "检测站值守", "", null, new Date().toISOString()]
    );
    let row = await s.taskRow(id);
    assert.equal(row.status, "待寄出", "legacy 站首腿首步待寄出");
    let detail = await s.detailOf(id);
    assert.deepEqual(detail.task.steps, SAMPLE_ROUND_FLOW, "legacy 渲染旧 9 步（含首腿）");
    // 首腿流程不变：检测站寄出→分公司确认到达（归属 6→2）
    await s.advance(id, ["运送中"], s.station);
    await s.advance(id, ["待采样"], s.south);
    assert.equal((await s.boxRow(a.id)).org_id, "2", "首腿签收归属交采样单位（旧语义保持）");
    // 067 打标 stationFirst：渲染/推进不变
    await up067(s.db);
    row = await s.taskRow(id);
    assert.equal(JSON.parse(row.body).tripMode, "stationFirst");
    detail = await s.detailOf(id);
    assert.deepEqual(detail.task.steps, SAMPLE_ROUND_FLOW);
    await s.advance(id, ["采样中", "已封箱", "在途"], s.south);
    await s.advance(id, ["待签收"], s.station);
    await s.advance(id, ["待检测"], s.leader);
    assert.equal((await s.boxRow(a.id)).org_id, "6", "legacy 寄回签收归属回检测站（旧语义）");
    await s.advance(id, ["已检测"], s.station);
    assert.equal((await s.boxRow(a.id)).life, "未使用", "legacy 已检测终态释放（不混新）");
    assert.deepEqual(nextOf(JSON.parse((await s.taskRow(id)).body), "已检测"), ["退回中"]);
  } finally {
    await s.teardown();
  }
});

test("067 幂等＋留底：存量合并单按 trip 打标；新单/legacy/送检/local 不动；重跑逐字节不变", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const b = await s.makeBox("2");
    const c = await s.makeBox("2");
    // 新单（migrate 已含 067，建单恒写 tripMode）：return/oneWay
    const ret = await s.create([a.id], { trip: "双向" });
    const one = await s.create([b.id]);
    // 存量 R22 派生形状（tripDerived+trip 无 tripMode）：模拟 059 回填后、067 前的库
    // （R28 服务层对 tripDerived 新形状恒写 tripMode，造存量须剥掉）
    const legacyId = await s.policies.createTask({
      name: "存量派生双向",
      kind: "采样",
      boxIds: [c.id],
      orgId: "2",
      fromOrgId: "2",
      toOrgId: "6",
      inspect: true,
      trip: "双向",
      tripDerived: true,
      senderId: "20",
      signerId: "60",
    });
    const legacyRow = await s.taskRow(legacyId);
    const legacyBody = JSON.parse(legacyRow.body);
    delete legacyBody.tripMode;
    await s.db.run("UPDATE sample_task SET body=? WHERE id=?", [
      JSON.stringify(legacyBody),
      legacyId,
    ]);
    // 存量派生单向（去掉 tripMode 模拟 067 前）
    const oneRow = await s.taskRow(one.data.id);
    const oneBody = JSON.parse(oneRow.body);
    delete oneBody.tripMode;
    await s.db.run("UPDATE sample_task SET body=? WHERE id=?", [
      JSON.stringify(oneBody),
      one.data.id,
    ]);
    // legacy 手选旧采样单（isLegacySample）：067 不动
    const oldId = await s.policies.createTask({
      name: "旧手选采样单",
      kind: "采样",
      boxIds: [(await s.makeBox("2")).id],
      orgId: "2",
      fromOrgId: "2",
      trip: "双向",
      senderId: "20",
    });
    const before = await s.db.all("SELECT id,body,status,kind FROM sample_task ORDER BY id");
    // setup 的 migrate 已在空表上跑过 067（_bak 为空）；删掉模拟「067 前的存量库」再跑
    await s.db.run("DROP TABLE _bak_067_trip_mode_task");
    await up067(s.db);
    const taggedBody = JSON.parse((await s.taskRow(legacyId)).body);
    assert.equal(taggedBody.tripMode, "stationFirst", "存量派生双向→stationFirst");
    assert.equal(
      JSON.parse((await s.taskRow(one.data.id)).body).tripMode,
      "oneWay",
      "存量单向→oneWay"
    );
    assert.equal(JSON.parse((await s.taskRow(ret.data.id)).body).tripMode, "return", "新单不动");
    assert.equal(JSON.parse((await s.taskRow(oldId)).body).tripMode, undefined, "legacy 不打标");
    assert.ok(isLegacySample(JSON.parse((await s.taskRow(oldId)).body)));
    // _bak 留底（首次备份＝打标前）
    const bak = await s.db.all("SELECT id,body FROM _bak_067_trip_mode_task");
    assert.ok(bak.length >= before.length);
    const bakLegacy = bak.find((r) => r.id === legacyId);
    assert.equal(JSON.parse(bakLegacy.body).tripMode, undefined, "留底是打标前的 body");
    // 重跑幂等：逐字节不变
    const afterFirst = await s.db.all("SELECT id,body,status,kind FROM sample_task ORDER BY id");
    await up067(s.db);
    const afterSecond = await s.db.all("SELECT id,body,status,kind FROM sample_task ORDER BY id");
    assert.deepEqual(afterSecond, afterFirst, "067 重跑逐字节不变");
    // status/箱快照不动
    assert.equal((await s.taskRow(legacyId)).status, "待采样");
  } finally {
    await s.teardown();
  }
});

test("读时回算兜底保持：无 trip 存量合并单按首箱快照派生显示（stationFirst/oneWay），不改写 body", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const id = await s.policies.createTask({
      name: "无 trip 存量",
      kind: "采样",
      boxIds: [a.id],
      orgId: "2",
      fromOrgId: "2",
      toOrgId: "6",
      inspect: true,
      trip: "单向",
      tripDerived: true,
      senderId: "20",
      signerId: "60",
    });
    // 剥掉 trip/tripDerived/tripMode 模拟 059 前漏回填的存量；首箱建单快照改检测站（历史事实）
    const row = await s.taskRow(id);
    const body = JSON.parse(row.body);
    delete body.trip;
    delete body.tripDerived;
    delete body.tripMode;
    const stripped = JSON.stringify(body);
    await s.db.run("UPDATE sample_task SET body=? WHERE id=?", [stripped, id]);
    await s.db.run("UPDATE sample_task_box SET org_id='6' WHERE task_id=? AND box_id=?", [
      id,
      a.id,
    ]);
    const detail = await s.detailOf(id);
    assert.equal(detail.task.trip, "双向", "首箱快照在检测站→回算双向");
    assert.deepEqual(detail.task.steps, SAMPLE_ROUND_FLOW, "回算双向按站首腿渲染");
    assert.equal((await s.taskRow(id)).body, stripped, "视图注入不改写 body");
  } finally {
    await s.teardown();
  }
});

test("todo/counts：return 单已检测计入进行中＋检测站待办；已归还计已结束", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id], { trip: "双向" });
    const id = res.data.id;
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"], s.south);
    await s.advance(id, ["待检测"], s.leader);
    await s.advance(id, ["已检测"], s.station);
    // todo() 直接返回分组（内部方法，不经 ctx.ok）
    const todo = await s.controller.todo(s.station);
    assert.ok(
      todo.todo.list.some((t) => t.id === id),
      "已检测的 return 单在检测站待办里（发起寄回）"
    );
    const list = await s.run(s.controller.tasks.bind(s.controller), s.admin, { query: {} });
    assert.ok(list.ok);
    assert.equal(list.data.counts["已检测"], 1);
    assert.ok(list.data.counts["进行中"] >= 1, "return 单已检测计进行中");
    await s.advance(id, ["待寄回", "寄回在途", "待归还"], s.station);
    await s.advance(id, ["已归还"], s.south);
    const list2 = await s.run(s.controller.tasks.bind(s.controller), s.admin, { query: {} });
    assert.equal(list2.data.counts["已归还"], 1);
    assert.equal(list2.data.counts["进行中"], 0);
    // 状态筛选白名单含寄回腿四态
    const filtered = await s.run(s.controller.tasks.bind(s.controller), s.admin, {
      query: { status: "已归还" },
    });
    assert.equal(filtered.data.total, 1);
  } finally {
    await s.teardown();
  }
});

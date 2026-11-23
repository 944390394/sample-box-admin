/**
 * R22 trip 派生（任务 #55）服务端契约。
 *
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口、不重启任何服务。守住：
 * 1. 派生矩阵：箱在分公司/检测站/总部/未分配 × 采样单位 → 单向/双向（deriveTrip 单源）；
 * 2. 双向全腿：待寄出→运送中（检测站寄出，send||sign 双码门）→待采样（分公司确认到达，归属交采样单位）
 *    →采样中→已封箱→在途→待签收→待检测（签收归属回检测站）→已检测；首腿开箱计入任务上限；
 * 3. 双向退回：待检测发起，退回目的地＝寄出方 fromOrg＝检测站（PM 裁量），检测站自己接收退回；
 * 4. 单向首步待采样（箱在分公司）；跨分公司采样单位仍单向、寄出方＝箱归属；
 * 5. 混归属整单拒（同一任务单的箱子须同归属）；未分配箱归一总公司根；
 * 6. 锁内一致性：fromOrg/trip 与箱归属不符 → 409；客户端 trip 不作数（控制器派生权威）；
 * 7. 旧单回算：存量合并单无 trip → 按首箱建单快照 org 派生显示（视图注入，不改写 body/快照）；
 * 8. 059 幂等：按快照回填 body.trip/tripDerived，_bak 留底，重跑不变，legacy/箱快照/status 不动；
 * 9. R13④等价：双向单公司策略/阈值按采样分公司（建单兜底＋检测站期间 idle 层）。
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
import {
  deriveTrip,
  initialOf,
  isLegacySample,
  nextOf,
  SAMPLE_FLOW,
  SAMPLE_ROUND_FLOW,
  SAMPLE_ROUND_RETURN_FLOW,
  signTargetOf,
  stepsOf,
} from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { up as up059 } from "../migrations/059_trip_derived.js";
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
  "task:sign",
  "task:cancel",
]);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "trip-derived-"));
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
  // 检测站值守：只有 sign 拆分码（无 task:send），验证双码门
  const station = ctx(people.duty, ["1", "6"], STATION_PERMS);
  // 检测站长：指定签收人本人（正常签收只有他能签）
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
  const openAt = async (imei, opens, lng = 114.1, lat = 22.6) => {
    await ingest.accept(
      packet({
        imei,
        uart: `why=pad,opens=${opens},lid=0,fw=1.0.16,seq=${seq++}`,
        gpsfix: 1,
        lng,
        lat,
      })
    );
    await new Promise((r) => setTimeout(r, 30));
  };
  const moveBox = async (id, lng, lat) => {
    await boxes.updateBox(id, (item) => {
      item.gpsLng = lng;
      item.gpsLat = lat;
      item.lbsLng = lng;
      item.lbsLat = lat;
    });
  };
  const boxRow = (id) =>
    db.get("SELECT org_id,org,owner_id,owner,life FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = async (boxIds, extra = {}, actor = admin) => {
    const res = await run(controller.createTask.bind(controller), actor, {
      body: {
        name: "R22 派生方向",
        kind: "采样",
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
  /**
   * R28 契约演进：箱在检测站新建寄送单已拒（回分公司请用划拨），R22 站首腿（stationFirst）
   * 历史行只能来自迁移/旧库——直接造 R22 派生形状行（tripDerived＋双向、无 tripMode）供旧流回归。
   * 流程/交接/渲染断言原样保留（legacy 不混新）。
   */
  const seedRound = async (boxIds, extra = {}) => {
    const id = `TK-r22-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const body = {
      kind: "采样",
      name: "R22 站首腿历史单",
      boxIds,
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
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
      fromPlace: { address: "寄出仓库", lng: 114.1, lat: 22.6 },
      toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
      ...extra,
    };
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,1)",
      [id, body.name, "采样", "待寄出", JSON.stringify(body), new Date().toISOString(), "6", "6"]
    );
    for (const boxId of boxIds) {
      const b = await db.get("SELECT org_id, owner_id, opens FROM sample_box WHERE id=?", [boxId]);
      await db.run(
        "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,?)",
        [id, boxId, b.org_id, b.owner_id, Number(b.opens) || 0]
      );
    }
    // 建单日志（与 createTask 的 addTaskLog 同形状，流转记录全序断言用）
    await db.run(
      "INSERT INTO sample_task_log (id,task_id,status,action,actor_id,actor_name,note,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [`log-${id}`, id, "待寄出", "创建", "61", "检测站值守", "", null, new Date().toISOString()]
    );
    return id;
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
    openAt,
    moveBox,
    boxRow,
    taskRow,
    create,
    advance,
    seedRound,
    teardown,
  };
}

test("派生矩阵：箱归属×采样单位→trip；双向 9 步/单向 7 步；tripDerived 判别不污染 legacy", () => {
  // 箱在检测站＋采样单位是分公司 → 双向；采样单位＝检测站（非法但函数兜底）→ 单向
  assert.equal(deriveTrip("6", "6", "2"), "双向");
  assert.equal(deriveTrip("6", "6", "6"), "单向");
  // 箱在分公司/总部/未分配 → 恒单向（与采样单位无关）
  assert.equal(deriveTrip("2", "6", "2"), "单向");
  assert.equal(deriveTrip("2", "6", "3"), "单向");
  assert.equal(deriveTrip("1", "6", "2"), "单向");
  assert.equal(deriveTrip("", "6", "2"), "单向");
  // 检测站未解析 → 单向
  assert.equal(deriveTrip("6", "", "2"), "单向");
  const round = { kind: "采样", inspect: true, tripDerived: true, trip: "双向" };
  const one = { kind: "采样", inspect: true, tripDerived: true, trip: "单向" };
  assert.deepEqual(stepsOf(round), SAMPLE_ROUND_FLOW);
  assert.deepEqual(stepsOf(one), SAMPLE_FLOW);
  assert.equal(initialOf(round), "待寄出");
  assert.equal(initialOf(one), "待采样");
  assert.equal(signTargetOf(round), "待检测", "双向最终签收目标仍是待检测（首腿签收是确认到达）");
  assert.deepEqual(nextOf(round, "待寄出"), ["运送中", "已取消"]);
  assert.deepEqual(nextOf(round, "运送中"), ["待采样", "已取消"]);
  assert.deepEqual(nextOf(round, "待采样"), ["采样中", "已取消"]);
  assert.deepEqual(nextOf(round, "已检测"), ["退回中"]);
  assert.deepEqual(stepsOf({ ...round, status: "退回中" }), SAMPLE_ROUND_RETURN_FLOW);
  // 单向不允许首腿状态（nextOf 按当前状态键控，单向单不会停在首腿态）
  assert.deepEqual(nextOf(one, "待寄出"), []);
  assert.deepEqual(nextOf(one, "运送中"), []);
  // 判别：tripDerived 标记优先；无标记带 trip 恒旧（含 inspect=true 的旧双向）
  assert.equal(isLegacySample(round), false);
  assert.equal(isLegacySample(one), false);
  assert.equal(isLegacySample({ kind: "采样", trip: "双向", inspect: true }), true);
  assert.equal(isLegacySample({ kind: "采样", trip: "单向" }), true);
  assert.equal(isLegacySample({ kind: "采样", inspect: true }), false);
});

test("双向全腿（legacy stationFirst）：检测站寄出（sign 码即可）→分公司确认到达交接→采样封箱寄回→签收归属回检测站→已检测", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    // R28：站首腿历史单造库行（新建已拒箱在检测站）；旧流断言原样保留
    const id = await s.seedRound([a.id], { maxOpens: 2 });
    const row = await s.taskRow(id);
    assert.equal(row.status, "待寄出", "双向首步待寄出");
    assert.equal(row.from_org_id, "6", "寄出方＝箱当前归属（检测站）");
    assert.equal(row.to_org_id, "6", "接收方固定检测站");
    const body = JSON.parse(row.body);
    assert.equal(body.trip, "双向");
    assert.equal(body.tripDerived, true);
    assert.equal(body.orgId, "2", "采样单位＝所选分公司");
    assert.equal(body.fromOrgId, "6");
    assert.equal(body.senderId, "61", "寄出人＝检测站人员");
    let detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_ROUND_FLOW);
    assert.equal(detail.data.target.role, "寄出地址", "待寄出看寄出地址（检测站）");
    // 分公司不能寄出首腿（寄出归检测站）；检测站值守只有 sign 拆分码也能寄出（双码门）
    const wrongSend = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "运送中" },
    });
    assert.equal(wrongSend.ok, false);
    const southView = await s.run(s.controller.taskDetail.bind(s.controller), s.south, {
      params: { id },
    });
    assert.equal(southView.data.can["运送中"], false, "分公司不能寄出首腿（寄出归检测站）");
    await s.advance(id, ["运送中"], s.station);
    assert.equal((await s.boxRow(a.id)).org_id, "6", "首腿途中归属仍检测站");
    assert.equal((await s.boxRow(a.id)).life, "在途");
    assert.equal(
      (await s.db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [a.id])).task_id,
      id,
      "运送中即占用（沿用带寄送采样单口径）"
    );
    // 首腿途中开箱计入任务上限（寄出腿途中开箱超限标红的数据基础）
    await s.openAt(a.imei, 1);
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, { params: { id } });
    assert.equal(detail.data.boxes[0].opensDuring, 1);
    assert.equal(detail.data.target.role, "计划地点", "运送中朝采样点去");
    // 检测站不能替分公司确认到达；分公司确认到达＝首腿签收，归属交采样单位、保管人不动
    const ownerBefore = (await s.boxRow(a.id)).owner_id;
    const wrongArrive = await s.run(s.controller.transition.bind(s.controller), s.station, {
      params: { id },
      body: { status: "待采样" },
    });
    assert.equal(wrongArrive.ok, false);
    const arrive = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "待采样" },
    });
    assert.ok(arrive.ok, arrive.message);
    assert.deepEqual(arrive.data.handOver.moved, [a.id]);
    let box = await s.boxRow(a.id);
    assert.equal(box.org_id, "2", "首腿签收归属交采样单位");
    assert.equal(box.org, "华南分公司");
    assert.equal(box.owner_id, ownerBefore, "首腿无指定签收人，保管人不动（借出跟踪）");
    // 采样段→寄回→检测站签收：归属回检测站、保管人＝签收人
    await s.advance(id, ["采样中", "已封箱", "在途"], s.south);
    await s.moveBox(a.id, 114.3, 22.8);
    await s.advance(id, ["待签收"], s.station);
    const sign = await s.run(s.controller.transition.bind(s.controller), s.leader, {
      params: { id },
      body: { status: "待检测" },
    });
    assert.ok(sign.ok, sign.message);
    assert.deepEqual(sign.data.handOver.moved, [a.id], "寄回腿交接源＝采样单位（箱已交分公司）");
    box = await s.boxRow(a.id);
    assert.equal(box.org_id, "6");
    assert.equal(box.owner_id, "60", "最终签收保管人＝检测站签收人");
    await s.run(s.controller.inspect.bind(s.controller), s.station, {
      params: { id, boxId: a.id },
    });
    assert.equal((await s.taskRow(id)).status, "已检测");
    assert.equal((await s.boxRow(a.id)).life, "未使用");
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.station, { params: { id } });
    assert.deepEqual(
      detail.data.logs.map((l) => l.status),
      [
        "待寄出",
        "运送中",
        "待采样",
        "采样中",
        "已封箱",
        "在途",
        "待签收",
        "待检测",
        "待检测",
        "已检测",
      ]
    );
  } finally {
    await s.teardown();
  }
});

test("双向退回（legacy stationFirst）：目的地＝寄出方 fromOrg＝检测站（PM 裁量），检测站自己接收退回、保管人写回寄出人", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    const id = await s.seedRound([a.id]);
    await s.advance(id, ["运送中"], s.station);
    await s.advance(id, ["待采样", "采样中", "已封箱", "在途"], s.south);
    await s.moveBox(a.id, 114.3, 22.8);
    await s.advance(id, ["待签收"], s.station);
    await s.advance(id, ["待检测"], s.leader);
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    // 检测站发起退回
    await s.advance(id, ["退回中"], s.station);
    assert.equal((await s.boxRow(a.id)).org_id, "6", "退回中归属不动");
    const detail = await s.run(s.controller.taskDetail.bind(s.controller), s.station, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_ROUND_RETURN_FLOW);
    assert.equal(detail.data.target.role, "寄出地址");
    // 分公司不能接收退回（退回目的地＝检测站，接收归寄出方）
    const wrong = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "已退回" },
    });
    assert.equal(wrong.ok, false);
    const back = await s.run(s.controller.transition.bind(s.controller), s.station, {
      params: { id },
      body: { status: "已退回" },
    });
    assert.ok(back.ok, back.message);
    assert.equal((await s.taskRow(id)).status, "已退回");
    const box = await s.boxRow(a.id);
    assert.equal(box.org_id, "6", "双向退回回检测站（寄出方），归属不变");
    assert.equal(box.owner_id, "61", "保管人写回寄出人（检测站）");
    assert.equal(box.life, "未使用");
  } finally {
    await s.teardown();
  }
});

test("双向取消（legacy stationFirst）：首腿可取消（归属仍检测站）；分公司确认到达后取消，归属留在分公司（箱子实际已在现场）", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    const id1 = await s.seedRound([a.id]);
    await s.advance(id1, ["运送中"], s.station);
    await s.advance(id1, ["已取消"], s.station);
    assert.equal((await s.taskRow(id1)).status, "已取消");
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    assert.equal((await s.boxRow(a.id)).life, "未使用");
    // 确认到达后取消：归属已交分公司，取消不回滚归属（与物理事实一致）
    const b = await s.makeBox("6");
    const id2 = await s.seedRound([b.id]);
    await s.advance(id2, ["运送中"], s.station);
    await s.advance(id2, ["待采样"], s.south);
    await s.advance(id2, ["已取消"], s.station);
    assert.equal((await s.taskRow(id2)).status, "已取消");
    assert.equal((await s.boxRow(b.id)).org_id, "2", "已交接归属不随取消回滚");
    assert.equal((await s.boxRow(b.id)).life, "未使用");
  } finally {
    await s.teardown();
  }
});

test("单向首步：箱在分公司→待采样；跨分公司采样单位仍单向、寄出方＝箱归属、寄出人校验按寄出方", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const res = await s.create([a.id]);
    assert.ok(res.ok, res.message);
    const row = await s.taskRow(res.data.id);
    assert.equal(row.status, "待采样");
    assert.equal(JSON.parse(row.body).trip, "单向");
    assert.equal(row.from_org_id, "2");
    // 箱在华南、采样单位选华东：单向，寄出方＝华南（箱归属），寄出人必须是华南的人
    const b = await s.makeBox("2");
    const cross = await s.create([b.id], { orgId: "3", fromOrgId: "2", senderId: "20" });
    assert.ok(cross.ok, cross.message);
    const crossBody = JSON.parse((await s.taskRow(cross.data.id)).body);
    assert.equal(crossBody.trip, "单向");
    assert.equal(crossBody.fromOrgId, "2");
    assert.equal(crossBody.orgId, "3");
    // 寄出人写华东的人 → 拒绝（寄出人必须属寄出方华南）
    const w = await s.makeBox("2");
    const wrongSender = await s.create([w.id], { orgId: "3", senderId: "30" });
    assert.equal(wrongSender.ok, false);
    assert.match(wrongSender.message, /寄出人必须是华南分公司的人员/);
    // 采样单位＝检测站 → 拒绝（orgId 显式非法不回落）
    const v = await s.makeBox("2");
    const stationSampler = await s.create([v.id], { orgId: "6", fromOrgId: "2" });
    assert.equal(stationSampler.ok, false);
    assert.match(stationSampler.message, /采样单位不能是检测站/);
  } finally {
    await s.teardown();
  }
});

test("混归属整单拒：分公司×分公司、分公司×检测站都拒绝（同一任务单的箱子须同归属）", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const b = await s.makeBox("3");
    const mixed = await s.create([a.id, b.id]);
    assert.equal(mixed.ok, false);
    assert.match(mixed.message, /同一任务单的箱子须同归属/);
    const c = await s.makeBox("6");
    const mixedStation = await s.create([a.id, c.id]);
    assert.equal(mixedStation.ok, false);
    assert.match(mixedStation.message, /同一任务单的箱子须同归属/);
    // 同归属多台正常（R28：箱在分公司＋显式双向＝return 寄回腿；箱在检测站新建已拒，见 trip-return 用例）
    const d = await s.makeBox("2");
    const ok = await s.create([a.id, d.id], { trip: "双向" });
    assert.ok(ok.ok, ok.message);
    assert.equal((await s.taskRow(ok.data.id)).status, "待采样");
    assert.equal(JSON.parse((await s.taskRow(ok.data.id)).body).tripMode, "return");
  } finally {
    await s.teardown();
  }
});

test("未分配箱（org_id 空）归一总公司根：单向、寄出方＝总公司；锁内归属不一致/箱在检测站 409", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    await s.db.run("UPDATE sample_box SET org_id='', org='' WHERE id=?", [a.id]);
    // 寄出人须属寄出方（总公司根子树）：检测站长挂总公司下
    const res = await s.create([a.id], { fromOrgId: "1", senderId: "60" });
    assert.ok(res.ok, `${res.code} ${res.message}`);
    const body = JSON.parse((await s.taskRow(res.data.id)).body);
    assert.equal(body.trip, "单向");
    assert.equal(body.fromOrgId, "1", "未分配归一总公司根");
    // 服务层锁内复核：控制器派生后箱被改挂 → fromOrg 不一致 409
    const b = await s.makeBox("2");
    await assert.rejects(
      s.policies.createTask({
        name: "x",
        kind: "采样",
        inspect: true,
        trip: "单向",
        tripDerived: true,
        boxIds: [b.id],
        fromOrgId: "3",
        toOrgId: "6",
        orgId: "2",
      }),
      /箱子归属已变化/
    );
    // R28：箱在检测站却建寄送单 → 409「箱在检测站：回分公司请用划拨」（原「方向不一致」派生校验已废）
    const c = await s.makeBox("6");
    await assert.rejects(
      s.policies.createTask({
        name: "x",
        kind: "采样",
        inspect: true,
        trip: "单向",
        tripDerived: true,
        boxIds: [c.id],
        fromOrgId: "6",
        toOrgId: "6",
        orgId: "2",
      }),
      /箱在检测站：回分公司请用划拨/
    );
  } finally {
    await s.teardown();
  }
});

test("旧单回算：存量合并单无 trip→按首箱建单快照 org 派生显示（视图注入，不改写 body/箱快照）", async () => {
  const s = await setup();
  try {
    const insertLegacyMerged = async (id, snapshotOrg) => {
      await s.db.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,1)",
        [
          id,
          "存量合并单",
          "采样",
          "待采样",
          JSON.stringify({
            kind: "采样",
            name: "存量合并单",
            inspect: true,
            boxIds: ["B-X"],
            fromOrgId: "2",
            toOrgId: "6",
            orgId: "2",
          }),
          new Date().toISOString(),
          "2",
          "6",
        ]
      );
      if (snapshotOrg != null)
        await s.db.run(
          "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
          [id, "B-X", snapshotOrg, ""]
        );
    };
    await insertLegacyMerged("TK-old-station", "6");
    await insertLegacyMerged("TK-old-branch", "2");
    await insertLegacyMerged("TK-old-nobox", null);
    const detailOf = async (id) =>
      (await s.run(s.controller.taskDetail.bind(s.controller), s.admin, { params: { id } })).data
        .task;
    const atStation = await detailOf("TK-old-station");
    assert.equal(atStation.trip, "双向", "快照在检测站→回算双向");
    assert.equal(atStation.tripDerived, true);
    assert.deepEqual(atStation.steps, SAMPLE_ROUND_FLOW);
    const atBranch = await detailOf("TK-old-branch");
    assert.equal(atBranch.trip, "单向");
    assert.deepEqual(atBranch.steps, SAMPLE_FLOW);
    const noBox = await detailOf("TK-old-nobox");
    assert.equal(noBox.trip, undefined, "无箱快照不硬派生");
    assert.deepEqual(noBox.steps, SAMPLE_FLOW);
    // 不改写：body 与箱快照原样
    const raw = JSON.parse((await s.taskRow("TK-old-station")).body);
    assert.equal(raw.trip, undefined);
    assert.equal(raw.tripDerived, undefined);
    assert.equal(
      (await s.db.get("SELECT org_id FROM sample_task_box WHERE task_id='TK-old-station'")).org_id,
      "6"
    );
    // 列表同口径
    const list = await s.run(s.controller.tasks.bind(s.controller), s.admin, {
      query: { kind: "采样" },
    });
    const row = list.data.list.find((t) => t.id === "TK-old-station");
    assert.equal(row.trip, "双向");
  } finally {
    await s.teardown();
  }
});

test("059 幂等：按首箱快照回填 body.trip/tripDerived；_bak 留底；重跑不变；legacy/箱快照/status 不动", async () => {
  const s = await setup();
  try {
    const insert = async (id, { org, trip, inspect = true, status = "待采样", withBox = true }) => {
      await s.db.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          "存量",
          "采样",
          status,
          JSON.stringify({
            kind: "采样",
            inspect,
            boxIds: withBox ? ["B-Y"] : [],
            fromOrgId: "2",
            toOrgId: "6",
            orgId: "2",
            ...(trip ? { trip } : {}),
          }),
          new Date().toISOString(),
          "2",
          "6",
          inspect ? 1 : 0,
        ]
      );
      if (withBox)
        await s.db.run(
          "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,0)",
          [id, "B-Y", org, ""]
        );
    };
    await insert("TK-m-station", { org: "6" });
    await insert("TK-m-branch", { org: "2" });
    await insert("TK-m-legacy", { org: "2", trip: "双向", status: "待核验" });
    await insert("TK-m-oldsample", { org: "2", inspect: false, status: "已完成" });
    await insert("TK-m-nobox", { org: "2", withBox: false });
    const before = Object.fromEntries(
      await Promise.all(
        ["TK-m-station", "TK-m-branch", "TK-m-legacy", "TK-m-oldsample", "TK-m-nobox"].map(
          async (id) => [id, (await s.taskRow(id)).body]
        )
      )
    );
    // setup 的 migrate 已在空表上跑过 059（_bak 为空）；删掉模拟「059 前的存量库」再跑
    await s.db.run("DROP TABLE _bak_trip_derived_task");
    await up059(s.db);
    const after1 = JSON.parse((await s.taskRow("TK-m-station")).body);
    assert.equal(after1.trip, "双向");
    assert.equal(after1.tripDerived, true);
    const branch = JSON.parse((await s.taskRow("TK-m-branch")).body);
    assert.equal(branch.trip, "单向");
    assert.equal(branch.tripDerived, true);
    // legacy/旧采样/无快照不动
    for (const id of ["TK-m-legacy", "TK-m-oldsample", "TK-m-nobox"])
      assert.equal((await s.taskRow(id)).body, before[id], `${id} 不应被改写`);
    // status/箱快照不动
    assert.equal((await s.taskRow("TK-m-station")).status, "待采样");
    assert.equal(
      (await s.db.get("SELECT org_id FROM sample_task_box WHERE task_id='TK-m-station'")).org_id,
      "6"
    );
    // _bak 留底（首次备份含原始 body）
    const bak = await s.db.get("SELECT body FROM _bak_trip_derived_task WHERE id='TK-m-station'");
    assert.equal(bak.body, before["TK-m-station"]);
    // 重跑幂等：body 逐字节不变
    const snapshot = Object.fromEntries(
      await Promise.all(
        ["TK-m-station", "TK-m-branch", "TK-m-legacy", "TK-m-oldsample", "TK-m-nobox"].map(
          async (id) => [id, (await s.taskRow(id)).body]
        )
      )
    );
    await up059(s.db);
    for (const id of Object.keys(snapshot))
      assert.equal((await s.taskRow(id)).body, snapshot[id], `${id} 重跑应不变`);
    // 回填后读模型不再走读时回算（body 已有 trip），legacy 判别不受影响
    const detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id: "TK-m-station" },
    });
    assert.equal(detail.data.task.trip, "双向");
    assert.deepEqual(detail.data.task.steps, SAMPLE_ROUND_FLOW);
    const legacyDetail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id: "TK-m-legacy" },
    });
    assert.equal(isLegacySample(legacyDetail.data.task), true, "legacy 单回填后仍是旧流");
  } finally {
    await s.teardown();
  }
});

test("R13④等价：公司策略按采样分公司——新单建单兜底入快照；legacy stationFirst 检测站期间 idle 层随采样公司", async () => {
  const s = await setup();
  try {
    // 华南公司层：idle 300 秒、task 90 秒
    await s.db.run("INSERT INTO box_company_policy (dept_id,idle_json,task_json) VALUES (?,?,?)", [
      "2",
      JSON.stringify({ reportPeriodSec: 300, reportOnlyWhenCharging: false }),
      JSON.stringify({ reportPeriodSec: 90, reportOnlyWhenCharging: false }),
    ]);
    // R28 新单（箱在分公司）：空策略兜底取采样分公司（华南）task 层
    const n = await s.makeBox("2");
    const fresh = await s.create([n.id], { policy: null });
    assert.ok(fresh.ok, fresh.message);
    const freshBody = JSON.parse((await s.taskRow(fresh.data.id)).body);
    assert.equal(
      freshBody.policy.reportPeriodSec,
      90,
      "空策略兜底取采样分公司（华南）task 层，不是检测站/总公司"
    );
    assert.equal(freshBody.assignedPolicies[n.id].reportPeriodSec, 90);
    // legacy stationFirst（造库行）：旧固件 1.0.16 无快照优先，检测站期间 idle 层按采样分公司华南＝300
    const a = await s.makeBox("6");
    const id = await s.seedRound([a.id]);
    await s.advance(id, ["运送中"], s.station);
    await s.advance(id, ["待采样", "采样中", "已封箱", "在途"], s.south);
    await s.moveBox(a.id, 114.3, 22.8);
    await s.advance(id, ["待签收"], s.station);
    await s.advance(id, ["待检测"], s.leader);
    await s.run(s.controller.inspect.bind(s.controller), s.station, {
      params: { id, boxId: a.id },
    });
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    const boxRow = await s.db.get("SELECT id, firmware, org_id FROM sample_box WHERE id=?", [a.id]);
    const effective = (await s.policies.get(boxRow)).effective;
    assert.equal(effective.reportPeriodSec, 300, "检测站期间按采样分公司 idle（R13④双向等价）");
    assert.equal(effective.source, "公司默认");
  } finally {
    await s.teardown();
  }
});

test("双向首腿交接跳过守卫（legacy stationFirst）：建单后被改挂出检测站子树的箱子不随单交接", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("6");
    const b = await s.makeBox("6");
    const id = await s.seedRound([a.id, b.id]);
    await s.advance(id, ["运送中"], s.station);
    // 建单后 b 被资产纠错改挂到华东
    await s.boxes.updateBox(b.id, (item) => {
      item.orgId = "3";
      item.org = "华东分公司";
    });
    const arrive = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "待采样" },
    });
    assert.ok(arrive.ok, arrive.message);
    assert.deepEqual(arrive.data.handOver.moved, [a.id]);
    assert.deepEqual(arrive.data.handOver.skipped, [{ boxId: b.id, reason: "已改挂到华东分公司" }]);
    assert.equal((await s.boxRow(a.id)).org_id, "2");
    assert.equal((await s.boxRow(b.id)).org_id, "3", "改挂箱不被拉走");
  } finally {
    await s.teardown();
  }
});

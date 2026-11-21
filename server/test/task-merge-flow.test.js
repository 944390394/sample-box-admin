/**
 * 组织简化 B1a（P6/P7/P10/录音⑥）合并采样单服务端契约。
 *
 * 一次性临时库（mkdtemp），不碰开发库/线上库，不占任何服务端口、不重启任何服务。守住：
 * 1. 主路径全步：待采样→采样中→已封箱→在途→待签收→待检测→已检测，签收归属交检测站、开箱次数定住、逐台开始检测；
 * 2. 拒收：签收动作可选拒收→终态，不交接归属；
 * 3. 退回：待检测/已检测可发起退回，退回中→已退回，箱子归属在「已退回」回原寄出分公司 fromOrg；
 * 4. 取消时点：待签收之前可取消，待签收及之后不可；
 * 5. 接收方固定唯一检测站：总部/分公司作接收方拒绝；采样单位必须 type=公司 且≠检测站；
 * 6. station 解析三态（B1b resolveStation）：配置优先／DB 恰一个自动认定／无候选友好报错；
 * 7. 录像 gate：分公司（公司类型）可开、检测站恒禁；触发状态集 待采样/采样中/已封箱＋计划地点半径内；
 * 8. taskOptions 接收方候选只回 station（带负责人，签收人默认检测站负责人）。
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
import { VideoPlatform } from "../src/integration/VideoPlatform.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { readVideo } from "../src/settings/integrationConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { TaskVideoService } from "../src/settings/TaskVideoService.js";
import {
  SAMPLE_FLOW,
  SAMPLE_RETURN_FLOW,
  LEGACY_KIND_MAP,
  LEGACY_STATUS_MAP,
  ENDED_OK,
  ENDED_VOID,
  migrateKind,
  migrateStatus,
  isEnded,
  isLegacySample,
} from "../src/settings/taskFlow.js";
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
  "task:video",
  "task:camera",
  "task:policy",
]);

const ORG_NAMES = {
  1: "总公司",
  2: "华南分公司",
  3: "华东分公司",
  6: "总部检测站",
  7: "旧采样机构",
  21: "调度室",
};

async function setup({ station = "6" } = {}) {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: station },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-flow-"));
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
    ["7", "0", "旧采样机构", "采样机构"],
    ["21", "2", "调度室", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  await db.run("UPDATE sys_dept SET leader_user_id='60' WHERE id='6'");
  const people = {
    leader: { id: "60", nickname: "检测站长", deptId: "6" },
    inspector: { id: "61", nickname: "检测员", deptId: "6" },
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
  const videos = new TaskVideoService(db, new VideoPlatform(() => readVideo({})));
  controller.videos = videos;
  const ingest = new IngestService({
    boxes,
    policies,
    videos,
    cache: new MemoryStateCache(),
    hub: { publish() {} },
    clock: { now: () => new Date() },
    parser: new UplinkParser(),
  });
  const ctx = (person, orgIds) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: {
      perms: new Set(PERMS),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
      roles: [],
    },
    ip: "127.0.0.1",
  });
  const admin = ctx(people.south, null);
  const south = ctx(people.south, ["2", "21"]);
  const stationCtx = ctx(people.leader, ["1", "6"]);
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
    const imei = `8643170809${String(20000 + imeiSeq).padStart(5, "0")}`;
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
  const boxRow = (id) =>
    db.get("SELECT org_id,org,owner_id,owner,life,opens FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = async (boxIds, extra = {}, actor = admin) => {
    const res = await run(controller.createTask.bind(controller), actor, {
      body: {
        name: "合并采样单",
        kind: "采样",
        boxIds,
        fromOrgId: "2",
        senderId: "20",
        signerId: "60",
        placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
        fromPlace: { address: "华南仓库", lng: 114.1, lat: 22.6 },
        toPlace: { address: "检测站收发室", lng: 114.3, lat: 22.8 },
        ...extra,
      },
    });
    assert.ok(res.ok, `${res.code} ${res.message || res.msg}`);
    return res.data.id;
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
    videos,
    ctx,
    admin,
    south,
    stationCtx,
    people,
    run,
    makeBox,
    openAt,
    boxRow,
    taskRow,
    create,
    advance,
    teardown,
  };
}

test("主路径全步：建单固定检测站→采样→封箱→寄出→签收交接→逐台开始检测→已检测", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const b = await s.makeBox("2");
    const id = await s.create([a.id, b.id], { maxOpens: 5 });
    assert.match(id, /^TK-/);
    const row = await s.taskRow(id);
    assert.equal(row.kind, "采样");
    assert.equal(row.status, "待采样");
    assert.equal(row.to_org_id, "6");
    assert.equal(row.from_org_id, "2");
    assert.equal(Number(row.is_inspect), 1);
    const body = JSON.parse(row.body);
    assert.equal(body.inspect, true);
    assert.equal(body.orgId, "2", "采样单位＝寄出分公司");
    assert.equal(body.toOrgId, "6");
    // R22：trip 由箱归属派生（箱在分公司 2 → 单向），tripDerived 标记区分旧 trip 单
    assert.equal(body.trip, "单向", "R22 派生方向：箱在分公司＝单向");
    assert.equal(body.tripDerived, true);
    assert.equal(body.fromOrgId, "2", "寄出方＝箱当前归属");
    let detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_FLOW);
    // 建单即占用
    assert.equal((await s.boxRow(a.id)).life, "在途");
    // 分公司推进采样段；采样中开箱一次（计入本次任务，封箱前）
    await s.advance(id, ["采样中"], s.south);
    await s.openAt(a.imei, 1);
    await s.advance(id, ["已封箱", "在途"], s.south);
    assert.equal(
      (await s.db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [a.id])).task_id,
      id
    );
    // 箱子运抵检测站（收货地址附近），签收核验才放行
    for (const box of [a, b])
      await s.boxes.updateBox(box.id, (x) => {
        x.gpsLng = 114.3;
        x.gpsLat = 22.8;
        x.lbsLng = 114.3;
        x.lbsLat = 22.8;
      });
    // 检测站确认到达、签收：归属交检测站、保管人＝签收人、开箱次数定住
    await s.advance(id, ["待签收"], s.stationCtx);
    const sign = await s.run(s.controller.transition.bind(s.controller), s.stationCtx, {
      params: { id },
      body: { status: "待检测" },
    });
    assert.ok(sign.ok, sign.message);
    assert.deepEqual(sign.data.handOver.moved.sort(), [a.id, b.id].sort());
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    assert.equal((await s.boxRow(a.id)).owner_id, "60");
    // 检测时开箱不算进本次任务
    await s.openAt(a.imei, 2, 114.3, 22.8);
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.stationCtx, {
      params: { id },
    });
    assert.equal(detail.data.task.status, "待检测");
    assert.equal(detail.data.boxes.find((x) => x.id === a.id).opensDuring, 1);
    // 寄出分公司不能开始检测
    const denied = await s.run(s.controller.inspect.bind(s.controller), s.south, {
      params: { id, boxId: a.id },
    });
    assert.equal(denied.ok, false);
    assert.match(denied.message, /检测站/);
    // 逐台开始检测
    const first = await s.run(s.controller.inspect.bind(s.controller), s.stationCtx, {
      params: { id, boxId: a.id },
    });
    assert.deepEqual(first.data, { done: false, left: 1 });
    assert.equal((await s.boxRow(a.id)).life, "未使用");
    const last = await s.run(s.controller.inspect.bind(s.controller), s.stationCtx, {
      params: { id, boxId: b.id },
    });
    assert.deepEqual(last.data, { done: true, left: 0 });
    assert.equal((await s.taskRow(id)).status, "已检测");
    assert.equal((await s.boxRow(b.id)).life, "未使用");
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.stationCtx, {
      params: { id },
    });
    assert.ok(detail.data.boxes.every((x) => x.inspectedAt));
    assert.deepEqual(
      detail.data.logs.slice(-3).map((l) => l.action),
      ["开始检测", "开始检测", "检测完成"]
    );
  } finally {
    await s.teardown();
  }
});

test("拒收：签收动作可选拒收→终态，不交接归属、箱子回未使用", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const id = await s.create([a.id]);
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"], s.south);
    const reject = await s.run(s.controller.transition.bind(s.controller), s.stationCtx, {
      params: { id },
      body: { status: "已拒收", note: "样品破损" },
    });
    assert.ok(reject.ok, reject.message);
    assert.equal((await s.taskRow(id)).status, "已拒收");
    const row = await s.boxRow(a.id);
    assert.equal(row.org_id, "2", "拒收不交接归属");
    assert.equal(row.life, "未使用");
    assert.equal(reject.data.handOver, null);
  } finally {
    await s.teardown();
  }
});

test("退回（待检测发起）：退回中归属仍挂检测站，已退回回原寄出分公司、保管人写回寄出人", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const id = await s.create([a.id]);
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"]);
    await s.advance(id, ["待检测"], s.stationCtx);
    assert.equal((await s.boxRow(a.id)).org_id, "6", "签收后归检测站");
    // 退回原因必填
    const noNote = await s.run(s.controller.transition.bind(s.controller), s.stationCtx, {
      params: { id },
      body: { status: "退回中" },
    });
    assert.equal(noNote.ok, false);
    assert.match(noNote.message, /退回原因/);
    // 检测站发起退回
    await s.advance(id, ["退回中"], s.stationCtx);
    let row = await s.boxRow(a.id);
    assert.equal((await s.taskRow(id)).status, "退回中");
    assert.equal(row.org_id, "6", "退回中归属不动");
    assert.equal(row.life, "在途");
    let detail = await s.run(s.controller.taskDetail.bind(s.controller), s.south, {
      params: { id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_RETURN_FLOW);
    assert.equal(detail.data.target.role, "寄出地址");
    // 检测站不能替分公司接收退回
    const wrong = await s.run(s.controller.transition.bind(s.controller), s.stationCtx, {
      params: { id },
      body: { status: "已退回" },
    });
    assert.equal(wrong.ok, false);
    // 分公司接收退回：归属回 fromOrg
    const back = await s.run(s.controller.transition.bind(s.controller), s.south, {
      params: { id },
      body: { status: "已退回" },
    });
    assert.ok(back.ok, back.message);
    assert.equal((await s.taskRow(id)).status, "已退回");
    row = await s.boxRow(a.id);
    assert.equal(row.org_id, "2", "已退回归属回原寄出分公司");
    assert.equal(row.org, "华南分公司");
    assert.equal(row.owner_id, "20", "保管人写回寄出人");
    assert.equal(row.life, "未使用");
    assert.deepEqual(back.data.handOver, { moved: [a.id], skipped: [] });
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.south, { params: { id } });
    assert.deepEqual(
      detail.data.logs.slice(-2).map((l) => l.action),
      ["拒收并退回", "接收退回"]
    );
  } finally {
    await s.teardown();
  }
});

test("退回（已检测发起）：终态OK后仍可退回，已退回归属回原寄出分公司", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const id = await s.create([a.id]);
    await s.advance(id, ["采样中", "已封箱", "在途", "待签收"]);
    await s.advance(id, ["待检测"], s.stationCtx);
    await s.run(s.controller.inspect.bind(s.controller), s.stationCtx, {
      params: { id, boxId: a.id },
    });
    assert.equal((await s.taskRow(id)).status, "已检测");
    assert.equal((await s.boxRow(a.id)).org_id, "6");
    // 已检测仍可发起退回
    const can = await s.run(s.controller.taskDetail.bind(s.controller), s.stationCtx, {
      params: { id },
    });
    assert.equal(can.data.can["退回中"], true);
    await s.advance(id, ["退回中"], s.stationCtx);
    assert.equal((await s.boxRow(a.id)).life, "在途", "返程重新占用");
    await s.advance(id, ["已退回"], s.south);
    assert.equal((await s.taskRow(id)).status, "已退回");
    assert.equal((await s.boxRow(a.id)).org_id, "2");
    assert.equal((await s.boxRow(a.id)).life, "未使用");
  } finally {
    await s.teardown();
  }
});

test("取消时点：待签收之前可取消，待签收及之后不可取消", async () => {
  const s = await setup();
  try {
    // 待采样可取消
    const a = await s.makeBox("2");
    const id1 = await s.create([a.id]);
    await s.advance(id1, ["已取消"]);
    assert.equal((await s.taskRow(id1)).status, "已取消");
    assert.equal((await s.boxRow(a.id)).life, "未使用");
    // 采样中/已封箱/在途都可取消
    for (const stop of ["采样中", "已封箱", "在途"]) {
      const box = await s.makeBox("2");
      const id = await s.create([box.id]);
      const steps = ["采样中", "已封箱", "在途"].slice(
        0,
        ["采样中", "已封箱", "在途"].indexOf(stop) + 1
      );
      await s.advance(id, steps);
      await s.advance(id, ["已取消"]);
      assert.equal((await s.taskRow(id)).status, "已取消");
    }
    // 待签收不可取消
    const b = await s.makeBox("2");
    const id2 = await s.create([b.id]);
    await s.advance(id2, ["采样中", "已封箱", "在途", "待签收"]);
    const denied = await s.run(s.controller.transition.bind(s.controller), s.admin, {
      params: { id: id2 },
      body: { status: "已取消" },
    });
    assert.equal(denied.ok, false);
    assert.equal((await s.taskRow(id2)).status, "待签收");
  } finally {
    await s.teardown();
  }
});

test("接收方固定检测站：总部/分公司作接收方拒绝；采样单位必须公司类型且≠检测站", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    for (const toOrgId of ["1", "3"]) {
      const res = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
        body: {
          name: "x",
          kind: "采样",
          boxIds: [a.id],
          fromOrgId: "2",
          toOrgId,
          senderId: "20",
          signerId: "60",
        },
      });
      assert.equal(res.ok, false);
      assert.match(res.message, /接收方固定为唯一检测站/);
    }
    // 采样单位＝检测站：拒绝
    const station = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [a.id],
        fromOrgId: "6",
        senderId: "60",
        signerId: "60",
      },
    });
    assert.match(station.message, /采样单位不能是检测站/);
    // 采样单位非公司类型（旧采样机构）：拒绝
    const agency = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [a.id],
        fromOrgId: "7",
        senderId: "20",
        signerId: "60",
      },
    });
    assert.match(agency.message, /采样单位必须是分公司/);
    // 寄出人/签收人归属校验沿用
    const foreignSigner = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [a.id],
        fromOrgId: "2",
        senderId: "20",
        signerId: "20",
      },
    });
    assert.match(foreignSigner.message, /签收人必须是总部检测站的人员/);
    const foreignSender = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [a.id],
        fromOrgId: "2",
        senderId: "60",
        signerId: "60",
      },
    });
    assert.match(foreignSender.message, /寄出人必须是华南分公司的人员/);
    // R23：送检恢复新建（仅寄送，接收方固定检测站，IN- 前缀）；调拨仍只读停用
    const inspect = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "送检",
        boxIds: [a.id],
        fromOrgId: "2",
        toOrgId: "6",
        senderId: "20",
        signerId: "60",
      },
    });
    assert.ok(inspect.ok, `${inspect.code} ${inspect.message}`);
    assert.match(inspect.data.id, /^IN-/);
    const dispatch = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "调拨",
        boxIds: [a.id],
        fromOrgId: "2",
        toOrgId: "3",
        senderId: "20",
        signerId: "30",
      },
    });
    assert.match(dispatch.message, /调拨单已停用/);
  } finally {
    await s.teardown();
  }
});

test("station 解析（B1b）：未配置时 DB 恰一个候选自动认定；无候选友好报错（A0409）；显式配置优先", async () => {
  const s = await setup({ station: "" });
  try {
    // 未配置但 DB 总公司下恰一个检测站（6）→ resolveStation 自动认定，建单成功
    const a = await s.makeBox("2");
    const auto = await s.create([a.id]);
    assert.match(auto, /^TK-/);
    assert.equal((await s.taskRow(auto)).to_org_id, "6");
    // 无候选（6 改回公司）→ 友好报错 A0409（不是 500）
    await s.db.run("UPDATE sys_dept SET type='公司' WHERE id='6'");
    const b = await s.makeBox("2");
    const res = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [b.id],
        fromOrgId: "2",
        senderId: "20",
        signerId: "60",
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "A0409");
    assert.equal(res.status, 409);
    assert.match(res.message, /请先在系统设置指定唯一检测站/);
    // 配置后恢复（显式配置优先）
    await s.db.run("UPDATE sys_dept SET type='检测站' WHERE id='6'");
    applyBoxSettings({
      box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
    });
    const id = await s.create([b.id]);
    assert.match(id, /^TK-/);
  } finally {
    await s.teardown();
  }
});

test("录像 gate：分公司（公司类型）可开并在计划地点开箱触发；检测站恒禁", async () => {
  const s = await setup();
  try {
    const a = await s.makeBox("2");
    const id = await s.create([a.id], { recordVideo: true });
    assert.equal(JSON.parse((await s.taskRow(id)).body).recordVideo, true);
    await s.advance(id, ["采样中"]);
    // 计划地点半径内开箱→录像（平台未接入记下状态）
    await s.openAt(a.imei, 1, 114.1001, 22.6001);
    let detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id },
    });
    assert.equal(detail.data.videos.length, 1);
    assert.equal(detail.data.videos[0].status, "平台未接入");
    // 远离计划地点开箱不录
    await s.openAt(a.imei, 2, 114.9, 22.9);
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, { params: { id } });
    assert.equal(detail.data.videos.length, 1);
    // 检测站作采样单位被拒（恒禁录像）
    const station = await s.run(s.controller.createTask.bind(s.controller), s.admin, {
      body: {
        name: "x",
        kind: "采样",
        boxIds: [a.id],
        fromOrgId: "6",
        senderId: "60",
        signerId: "60",
        recordVideo: true,
      },
    });
    assert.equal(station.ok, false);
    // 监控通道取采样单位（分公司）：分公司没配通道时为空，不取检测站
    assert.deepEqual(detail.data.cameras, []);
  } finally {
    await s.teardown();
  }
});

test("taskOptions：接收方候选只回 station（带负责人），orgs 仍列分公司供采样单位选择", async () => {
  const s = await setup();
  try {
    const res = await s.run(s.controller.taskOptions.bind(s.controller), s.admin, { query: {} });
    assert.ok(res.ok, res.message);
    assert.equal(res.data.stationDeptId, "6");
    assert.equal(res.data.station.id, "6");
    assert.equal(res.data.station.name, "总部检测站");
    assert.deepEqual(res.data.station.leader, { id: "60", name: "检测站长" });
    // 签收人默认检测站负责人：station.leader 即默认签收人
    assert.ok(
      res.data.orgs.some((o) => o.id === "2"),
      "分公司仍在候选里（作采样单位）"
    );
    // 选检测站取人员：含站长
    const people = await s.run(s.controller.taskOptions.bind(s.controller), s.admin, {
      query: { orgId: "6" },
    });
    assert.ok(people.data.users.some((u) => u.id === "60"));
  } finally {
    await s.teardown();
  }
});

test("存量映射（P7）落库：旧 IN-/采样单按 LEGACY 映射改 kind/status 后走合并流渲染、终态语义保持、映射单射", async () => {
  const s = await setup();
  try {
    // 映射常量形状钉死（供 B1b 迁移 056 引用）：kind 送检→采样；状态分组映射、映射外同名
    assert.deepEqual(LEGACY_KIND_MAP, { 送检: "采样" });
    assert.deepEqual(LEGACY_STATUS_MAP.送检, { 待寄出: "已封箱", 运送中: "在途" });
    assert.deepEqual(LEGACY_STATUS_MAP.采样, {
      待核验: "待检测",
      已签收: "已检测",
      已完成: "已检测",
    });
    // 双射（单射到像集）＋终态语义：送检 9 态、旧采样终态归并，OK→OK / VOID→VOID，像都是合并流合法态
    const mergedStates = [...SAMPLE_FLOW, ...SAMPLE_RETURN_FLOW, "已拒收", "已取消"];
    const legacyInspect = [
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
    const mappedInspect = legacyInspect.map((st) => migrateStatus("送检", st));
    assert.equal(new Set(mappedInspect).size, mappedInspect.length, "送检状态映射单射");
    for (const st of legacyInspect) {
      const to = migrateStatus("送检", st);
      assert.ok(mergedStates.includes(to), `送检 ${st}→${to} 应是合并流合法态`);
      if (ENDED_OK.includes(st)) assert.ok(ENDED_OK.includes(to), `${st}→${to} 终态OK保持`);
      if (ENDED_VOID.includes(st)) assert.ok(ENDED_VOID.includes(to), `${st}→${to} 终态VOID保持`);
    }
    for (const st of ["待核验", "已签收", "已完成"]) {
      const to = migrateStatus("采样", st);
      assert.ok(mergedStates.includes(to));
      if (ENDED_OK.includes(st)) assert.ok(ENDED_OK.includes(to), `旧采样 ${st}→${to} 终态OK保持`);
      if (ENDED_VOID.includes(st))
        assert.ok(ENDED_VOID.includes(to), `旧采样 ${st}→${to} 终态VOID保持`);
    }
    // 终态归并：已签收/已完成（OK）→已检测（OK）；待核验（非终态）→待检测（非终态）
    assert.equal(migrateStatus("采样", "已签收"), "已检测");
    assert.equal(migrateStatus("采样", "已完成"), "已检测");
    assert.equal(migrateStatus("采样", "待核验"), "待检测");
    assert.ok(!isEnded("待检测") && isEnded("已检测"));
    // 落库：插三条历史单（旧送检在途前/旧送检终态/旧采样终态），按映射改 kind/status/body.kind，保留原 id/前缀
    // body.inspect 按真实旧单形状：旧送检建单恒写 inspect:true（M2 判别依据）；旧采样从不写 inspect。
    const legacy = [
      { id: "IN-1700000000001-a1", kind: "送检", status: "待寄出", name: "历史送检待寄" },
      { id: "IN-1700000000002-a2", kind: "送检", status: "已检测", name: "历史送检已检" },
      { id: "TK-1700000000003-a3", kind: "采样", status: "已完成", name: "旧采样已完成" },
    ];
    for (const row of legacy) {
      await s.db.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          row.id,
          row.name,
          row.kind,
          row.status,
          JSON.stringify({
            kind: row.kind,
            name: row.name,
            boxIds: [],
            fromOrgId: "2",
            toOrgId: "6",
            orgId: "2",
            ...(row.kind === "送检" ? { inspect: true } : {}),
          }),
          new Date().toISOString(),
          "2",
          "6",
          row.kind === "送检" ? 1 : 0,
        ]
      );
      const newKind = migrateKind(row.kind);
      const newStatus = migrateStatus(row.kind, row.status);
      const body = JSON.parse((await s.taskRow(row.id)).body);
      body.kind = newKind;
      await s.db.run("UPDATE sample_task SET kind=?, status=?, body=? WHERE id=?", [
        newKind,
        newStatus,
        JSON.stringify(body),
        row.id,
      ]);
    }
    // 待寄出→已封箱：保留 IN- 前缀（历史事实），读模型走合并主路径、不再是 legacy
    const r1 = await s.taskRow(legacy[0].id);
    assert.equal(r1.kind, "采样");
    assert.equal(r1.status, "已封箱");
    assert.match(r1.id, /^IN-/);
    let detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id: legacy[0].id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_FLOW);
    assert.equal(isLegacySample({ ...detail.data.task }), false);
    assert.equal(isEnded(detail.data.task.status), false);
    // 已检测（送检终态同名保留）：终态OK，进度条仍是合并主路径
    const r2 = await s.taskRow(legacy[1].id);
    assert.equal(r2.status, "已检测");
    assert.ok(ENDED_OK.includes(r2.status));
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id: legacy[1].id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_FLOW);
    assert.equal(isEnded(detail.data.task.status), true);
    // 旧采样 已完成→已检测（终态归并），合并流渲染
    const r3 = await s.taskRow(legacy[2].id);
    assert.equal(r3.kind, "采样");
    assert.equal(r3.status, "已检测");
    assert.ok(ENDED_OK.includes(r3.status));
    detail = await s.run(s.controller.taskDetail.bind(s.controller), s.admin, {
      params: { id: legacy[2].id },
    });
    assert.deepEqual(detail.data.task.steps, SAMPLE_FLOW);
  } finally {
    await s.teardown();
  }
});

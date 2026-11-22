/**
 * 任务单版式批（#68/R23 批之二）服务端契约：
 * 批5 sort 参数（默认最近更新＝sample_task_log MAX(created_at)；sort=created 切回；mineRows/bucket 内存路径同步）；
 * 批4 status 逗号多选与 kind 组合落地行数；R-c 非法筛选值统一忽略（不再静默 0 行）；
 * 批6 actions 显隐负向（参与方/终态/管理范围口径，前端按钮唯一来源）。
 * 一次性临时库，不碰开发/线上库、不占服务端口。setup 范式沿用 task-list-bucket.test.js（R22）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROLE_PERMS } from "../src/auth/permCatalog.js";
import { hashPassword } from "../auth.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const ORG_NAMES = { 1: "总公司", 2: "华南分公司", 13: "总部检测站", 21: "调度室" };
const permsOf = (code) => new Set(DEFAULT_ROLE_PERMS[code]);
/** R24（#70）二次确认夹具口令（仅测试用，非真实凭据）。 */
const CONFIRM_PW = "Layout-Fixture-2026";
const CONFIRM_HASH = hashPassword(CONFIRM_PW);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "13" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-list-layout-"));
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
  await db.run("UPDATE sys_dept SET leader_user_id='60' WHERE id='13'");
  for (const p of [
    { id: "60", nickname: "检测站长", deptId: "13" },
    { id: "20", nickname: "华南寄件人", deptId: "2" },
    { id: "21", nickname: "调度寄件人", deptId: "21" },
  ])
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,?,?,1)",
      [p.id, `u${p.id}`, p.nickname, CONFIRM_HASH, p.deptId]
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
  const ctx = (id, nickname, deptId, role, scope) => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: { perms: permsOf(role), scope, roles: [role] },
    ip: "127.0.0.1",
  });
  const all = { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const admin = ctx("20", "华南寄件人", "2", "ADMIN", all);
  // R24（#70）：ADMIN 模板（ALL_PERMS 派生）已不含 revoke；夹具显式补存量 inert 授权行语义，
  // 让下面直调 revokeTransfer 造「已撤销」历史单仍过单码校验（路由已封 410，不影响线上）。
  admin.access.perms.add("task:transfer:revoke");
  const duty = ctx("9101", "验收值班员", "14", "DUTY", all);
  const branch = ctx("9103", "华南管理员", "2", "BRANCH_ADMIN", {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: [],
    manageOrgIds: ["2", "21"],
  });
  const dispatch = ctx("6", "陈可", "21", "DISPATCH", {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: [],
    manageOrgIds: ["21"],
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
  const makeBox = async (orgId = "21", name = "") => {
    imeiSeq += 1;
    const imei = `8643170809${String(50000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(
      packet({ imei, uart: `why=boot,opens=0,fw=1.0.16,seq=${seq++}` })
    );
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
      item.org = ORG_NAMES[orgId] || "";
      if (name) item.name = name;
    });
    return { id: box.id, imei };
  };
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = (body, actor = admin) =>
    run(controller.createTask.bind(controller), actor, { body });
  const advance = (id, status, actor = admin, note = "") =>
    run(controller.transition.bind(controller), actor, { params: { id }, body: { status, note } });
  const tasks = (actor, query) => run(controller.tasks.bind(controller), actor, { query });
  const teardown = async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    db,
    boxes,
    controller,
    admin,
    duty,
    branch,
    dispatch,
    run,
    makeBox,
    taskRow,
    create,
    advance,
    tasks,
    teardown,
  };
}

const place = { address: "华南采样点", lng: 114.1, lat: 22.6 };
const merged = (boxId, name, extra = {}) => ({
  name,
  kind: "采样后送检",
  boxIds: [boxId],
  orgId: "21",
  fromOrgId: "21",
  senderId: "21",
  signer: "检测站长",
  placeAt: place,
  ...extra,
});

/** 覆盖三类型＋终态＋划拨两态的种子集。 */
async function seed(s) {
  const b1 = await s.makeBox("2");
  const localWait = await s.create({
    name: "本地待采样",
    kind: "采样",
    localOnly: true,
    boxIds: [b1.id],
    placeAt: place,
  });
  const b2 = await s.makeBox("21");
  const mWait = await s.create(merged(b2.id, "合并待采样"));
  const b3 = await s.makeBox("21");
  const mSampling = await s.create(merged(b3.id, "合并采样中"));
  await s.advance(mSampling.data.id, "采样中");
  const b4 = await s.makeBox("21");
  const mInspected = await s.create(merged(b4.id, "合并已检测"));
  for (const st of ["采样中", "已封箱", "在途", "待签收", "待检测", "已检测"])
    await s.advance(mInspected.data.id, st);
  const b5 = await s.makeBox("2");
  const localDone = await s.create({
    name: "本地已封箱",
    kind: "采样",
    localOnly: true,
    boxIds: [b5.id],
    placeAt: place,
  });
  await s.advance(localDone.data.id, "采样中");
  await s.advance(localDone.data.id, "已封箱");
  const b6 = await s.makeBox("21");
  const mCancel = await s.create(merged(b6.id, "合并已取消"));
  await s.advance(mCancel.data.id, "已取消");
  const b7 = await s.makeBox("21");
  const insp = await s.create({
    name: "送检待寄出",
    kind: "送检",
    boxIds: [b7.id],
    senderId: "21",
    signerId: "60",
  });
  // 划拨两态：提交即生效一张＋撤销一张
  const b8 = await s.makeBox("21");
  const al = await s.run(s.controller.createTransfer.bind(s.controller), s.admin, {
    body: { name: "划拨已生效", toOrgId: "2", boxIds: [b8.id], password: CONFIRM_PW },
  });
  const b9 = await s.makeBox("21");
  const alRev = await s.run(s.controller.createTransfer.bind(s.controller), s.admin, {
    body: { name: "划拨已撤销", toOrgId: "2", boxIds: [b9.id], password: CONFIRM_PW },
  });
  await s.run(s.controller.revokeTransfer.bind(s.controller), s.admin, {
    params: { id: alRev.data.id },
    body: { reason: "验收撤销" },
  });
  // 管理范围负向用：orgId=2/fromOrgId=2 的合并单（dispatch 管理范围仅 21）
  const b10 = await s.makeBox("2");
  const mForeign = await s.create(
    merged(b10.id, "上级公司单", { orgId: "2", fromOrgId: "2", senderId: "20" })
  );
  return { localWait, mWait, mSampling, mInspected, localDone, mCancel, insp, al, alRev, mForeign };
}

/** 把一张单的创建时间与全部日志时间钉到固定 ISO（排序断言不依赖真实时钟毫秒）。 */
async function pinTimes(s, id, createdIso, logIso) {
  await s.db.run("UPDATE sample_task SET created_at=? WHERE id=?", [createdIso, id]);
  await s.db.run("UPDATE sample_task_log SET created_at=? WHERE task_id=?", [logIso, id]);
}

test("批5：sort 默认最近更新（日志 MAX），sort=created 切回；updatedAt 同源", async () => {
  const s = await setup();
  try {
    const seedRows = await seed(s);
    const a = seedRows.mWait.data.id; // 建得早但最近被推进
    const b = seedRows.mSampling.data.id; // 建得晚但没再动
    await s.advance(a, "采样中"); // 真实推进写一条新日志
    await pinTimes(s, a, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
    await pinTimes(s, b, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    // a 的推进日志钉到最近（模拟「老单刚被推进」）
    await s.db.run("UPDATE sample_task_log SET created_at=? WHERE task_id=? AND status='采样中'", [
      "2026-11-22T00:00:00.000Z",
      a,
    ]);
    const ids = (res) => res.data.list.map((r) => r.id);
    const def = await s.tasks(s.admin, { status: "全部", pageSize: 100 });
    assert.ok(def.ok, def.message);
    assert.ok(
      ids(def).indexOf(a) < ids(def).indexOf(b),
      "默认最近更新：刚推进的老单应浮到新建单前面"
    );
    const byCreated = await s.tasks(s.admin, { status: "全部", sort: "created", pageSize: 100 });
    assert.ok(ids(byCreated).indexOf(b) < ids(byCreated).indexOf(a), "sort=created：创建序不变");
    const badSort = await s.tasks(s.admin, { status: "全部", sort: "乱写", pageSize: 100 });
    assert.deepEqual(ids(badSort), ids(def), "非法 sort 回落默认最近更新");
    const rowA = def.data.list.find((r) => r.id === a);
    assert.equal(rowA.updatedAt, "2026-11-22T00:00:00.000Z", "updatedAt＝最近流转日志时间");
    const rowB = def.data.list.find((r) => r.id === b);
    assert.equal(rowB.updatedAt, "2026-11-21T00:00:00.000Z");
    // 无日志老行兜底：COALESCE 回创建时间（删光日志模拟 022 前存量）
    await s.db.run("DELETE FROM sample_task_log WHERE task_id=?", [b]);
    const fallback = await s.tasks(s.admin, { status: "全部", pageSize: 100 });
    assert.equal(
      fallback.data.list.find((r) => r.id === b).updatedAt,
      "2026-11-21T00:00:00.000Z",
      "无日志行 updatedAt 兜底创建时间"
    );
  } finally {
    await s.teardown();
  }
});

test("批5：mineRows 与 bucket 内存路径排序同步（D4＋D1 窗口不变）", async () => {
  const s = await setup();
  try {
    const seedRows = await seed(s);
    const a = seedRows.mWait.data.id;
    const b = seedRows.mSampling.data.id;
    await s.advance(a, "采样中");
    await pinTimes(s, a, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
    await pinTimes(s, b, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    await s.db.run("UPDATE sample_task_log SET created_at=? WHERE task_id=? AND status='采样中'", [
      "2026-11-22T00:00:00.000Z",
      a,
    ]);
    const ids = (res) => res.data.list.map((r) => r.id);
    const mine = await s.tasks(s.admin, { mine: "1", pageSize: 100 });
    assert.ok(mine.ok, mine.message);
    assert.ok(ids(mine).indexOf(a) < ids(mine).indexOf(b), "mine 默认最近更新同步");
    const mineCreated = await s.tasks(s.admin, { mine: "1", sort: "created", pageSize: 100 });
    assert.ok(ids(mineCreated).indexOf(b) < ids(mineCreated).indexOf(a), "mine sort=created 同步");
    const bucket = await s.tasks(s.admin, { mine: "1", bucket: "sampling", pageSize: 100 });
    assert.ok(ids(bucket).indexOf(a) < ids(bucket).indexOf(b), "bucket 内存路径排序同步");
    const bucketCreated = await s.tasks(s.admin, {
      mine: "1",
      bucket: "sampling",
      sort: "created",
      pageSize: 100,
    });
    assert.ok(ids(bucketCreated).indexOf(b) < ids(bucketCreated).indexOf(a));
    // D1 窗口不变：mine 计数仍与 todo 同源（500 窗口 created_at 序）
    const todo = await s.controller.todo(s.admin);
    assert.equal(mine.data.total, todo.todo.total, "mine 总数仍==todo（窗口序未改）");
  } finally {
    await s.teardown();
  }
});

test("批4：status 逗号多选落地行数＝counts 同态之和；与 kind/mine 组合", async () => {
  const s = await setup();
  try {
    await seed(s);
    const base = await s.tasks(s.admin, { status: "全部", pageSize: 100 });
    const counts = base.data.counts;
    const multi = await s.tasks(s.admin, { status: "待采样,采样中", pageSize: 100 });
    assert.ok(multi.ok, multi.message);
    assert.equal(
      multi.data.total,
      (counts["待采样"] || 0) + (counts["采样中"] || 0),
      "多选落地＝counts 同态之和"
    );
    assert.ok(
      multi.data.list.every((r) => ["待采样", "采样中"].includes(r.status)),
      "落地行均在所选状态内"
    );
    // kind 组合：采样后送检 里再筛两态
    const kindCombo = await s.tasks(s.admin, {
      kind: "采样后送检",
      status: "待采样,采样中",
      pageSize: 100,
    });
    const kindBase = await s.tasks(s.admin, { kind: "采样后送检", status: "全部", pageSize: 100 });
    assert.equal(
      kindCombo.data.total,
      (kindBase.data.counts["待采样"] || 0) + (kindBase.data.counts["采样中"] || 0)
    );
    assert.ok(kindCombo.data.list.every((r) => r.displayKind === "采样后送检"));
    // 划拨两态切换口径：kind=划拨 时 status=已划拨,已撤销 落地两张
    const al = await s.tasks(s.admin, { kind: "划拨", status: "已划拨,已撤销", pageSize: 100 });
    assert.equal(al.data.total, 2);
    assert.deepEqual(al.data.list.map((r) => r.status).sort(), ["已划拨", "已撤销"].sort());
    // 划拨×物流态＝合法筛选但无匹配（0 行是事实不是 R-c）
    const alNone = await s.tasks(s.admin, { kind: "划拨", status: "待采样", pageSize: 100 });
    assert.equal(alNone.data.total, 0);
    // 默认三类白名单不含划拨（R23 口径不变）
    assert.ok(!base.data.list.some((r) => r.kind === "划拨"));
    // mine＋多选：mine 真子集且行均在所选态
    const mineMulti = await s.tasks(s.admin, { mine: "1", status: "待采样,采样中", pageSize: 100 });
    const mineAll = await s.tasks(s.admin, { mine: "1", pageSize: 100 });
    assert.ok(mineMulti.data.total > 0 && mineMulti.data.total <= mineAll.data.total);
    assert.ok(mineMulti.data.list.every((r) => ["待采样", "采样中"].includes(r.status)));
    // 伪态＋具体态 OR：进行中,已取消 ＝ 进行中全量＋已取消
    const orMix = await s.tasks(s.admin, { status: "进行中,已取消", pageSize: 100 });
    assert.equal(orMix.data.total, counts["进行中"] + (counts["已取消"] || 0));
    // 单选行为与 R22 一致（等值）
    const single = await s.tasks(s.admin, { status: "待采样", pageSize: 100 });
    assert.equal(single.data.total, counts["待采样"]);
  } finally {
    await s.teardown();
  }
});

test("批4/R-c：非法 status/sort 值忽略该筛选（不再静默 0 行），非法 kind 回落三类", async () => {
  const s = await setup();
  try {
    await seed(s);
    const all = await s.tasks(s.admin, { status: "全部", pageSize: 100 });
    const bad = await s.tasks(s.admin, { status: "不存在的状态", pageSize: 100 });
    assert.ok(bad.ok, bad.message);
    assert.equal(bad.data.total, all.data.total, "非法 status 忽略＝无筛选（R-c 修）");
    const mixed = await s.tasks(s.admin, { status: "待采样,不存在的状态", pageSize: 100 });
    const good = await s.tasks(s.admin, { status: "待采样", pageSize: 100 });
    assert.equal(mixed.data.total, good.data.total, "多选里非法成员被丢弃，合法成员生效");
    // 旧书签 status=全部 不再 0 行（忽略＝全量）
    const legacyAll = await s.tasks(s.admin, { status: "全部", pageSize: 100 });
    assert.equal(legacyAll.data.total, all.data.total);
    // mine 路径同口径：非法 status 不把我过滤成空
    const mineBad = await s.tasks(s.admin, { mine: "1", status: "不存在的状态", pageSize: 100 });
    const mine = await s.tasks(s.admin, { mine: "1", pageSize: 100 });
    assert.equal(mineBad.data.total, mine.data.total);
    // 非法 kind 回落三类白名单（R22 口径不变）
    const badKind = await s.tasks(s.admin, { kind: "乱写", status: "全部", pageSize: 100 });
    assert.equal(badKind.data.total, all.data.total);
    // 空串/纯逗号＝无筛选
    const empty = await s.tasks(s.admin, { status: ",,", pageSize: 100 });
    assert.equal(empty.data.total, all.data.total);
  } finally {
    await s.teardown();
  }
});

test("批6：actions 显隐负向——非参与方/终态/管理范围外无动作，按钮唯一来源服务端", async () => {
  const s = await setup();
  try {
    const seedRows = await seed(s);
    const listOf = async (actor, query = {}) => {
      const res = await s.tasks(actor, { status: "全部", pageSize: 100, ...query });
      assert.ok(res.ok, res.message);
      return res.data.list;
    };
    const rowOf = (list, id) => list.find((r) => r.id === id);
    const adminList = await listOf(s.admin);
    const dutyList = await listOf(s.duty);
    const dispatchList = await listOf(s.dispatch);
    const branchList = await listOf(s.branch);
    // 参与方 admin：合并待采样有采样步；duty（全部范围非 ADMIN）同单无动作（R-b）
    const waitId = seedRows.mWait.data.id;
    assert.ok(rowOf(adminList, waitId).actions.includes("采样中"));
    assert.deepEqual(rowOf(dutyList, waitId).actions, [], "duty 非参与方 actions 恒空");
    // 管理范围负向：dispatch（manage 仅 21）对 orgId=2 单无动作；branch（manage 2/21）有
    const foreignId = seedRows.mForeign.data.id;
    assert.deepEqual(rowOf(dispatchList, foreignId).actions, [], "管理范围外无动作");
    assert.ok(rowOf(branchList, foreignId).actions.includes("采样中"));
    // 终态无动作：本地已封箱／已取消 对 admin 也恒空
    assert.deepEqual(rowOf(adminList, seedRows.localDone.data.id).actions, []);
    assert.deepEqual(rowOf(adminList, seedRows.mCancel.data.id).actions, []);
    // 已检测＝终态但可退回：参与方仅 [退回中]；duty 空
    assert.deepEqual(rowOf(adminList, seedRows.mInspected.data.id).actions, ["退回中"]);
    assert.deepEqual(rowOf(dutyList, seedRows.mInspected.data.id).actions, []);
    // 划拨无物流动作（只能走撤销端点）；默认三类白名单不含划拨，须 allKinds 才看得到
    const allKindsList = await listOf(s.admin, { allKinds: "1" });
    assert.deepEqual(rowOf(allKindsList, seedRows.al.data.id).actions, []);
    // 无动作行不进 mine（待我处理＝有取消以外动作）
    const mine = await s.tasks(s.dispatch, { mine: "1", pageSize: 100 });
    assert.ok(!mine.data.list.some((r) => r.id === foreignId), "无动作行不算待我处理");
    const mineAdmin = await s.tasks(s.admin, { mine: "1", pageSize: 100 });
    assert.ok(
      !mineAdmin.data.list.some((r) => r.id === seedRows.localDone.data.id),
      "终态行不进 mine"
    );
    // 送检待寄出：寄出方参与方有运送中；duty 无
    assert.ok(rowOf(adminList, seedRows.insp.data.id).actions.includes("运送中"));
    assert.deepEqual(rowOf(dutyList, seedRows.insp.data.id).actions, []);
  } finally {
    await s.teardown();
  }
});

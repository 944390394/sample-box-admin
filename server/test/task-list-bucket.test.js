/**
 * 任务单最小可上线子集（#65/R22）服务端契约：
 * 批2 KPI 一卡一筛（bucket 与 todo 同谓词）＋ mine+status 可组合；
 * 批3 IMEI 检索门控（D7：无设备标识权限整串 IMEI 0 命中，已命名箱名称搜仍命中）；
 * R-b 越权写探针负向（数据范围=全部的非 ADMIN 角色不能推进他单位采样/检测步）。
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

const ORG_NAMES = { 1: "总公司", 2: "华南分公司", 13: "总部检测站", 21: "调度室" };
const permsOf = (code) => new Set(DEFAULT_ROLE_PERMS[code]);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "13" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-list-bucket-"));
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
  // 角色 ctx：admin/duty 全部范围（角色不同）；branch/dispatch 本公司可见、管理范围不同。
  const ctx = (id, nickname, deptId, role, scope) => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: { perms: permsOf(role), scope, roles: [role] },
    ip: "127.0.0.1",
  });
  const all = { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const admin = ctx("20", "华南寄件人", "2", "ADMIN", all);
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
    const imei = `8643170809${String(40000 + imeiSeq).padStart(5, "0")}`;
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
  const todo = (actor) => controller.todo(actor);
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
    todo,
    teardown,
  };
}

/** 建一组覆盖各桶的任务（admin 建单＋推进，确保参与方放行）。返回箱子/单号映射。 */
async function seedBuckets(s) {
  const place = { address: "华南采样点", lng: 114.1, lat: 22.6 };
  const merged = (boxId, name, extra = {}) => ({
    name,
    kind: "采样后送检",
    boxIds: [boxId],
    orgId: "21",
    fromOrgId: "21",
    senderId: "21",
    // 只写签收人姓名不写 signerId：admin（全范围＝接收方）才能正常签收推进（与 acceptance-setup 夹具同口径）
    signer: "检测站长",
    placeAt: place,
    ...extra,
  });
  // sampling：本地待采样＋合并待采样
  const b1 = await s.makeBox("2", "验收命名箱A");
  const local = await s.create({
    name: "本地待采样",
    kind: "采样",
    localOnly: true,
    boxIds: [b1.id],
    placeAt: place,
  });
  const b2 = await s.makeBox("21");
  const mWait = await s.create(merged(b2.id, "合并待采样"));
  // arrive：合并在途（can 待签收）
  const b3 = await s.makeBox("21");
  const mMoving = await s.create(merged(b3.id, "合并在途"));
  await s.advance(mMoving.data.id, "采样中");
  await s.advance(mMoving.data.id, "已封箱");
  await s.advance(mMoving.data.id, "在途");
  // sign：合并待签收（can 待检测）
  const b4 = await s.makeBox("21");
  const mSign = await s.create(merged(b4.id, "合并待签收"));
  for (const st of ["采样中", "已封箱", "在途", "待签收"]) await s.advance(mSign.data.id, st);
  // returning：合并退回中（can 已退回）
  const b5 = await s.makeBox("21");
  const mReturn = await s.create(merged(b5.id, "合并退回中"));
  for (const st of ["采样中", "已封箱", "在途", "待签收", "待检测"])
    await s.advance(mReturn.data.id, st);
  await s.advance(mReturn.data.id, "退回中", s.admin, "样品不合格退回");
  // send：送检待寄出（can 运送中）
  const b6 = await s.makeBox("21");
  const insp = await s.create({
    name: "送检待寄出",
    kind: "送检",
    boxIds: [b6.id],
    senderId: "21",
    signerId: "60",
  });
  // overLimit：合并 maxOpens=2，DB 置 opens_start=0/箱 opens=5 → 超限 3 台口径
  const b7 = await s.makeBox("21");
  const mOver = await s.create(merged(b7.id, "合并开箱超限", { maxOpens: 2 }));
  await s.db.run("UPDATE sample_task_box SET opens_start=0 WHERE task_id=?", [mOver.data.id]);
  await s.db.run("UPDATE sample_box SET opens=5 WHERE id=?", [b7.id]);
  return { b1, local, mWait, mMoving, mSign, mReturn, insp, mOver };
}

test("批2：各角色 bucket 落地计数 == todo 同桶计数（一卡一筛，D1）", async () => {
  const s = await setup();
  try {
    await seedBuckets(s);
    const buckets = ["send", "arrive", "sign", "returning", "sampling"];
    for (const [name, actor] of [
      ["admin", s.admin],
      ["branch", s.branch],
      ["dispatch", s.dispatch],
      ["duty", s.duty],
    ]) {
      const t = await s.todo(actor);
      assert.ok(t, `${name} todo 不应为 null`);
      for (const bucket of buckets) {
        const res = await s.tasks(actor, { mine: "1", bucket, pageSize: 100 });
        assert.ok(res.ok, res.message);
        assert.equal(res.data.total, t[bucket].total, `${name} bucket=${bucket} 落地!=todo`);
        // 落地行确实命中该桶（与 todo 列表同 id 集）
        const wantIds = new Set(t[bucket].list.map((x) => x.id));
        for (const row of res.data.list)
          assert.ok(wantIds.has(row.id) || t[bucket].total > 5, `${name} ${bucket} 行不在 todo 桶`);
      }
      // overLimit 桶不带 mine（todo.overLimit 含只能取消的单）
      const over = await s.tasks(actor, { bucket: "overLimit", pageSize: 100 });
      assert.equal(over.data.total, t.overLimit.total, `${name} overLimit 落地!=todo`);
    }
    // admin 各桶非空（夹具确实覆盖）
    const t = await s.todo(s.admin);
    for (const bucket of [...buckets, "overLimit"])
      assert.ok(t[bucket].total > 0, `admin ${bucket} 应非空`);
    // R-b 收紧后 duty（全部范围非 ADMIN）不再是任何单的参与方 → 待办归零
    const dutyTodo = await s.todo(s.duty);
    assert.equal(dutyTodo.todo.total, 0, "duty 全部范围非 ADMIN 不应有可推进待办");
  } finally {
    await s.teardown();
  }
});

test("批2：mine=1 与 status 可组合（mineRows 上内存过滤，P1-4）", async () => {
  const s = await setup();
  try {
    await seedBuckets(s);
    const all = await s.tasks(s.admin, { mine: "1", pageSize: 100 });
    const waitSample = await s.tasks(s.admin, { mine: "1", status: "待采样", pageSize: 100 });
    assert.ok(waitSample.ok, waitSample.message);
    assert.ok(
      waitSample.data.total > 0 && waitSample.data.total < all.data.total,
      "mine+status 应是 mine 的真子集"
    );
    assert.ok(
      waitSample.data.list.every((r) => r.status === "待采样"),
      "落地行状态须均为待采样"
    );
    // mine+bucket+status 三者组合：sampling 桶里再筛待采样
    const combo = await s.tasks(s.admin, {
      mine: "1",
      bucket: "sampling",
      status: "待采样",
      pageSize: 100,
    });
    assert.ok(combo.data.list.every((r) => r.status === "待采样"));
    assert.ok(combo.data.total <= waitSample.data.total);
    // 已结束与 mine 组合恒空（mine 窗口只含进行中）
    const ended = await s.tasks(s.admin, { mine: "1", status: "已结束", pageSize: 100 });
    assert.equal(ended.data.total, 0);
    // 非法 bucket 静默忽略（回落普通 mine 列表）
    const bad = await s.tasks(s.admin, { mine: "1", bucket: "不存在的桶", pageSize: 100 });
    assert.equal(bad.data.total, all.data.total);
  } finally {
    await s.teardown();
  }
});

test("批3：IMEI 检索门控（D7）——无标识权限整串 IMEI 0 命中、有权限命中、已命名箱名称搜仍命中", async () => {
  const s = await setup();
  try {
    const seed = await seedBuckets(s);
    const imei = seed.b1.imei; // 命名箱A 绑在本地待采样单上
    // 有设备标识权限（ADMIN）：整串 IMEI 命中
    const pos = await s.tasks(s.admin, { q: imei, pageSize: 100 });
    assert.ok(pos.data.total >= 1, "有标识权限整串 IMEI 应命中");
    assert.ok(pos.data.list.some((r) => r.id === seed.local.data.id));
    // 无设备标识权限（BRANCH_ADMIN 模板无 iccid/imsi/firmware）：整串 IMEI 0 命中
    const neg = await s.tasks(s.branch, { q: imei, pageSize: 100 });
    assert.equal(neg.data.total, 0, "无标识权限整串 IMEI 应 0 命中");
    const negDispatch = await s.tasks(s.dispatch, { q: imei, pageSize: 100 });
    assert.equal(negDispatch.data.total, 0, "调度员无标识权限整串 IMEI 应 0 命中");
    // 已命名箱按名称搜：有无标识权限都命中（b.name 保留现状）
    const byNameAdmin = await s.tasks(s.admin, { q: "验收命名箱A", pageSize: 100 });
    const byNameBranch = await s.tasks(s.branch, { q: "验收命名箱A", pageSize: 100 });
    assert.ok(byNameAdmin.data.total >= 1, "管理员按名称搜应命中");
    assert.ok(byNameBranch.data.total >= 1, "无标识权限按已命名箱名称搜仍应命中");
    assert.ok(byNameBranch.data.list.some((r) => r.id === seed.local.data.id));
    // 任务名/单号搜不受门控影响
    const byTaskName = await s.tasks(s.branch, { q: "本地待采样", pageSize: 100 });
    assert.ok(byTaskName.data.total >= 1, "按任务名搜不受 IMEI 门控影响");
  } finally {
    await s.teardown();
  }
});

test("R-b：全部范围非 ADMIN（DUTY）不能推进他单位采样/检测步；ADMIN 与参与方仍可", async () => {
  const s = await setup();
  try {
    const seed = await seedBuckets(s);
    const id = seed.mWait.data.id; // 合并待采样，orgId=21（duty dept=14 非参与方）
    // duty 读 can：待采样态的下一步（采样中/已取消）都不应恒真
    const dutyDetail = await s.run(s.controller.taskDetail.bind(s.controller), s.duty, {
      params: { id },
    });
    assert.equal(dutyDetail.data.can["采样中"], false, "duty 不应有采样中推进权");
    assert.equal(dutyDetail.data.can["已取消"], false, "duty 不应有取消权");
    // duty 写推进 → 403，状态不变
    const adv = await s.advance(id, "采样中", s.duty, "越权探针");
    assert.equal(adv.ok, false);
    assert.equal(adv.status, 403);
    assert.equal((await s.taskRow(id)).status, "待采样", "越权推进不得改状态");
    // duty 对他单位待检测单整单开始检测 → 403
    const b = await s.makeBox("21");
    const mInsp = await s.create({
      name: "待检测单",
      kind: "采样后送检",
      boxIds: [b.id],
      orgId: "21",
      fromOrgId: "21",
      senderId: "21",
      signer: "检测站长",
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    for (const st of ["采样中", "已封箱", "在途", "待签收", "待检测"])
      await s.advance(mInsp.data.id, st);
    const dutyInsp = await s.advance(mInsp.data.id, "已检测", s.duty, "越权检测");
    assert.equal(dutyInsp.ok, false);
    assert.equal(dutyInsp.status, 403);
    assert.equal((await s.taskRow(mInsp.data.id)).status, "待检测");
    // ADMIN 仍可推进（参与方门不误伤管理员）
    const adminAdv = await s.advance(id, "采样中", s.admin);
    assert.ok(adminAdv.ok, adminAdv.message);
    assert.equal((await s.taskRow(id)).status, "采样中");
    // 参与方 branch（manageOrgIds 含 21）仍可推进采样段
    const b2 = await s.makeBox("21");
    const m2 = await s.create({
      name: "分公司单",
      kind: "采样后送检",
      boxIds: [b2.id],
      orgId: "21",
      fromOrgId: "21",
      senderId: "21",
      signerId: "60",
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    const branchAdv = await s.advance(m2.data.id, "采样中", s.branch);
    assert.ok(branchAdv.ok, branchAdv.message);
    // dispatch 管理范围仅 21：orgId=21 的单可推进；orgId=2 的单不可（管理范围口径）
    const b3 = await s.makeBox("2");
    const m3 = await s.create({
      name: "上级公司单",
      kind: "采样后送检",
      boxIds: [b3.id],
      orgId: "2",
      fromOrgId: "2",
      senderId: "20",
      signerId: "60",
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    const dispatchOwn = await s.advance(m2.data.id, "已封箱", s.dispatch);
    assert.ok(dispatchOwn.ok, "dispatch 应能推进管理范围 21 的单");
    const dispatchForeign = await s.advance(m3.data.id, "采样中", s.dispatch);
    assert.equal(dispatchForeign.ok, false, "dispatch 管理范围仅 21，不应推进 orgId=2 的单");
  } finally {
    await s.teardown();
  }
});

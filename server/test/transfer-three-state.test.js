/**
 * R25 划拨三态（任务 #71，迁移 064）核心契约。
 *
 * 一次性临时库（mkdtemp，同 transfer-allocation.test.js 写法），不碰开发库/线上库，不占服务端口。守住：
 * 1. 三态流转：创建→待接受→（目标管理员）接受→已完成；创建方取消→已取消；接收方拒收→已拒收；
 *    接受后不可再接受/取消/拒收（终态只读），待接受才能动作。
 * 2. 接受归属转移＋保管人清空（事务内）；取消/拒收箱不动（归属/保管人原样）。
 * 3. 拒收原因必填（空/超 100 → 400）；取消备注选填。
 * 4. 快递单号三态权限：创建选填 ≤64；接受前创建方可补填/修改/清空；非创建方拒；接受后只读（409）。
 * 5. abilities 矩阵（态×角色）：待接受×目标方=接受+拒收、×创建方=取消+补单号、×第三方=只读；
 *    已完成=重新划拨（持建单码）；终态只读。
 * 6. todo 桶：transferAccept（接收方）/transferCancel（创建方），与 tasks()?bucket= 落地同口径。
 * 7. 064 迁移：历史已划拨→已完成（legacyTransfer 标、接受人不伪造）＋BRANCH_ADMIN 补 accept 码；跑两遍不变。
 * 8. scan/receive displayKind additive（划拨=划拨）。
 * 夹具口令均为测试值（非真实凭据）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../auth.js";
import { DEFAULT_ROLE_PERMS } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { up as up064 } from "../migrations/064_transfer_three_state.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { packet } from "./fixture.js";

const ORG_NAMES = {
  1: "总公司",
  2: "深圳分公司",
  3: "广州分公司",
  4: "花都检测站",
  5: "第三方公司",
};
const CONFIRM_PW = "ThreeState-Fixture-2026";
const CONFIRM_HASH = hashPassword(CONFIRM_PW);

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "4" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-3state-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["2", "1", "深圳分公司", "公司"],
    ["3", "1", "广州分公司", "公司"],
    ["4", "1", "花都检测站", "检测站"],
    ["5", "1", "第三方公司", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  const people = {
    creator: { id: "101", nickname: "创建方管理员", deptId: "2" },
    target: { id: "201", nickname: "目标方管理员", deptId: "3" },
    third: { id: "301", nickname: "第三方管理员", deptId: "5" },
    admin: { id: "2", nickname: "系统管理员", deptId: "1" },
  };
  for (const p of Object.values(people))
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
  /** 角色化 ctx：BRANCH_ADMIN 按 manageOrgIds 划参与方门；orgIds 是数据可见范围（创建划拨目标须在内）。 */
  const ctxRole = (role, person, manageOrgIds, orgIds = manageOrgIds) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: {
      perms: new Set(DEFAULT_ROLE_PERMS[role]),
      scope: { all: role === "ADMIN", orgIds, manageOrgIds, ownerIds: [] },
      roles: [role],
    },
    ip: "127.0.0.1",
  });
  const creator = () => ctxRole("BRANCH_ADMIN", people.creator, ["2"], ["2", "3", "5"]);
  const target = () => ctxRole("BRANCH_ADMIN", people.target, ["3"], ["3"]);
  const third = () => ctxRole("BRANCH_ADMIN", people.third, ["5"], ["5"]);
  const admin = () =>
    ctxRole("ADMIN", people.admin, ["1", "2", "3", "4", "5"], ["1", "2", "3", "4", "5"]);
  /** 第三方只读视角：持建单码可进页、数据范围可见此单，但 manageOrgIds 不含来源/目标、非创建方→abilities 全 false。 */
  const viewer = () => ctxRole("BRANCH_ADMIN", people.third, ["5"], ["2", "3", "5"]);
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
  const makeBox = async (orgId, { life = "未使用", ownerId = "", owner = "" } = {}) => {
    imeiSeq += 1;
    const imei = `8643170809${String(20000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(packet({ imei, uart: "why=boot,opens=0,seq=1" }));
    await boxes.updateBox(box.id, (item) => {
      item.life = life;
      item.orgId = orgId;
      item.org = ORG_NAMES[orgId] || "";
      item.ownerId = ownerId;
      item.owner = owner;
    });
    return box.id;
  };
  const boxRow = (id) =>
    db.get("SELECT org_id,org,owner_id,owner,life FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = (actor, boxIds, extra = {}) =>
    run(controller.createTransfer.bind(controller), actor, {
      body: { name: "三态夹具", toOrgId: "3", boxIds, password: CONFIRM_PW, ...extra },
    });
  const teardown = async () => {
    applyBoxSettings({});
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    db,
    boxes,
    policies,
    controller,
    run,
    makeBox,
    boxRow,
    taskRow,
    create,
    creator,
    target,
    third,
    admin,
    viewer,
    people,
    teardown,
  };
}

test("R25 三态流转：创建待接受→目标管理员接受已完成（归属转移＋保管人清空）；接受后终态只读", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2", { ownerId: "101", owner: "创建方管理员" });
    const b2 = await s.makeBox("2");
    const created = await s.create(s.creator(), [b1, b2], { trackingNo: "SF0001" });
    assert.ok(created.ok, `${created.code} ${created.message}`);
    assert.equal(created.data.status, "待接受");
    assert.equal((await s.boxRow(b1)).org_id, "2", "创建归属不动");
    assert.equal((await s.boxRow(b1)).owner_id, "101", "创建保管人不清空");
    // 创建方不能接受（非目标方）；第三方也不能
    const creatorAccept = await s.run(s.controller.acceptTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(creatorAccept.code, "A0301");
    const thirdAccept = await s.run(s.controller.acceptTransfer.bind(s.controller), s.third(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(thirdAccept.code, "A0404", "第三方不可见→404（可见性先于参与方门）");
    // 目标管理员接受：归属转移＋保管人清空＋审计
    const accepted = await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.ok(accepted.ok, `${accepted.code} ${accepted.message}`);
    assert.equal(accepted.data.status, "已完成");
    assert.equal(accepted.data.acceptedBy, "目标方管理员");
    assert.equal(accepted.data.count, 2);
    for (const id of [b1, b2]) {
      const row = await s.boxRow(id);
      assert.equal(row.org_id, "3");
      assert.equal(row.org, "广州分公司");
      assert.equal(row.owner_id, "", "接受清空保管人");
      assert.equal(row.owner, "");
    }
    assert.equal((await s.taskRow(created.data.id)).status, "已完成");
    const log = await s.db.get(
      "SELECT * FROM sample_task_log WHERE task_id=? AND action='接受划拨'",
      [created.data.id]
    );
    assert.equal(log.actor_id, "201");
    assert.equal(log.status, "已完成");
    // 接受后不可再接受/取消/拒收（终态只读）
    const again = await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(again.code, "A0409");
    const cancelAfter = await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(cancelAfter.code, "A0409");
    const rejectAfter = await s.run(s.controller.rejectTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: { reason: "迟了" },
    });
    assert.equal(rejectAfter.code, "A0409");
    // 详情：接受人/时间事实＋当前归属目标＋保管人空
    const detail = await s.run(s.controller.transferDetail.bind(s.controller), s.target(), {
      params: { id: created.data.id },
    });
    assert.equal(detail.data.acceptedBy, "目标方管理员");
    assert.ok(detail.data.acceptedAt);
    assert.equal(detail.data.boxes[0].orgId, "3");
    assert.equal(detail.data.boxes[0].owner, "");
    assert.equal(detail.data.abilities.retransfer, true, "已完成可重新划拨");
    assert.equal(detail.data.abilities.accept, false);
  } finally {
    await s.teardown();
  }
});

test("R25 创建方取消：箱不动（归属/保管人原样）、单作废已取消；非创建方不可取消；备注选填", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2", { ownerId: "101", owner: "创建方管理员" });
    const created = await s.create(s.creator(), [b1]);
    const before = await s.boxRow(b1);
    // 目标方/第三方不可取消（创建方专属）
    const targetCancel = await s.run(s.controller.cancelTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(targetCancel.code, "A0301");
    const thirdCancel = await s.run(s.controller.cancelTransfer.bind(s.controller), s.third(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.equal(thirdCancel.code, "A0404", "第三方不可见→404");
    // 创建方取消（备注选填，空也可）
    const cancelled = await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.ok(cancelled.ok, `${cancelled.code} ${cancelled.message}`);
    assert.equal(cancelled.data.status, "已取消");
    assert.deepEqual(await s.boxRow(b1), before, "取消箱不动");
    assert.equal((await s.taskRow(created.data.id)).status, "已取消");
    // 备注超 100 → 400
    const b2 = await s.makeBox("2");
    const c2 = await s.create(s.creator(), [b2]);
    const longNote = await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: c2.data.id },
      body: { note: "x".repeat(101) },
    });
    assert.equal(longNote.status, 400);
    // ADMIN 可取消（管理口径）
    const adminCancel = await s.run(s.controller.cancelTransfer.bind(s.controller), s.admin(), {
      params: { id: c2.data.id },
      body: { note: "管理员代取消" },
    });
    assert.ok(adminCancel.ok, `${adminCancel.code} ${adminCancel.message}`);
    assert.equal(adminCancel.data.status, "已取消");
  } finally {
    await s.teardown();
  }
});

test("R25 接收方拒收：原因必填（空/超100→400）、箱不动、已拒收终态；非目标方不可拒收", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2", { ownerId: "101", owner: "创建方管理员" });
    const created = await s.create(s.creator(), [b1]);
    const before = await s.boxRow(b1);
    // 空原因 / 超 100 → 400
    const empty = await s.run(s.controller.rejectTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: { reason: "" },
    });
    assert.equal(empty.status, 400);
    assert.match(empty.message, /请填写拒收原因/);
    const long = await s.run(s.controller.rejectTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: { reason: "x".repeat(101) },
    });
    assert.equal(long.status, 400);
    // 创建方/第三方不可拒收（接收方专属）
    const creatorReject = await s.run(s.controller.rejectTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { reason: "不要" },
    });
    assert.equal(creatorReject.code, "A0301");
    // 目标方拒收：箱不动＋原因记审计
    const rejected = await s.run(s.controller.rejectTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: { reason: "暂不需要箱子" },
    });
    assert.ok(rejected.ok, `${rejected.code} ${rejected.message}`);
    assert.equal(rejected.data.status, "已拒收");
    assert.equal(rejected.data.rejectReason, "暂不需要箱子");
    assert.deepEqual(await s.boxRow(b1), before, "拒收箱不动");
    const detail = await s.run(s.controller.transferDetail.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
    });
    assert.equal(detail.data.rejectReason, "暂不需要箱子");
    assert.equal(detail.data.rejectedBy, "目标方管理员");
    assert.equal(detail.data.abilities.cancel, false, "终态只读");
  } finally {
    await s.teardown();
  }
});

test("R25 快递单号三态权限：创建选填≤64；接受前创建方可补填/改/清空；非创建方拒；接受后只读", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    // 创建选填：不填→空；超 64→400
    const created = await s.create(s.creator(), [b1]);
    assert.equal(created.data.trackingNo, "");
    const tooLong = await s.create(s.creator(), [await s.makeBox("2")], {
      trackingNo: "x".repeat(65),
    });
    assert.equal(tooLong.status, 400);
    // 接受前创建方补填
    const fill = await s.run(s.controller.trackingTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { trackingNo: "SF1234567890" },
    });
    assert.ok(fill.ok, `${fill.code} ${fill.message}`);
    assert.equal(fill.data.trackingNo, "SF1234567890");
    // 修改
    const edit = await s.run(s.controller.trackingTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { trackingNo: "YT999" },
    });
    assert.equal(edit.data.trackingNo, "YT999");
    // 非创建方（目标方/第三方）不可补填
    const targetFill = await s.run(s.controller.trackingTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: { trackingNo: "HACK" },
    });
    assert.equal(targetFill.code, "A0301");
    // 清空（空串＝选填语义）
    const clear = await s.run(s.controller.trackingTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { trackingNo: "" },
    });
    assert.equal(clear.data.trackingNo, "");
    // 接受后只读：再补填 → 409
    await s.run(s.controller.trackingTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { trackingNo: "SF777" },
    });
    const accepted = await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: {},
    });
    assert.ok(accepted.ok, accepted.message);
    const afterAccept = await s.run(s.controller.trackingTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: { trackingNo: "SF888" },
    });
    assert.equal(afterAccept.code, "A0409");
    assert.match(afterAccept.message, /只读/);
    const detail = await s.run(s.controller.transferDetail.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
    });
    assert.equal(detail.data.trackingNo, "SF777", "接受后单号定格");
    assert.equal(detail.data.abilities.tracking, false);
  } finally {
    await s.teardown();
  }
});

test("R25 abilities 矩阵（态×角色）：待接受目标方接受+拒收/创建方取消+补单号/第三方只读；已完成重新划拨", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const created = await s.create(s.creator(), [b1]);
    const id = created.data.id;
    const abilitiesOf = async (actor) =>
      (await s.run(s.controller.transferDetail.bind(s.controller), actor, { params: { id } })).data
        .abilities;
    // 待接受
    const t = await abilitiesOf(s.target());
    assert.deepEqual(t, {
      accept: true,
      reject: true,
      cancel: false,
      tracking: false,
      retransfer: false,
    });
    const c = await abilitiesOf(s.creator());
    assert.deepEqual(c, {
      accept: false,
      reject: false,
      cancel: true,
      tracking: true,
      retransfer: false,
    });
    const x = await abilitiesOf(s.viewer());
    assert.deepEqual(x, {
      accept: false,
      reject: false,
      cancel: false,
      tracking: false,
      retransfer: false,
    });
    const a = await abilitiesOf(s.admin());
    assert.equal(a.accept, true, "ADMIN 可接受");
    assert.equal(a.cancel, true, "ADMIN 可取消");
    // 已完成：重新划拨（持建单码），接受/取消/拒收/补单号全 false
    await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id },
      body: {},
    });
    const done = await abilitiesOf(s.target());
    assert.deepEqual(done, {
      accept: false,
      reject: false,
      cancel: false,
      tracking: false,
      retransfer: true,
    });
    // 已取消/已拒收：终态只读
    const b2 = await s.makeBox("2");
    const c2 = await s.create(s.creator(), [b2]);
    await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: c2.data.id },
      body: {},
    });
    const cancelled = (
      await s.run(s.controller.transferDetail.bind(s.controller), s.creator(), {
        params: { id: c2.data.id },
      })
    ).data.abilities;
    assert.deepEqual(cancelled, {
      accept: false,
      reject: false,
      cancel: false,
      tracking: false,
      retransfer: false,
    });
  } finally {
    await s.teardown();
  }
});

test("R25 todo 桶：transferAccept（接收方）/transferCancel（创建方），tasks()?bucket= 落地同口径", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const created = await s.create(s.creator(), [b1]);
    // todo() 直接返回分组对象（workbench 包装下发）；接收方 transferAccept 命中
    const targetTodo = await s.controller.todo(s.target());
    assert.equal(targetTodo.transferAccept.total, 1);
    assert.equal(targetTodo.transferAccept.list[0].id, created.data.id);
    assert.equal(targetTodo.transferCancel.total, 0);
    // 创建方 todo：transferCancel 命中
    const creatorTodo = await s.controller.todo(s.creator());
    assert.equal(creatorTodo.transferCancel.total, 1);
    assert.equal(creatorTodo.transferAccept.total, 0);
    // 第三方：两桶都不命中
    const thirdTodo = await s.controller.todo(s.third());
    assert.equal(thirdTodo.transferAccept.total, 0);
    assert.equal(thirdTodo.transferCancel.total, 0);
    // tasks()?bucket=transferAccept 落地（自动 kind=划拨）==卡片数字
    const land = await s.run(s.controller.tasks.bind(s.controller), s.target(), {
      query: { bucket: "transferAccept" },
    });
    assert.ok(land.ok, land.message);
    assert.equal(land.data.total, 1);
    assert.equal(land.data.list[0].id, created.data.id);
    const landCancel = await s.run(s.controller.tasks.bind(s.controller), s.creator(), {
      query: { bucket: "transferCancel" },
    });
    assert.equal(landCancel.data.total, 1);
    // 接受后：接收方桶清空（终态不再待接受）
    await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      body: {},
    });
    const afterTodo = await s.controller.todo(s.target());
    assert.equal(afterTodo.transferAccept.total, 0);
  } finally {
    await s.teardown();
  }
});

test("R25 列表 counts/页签口径：待接受/已结束（已完成+已取消+已拒收）/已撤销·历史＋状态 chips 多选", async () => {
  const s = await setup();
  try {
    const mk = async () => s.makeBox("2");
    const a = await s.create(s.creator(), [await mk()]); // 待接受
    const b = await s.create(s.creator(), [await mk()]);
    await s.run(s.controller.acceptTransfer.bind(s.controller), s.target(), {
      params: { id: b.data.id },
      body: {},
    }); // 已完成
    const c = await s.create(s.creator(), [await mk()]);
    await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: c.data.id },
      body: {},
    }); // 已取消
    const d = await s.create(s.creator(), [await mk()]);
    await s.run(s.controller.rejectTransfer.bind(s.controller), s.target(), {
      params: { id: d.data.id },
      body: { reason: "不要" },
    }); // 已拒收
    const list = await s.run(s.controller.transfers.bind(s.controller), s.creator(), {});
    assert.equal(list.data.counts.全部, 4);
    assert.equal(list.data.counts.待接受, 1);
    assert.equal(list.data.counts.已完成, 1);
    assert.equal(list.data.counts.已取消, 1);
    assert.equal(list.data.counts.已拒收, 1);
    assert.equal(list.data.counts.已结束, 3);
    assert.equal(list.data.counts.boxCountTotal, 4);
    // 已结束页签＝三终态合集
    const ended = await s.run(s.controller.transfers.bind(s.controller), s.creator(), {
      query: { status: "已结束" },
    });
    assert.equal(ended.data.total, 3);
    // chips 多选：已完成+已取消
    const chips = await s.run(s.controller.transfers.bind(s.controller), s.creator(), {
      query: { status: "已完成,已取消" },
    });
    assert.equal(chips.data.total, 2);
    // 待接受页签
    const pending = await s.run(s.controller.transfers.bind(s.controller), s.creator(), {
      query: { status: "待接受" },
    });
    assert.equal(pending.data.total, 1);
    assert.equal(pending.data.list[0].id, a.data.id);
    // 行 abilities＋单号＋终态事实
    const row = ended.data.list.find((r) => r.id === d.data.id);
    assert.equal(row.rejectReason, "不要");
    assert.equal(row.abilities.cancel, false);
  } finally {
    await s.teardown();
  }
});

test("R25 scan/receive displayKind additive：划拨单 displayKind=划拨，既有字段不变", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const created = await s.create(s.creator(), [b1]);
    const scan = await s.run(s.controller.scan.bind(s.controller), s.creator(), {
      params: { id: b1 },
    });
    assert.ok(scan.ok, scan.message);
    const task = scan.data.tasks.find((t) => t.id === created.data.id);
    assert.ok(task, "扫码应列出待接受划拨单");
    assert.equal(task.kind, "划拨");
    assert.equal(task.displayKind, "划拨");
    assert.equal(task.status, "待接受");
    assert.equal(task.active, true, "待接受是进行中态");
    // receive：划拨无签收模式（none），displayKind 同样下发
    const receive = await s.run(s.controller.receive.bind(s.controller), s.target(), {
      params: { id: created.data.id },
      query: { boxId: b1 },
    });
    assert.ok(receive.ok, receive.message);
    assert.equal(receive.data.task.displayKind, "划拨");
    assert.equal(receive.data.mode, "none", "划拨不走签收核验");
  } finally {
    await s.teardown();
  }
});

test("R25 迁移 064：历史已划拨→已完成（legacyTransfer 标、接受人不伪造）＋BRANCH_ADMIN 补 accept 码；跑两遍不变", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-064-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    // migrate 已跑过一次 064（空库→备份表为空）； drops 掉空备份，让本用例的「首跑」捕获存量形态
    await db.run("DROP TABLE IF EXISTS _bak_064_transfer_three_state_sample_task");
    await db.run("DROP TABLE IF EXISTS _bak_064_transfer_three_state_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_064_transfer_three_state_sys_dept_perm");
    // migrate 不种角色（种子在 prepareHome）；本用例自造 BRANCH_ADMIN 存量角色（模拟 064 前无 accept 码）
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status,create_time,update_time) VALUES ('14','分公司管理员','BRANCH_ADMIN',2,14,1,'','')"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('14','device:box:list',1)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('14','task:create:transfer',1)"
    );
    await db.run(
      "INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('14','sys:user:role',1)"
    );
    // 构造存量形态：一张历史已划拨单（无 legacyTransfer 标）
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES ('AL-hist-1','历史划拨','划拨','已划拨',?,?,NULL,'3',0)",
      [
        JSON.stringify({
          kind: "划拨",
          name: "历史划拨",
          toOrg: "广州分公司",
          toOrgId: "3",
          createdBy: "古人",
          createdById: "999",
        }),
        new Date().toISOString(),
      ]
    );
    const branch = await db.get("SELECT id FROM sys_role WHERE code='BRANCH_ADMIN'");
    assert.ok(branch, "自造 BRANCH_ADMIN 角色");
    // 第一遍：映射＋补码
    await up064(db);
    const row1 = await db.get("SELECT status, body FROM sample_task WHERE id='AL-hist-1'");
    assert.equal(row1.status, "已完成");
    const body1 = JSON.parse(row1.body);
    assert.equal(body1.legacyTransfer, true);
    assert.equal(body1.acceptedBy, undefined, "接受人不伪造");
    assert.equal(body1.acceptedAt, undefined);
    const perm1 = await db.get(
      "SELECT grantable FROM sys_role_perm WHERE role_id=? AND perm='task:transfer:accept'",
      [String(branch.id)]
    );
    assert.ok(perm1, "BRANCH_ADMIN 补 accept 码");
    assert.equal(Number(perm1.grantable), 1, "BRANCH_ADMIN 持 sys:user:role → 可转授");
    // 备份留底
    const bak = await db.get("SELECT COUNT(*) AS n FROM _bak_064_transfer_three_state_sample_task");
    assert.ok(Number(bak.n) >= 1);
    // 第二遍：快照对比，结果不变（幂等）
    const snapTasks = await db.all("SELECT id,status,body FROM sample_task ORDER BY id");
    const snapPerms = await db.all(
      "SELECT role_id,perm,grantable FROM sys_role_perm ORDER BY role_id,perm"
    );
    const snapDept = await db.all("SELECT dept_id,perm FROM sys_dept_perm ORDER BY dept_id,perm");
    await up064(db);
    assert.deepEqual(await db.all("SELECT id,status,body FROM sample_task ORDER BY id"), snapTasks);
    assert.deepEqual(
      await db.all("SELECT role_id,perm,grantable FROM sys_role_perm ORDER BY role_id,perm"),
      snapPerms
    );
    assert.deepEqual(
      await db.all("SELECT dept_id,perm FROM sys_dept_perm ORDER BY dept_id,perm"),
      snapDept
    );
    // 历史单读兼容：transferView 归一已完成＋legacy 标＋接受人空
    const policies = new ReportPolicy(db);
    const view = await policies.transferView("AL-hist-1");
    assert.equal(view.status, "已完成");
    assert.equal(view.legacy, true);
    assert.equal(view.acceptedBy, undefined);
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R25 迁移 064 部门上限同补：含 device:box:list 的单独限制部门补 accept 码（防交集裁掉）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-064-dept-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2','device:box:list')");
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('2','task:create:transfer')");
    await up064(db);
    const hit = await db.get(
      "SELECT 1 AS x FROM sys_dept_perm WHERE dept_id='2' AND perm='task:transfer:accept'"
    );
    assert.ok(hit, "部门上限补 accept 码");
    // 不含基线读码的部门不补
    await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES ('5','device:box:detail')");
    await up064(db);
    const miss = await db.get(
      "SELECT 1 AS x FROM sys_dept_perm WHERE dept_id='5' AND perm='task:transfer:accept'"
    );
    assert.ok(!miss, "无基线读码的部门不补");
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R25 待接受占用箱子：接受前其他任务/划拨不能绑定（activeTaskSql），取消/拒收后释放", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const created = await s.create(s.creator(), [b1]);
    // 待接受期间：另一张划拨到不同目标被占用拦
    const other = await s.create(s.creator(), [b1], { toOrgId: "5", name: "另一张" });
    assert.equal(other.code, "A0409");
    assert.equal(other.data.blocked[0].reasonCode, "IN_ACTIVE_TASK");
    // 采样任务也不能绑定
    const sample = await s.run(s.controller.createTask.bind(s.controller), s.creator(), {
      body: { name: "采样", kind: "采样", boxIds: [b1], fromOrgId: "2", sender: "x", signer: "y" },
    });
    assert.equal(sample.code, "A0409");
    // 取消后释放：可再建
    await s.run(s.controller.cancelTransfer.bind(s.controller), s.creator(), {
      params: { id: created.data.id },
      body: {},
    });
    const after = await s.create(s.creator(), [b1], { toOrgId: "5", name: "取消后再建" });
    assert.ok(after.ok, `${after.code} ${after.message}`);
  } finally {
    await s.teardown();
  }
});

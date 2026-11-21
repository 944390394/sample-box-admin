/**
 * 划拨/送检 B1 核心服务端（reports/plan-transfer-inspect.md §3/§4/§6）。
 *
 * 一次性临时库（mkdtemp，SAMPLE_HOME 临时实例思路，同 task-handover-scope.test.js 写法），
 * 不碰开发库/线上库，不占任何服务端口。守住：
 * 1. createTransfer 提交即生效：单据+快照+归属同一事务；守卫拒绝/中途注入失败都全回滚（归属不得残留）；
 * 2. client_token 幂等：重复提交返回原单；无 token 时 G-C（已属于目标公司）拦重复；
 * 3. revoke 四守卫（IN_ACTIVE_TASK/OPENED_AFTER/INSPECTED/ORG_MOVED）各一条：整单禁撤、状态不变；
 *    全合格时归属精确退回建单快照（含 owner_id 空串）、审计留痕、已撤销不可再撤；
 * 4. candidate-boxes 服务端下发可选箱集，与提交守卫同一结论（替换前端 16 台 POOL）；
 * 5. 功能常开（组织简化后无开关）：旧 off 配置写入被忽略、读取恒 true，新端点恒可用；tasks 默认采样（D-1）、
 *    合并单 TK- + is_inspect=1、划拨走错端点被拒。
 * 6. P8 划拨目标类型闸门（组织简化 B1c）：检测站拒绝、总部/分公司（公司类型）允许、非公司类型拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import {
  applyBoxSettings,
  mergeBoxSettings,
  publicBox,
  transferInspectEnabled,
} from "../src/settings/boxConfig.js";
import { packet } from "./fixture.js";

const PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:power",
  "device:box:opens",
  "device:box:lid",
  "task:create:transfer",
  "task:create:sample",
  "task:create:inspect",
  "task:transfer:revoke",
  "task:send",
  "task:arrive",
  "task:sign",
  "task:reject",
  "task:inspect",
  "task:cancel",
]);

const ORG_NAMES = {
  1: "总公司",
  2: "深圳分公司",
  3: "广州分公司",
  4: "花都检测站",
  5: "第三方公司",
};

/** enabled 模拟存量配置里的旧开关值：常开后写入被忽略、读取恒 true（false 用于钉死兼容契约）。 */
async function setup({ enabled = true } = {}) {
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      batteryReserve: 20,
      arriveRadiusM: 2000,
      enableTransferInspect: enabled,
      stationDeptId: "4",
    },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-alloc-"));
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
    a: { id: "101", nickname: "陈默", deptId: "2" },
    b: { id: "201", nickname: "广州员工", deptId: "3" },
    station: { id: "401", nickname: "检测员", deptId: "4" },
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
  const ctx = (person, orgIds) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: { perms: new Set(PERMS), scope: { all: false, orgIds, ownerIds: [] }, roles: [] },
    ip: "127.0.0.1",
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
        data: error.data,
      };
    }
  };
  let imeiSeq = 0;
  const makeBox = async (orgId, { life = "未使用", ownerId = "", owner = "" } = {}) => {
    imeiSeq += 1;
    const imei = `8643170809${String(10000 + imeiSeq).padStart(5, "0")}`;
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
    db.get("SELECT org_id,org,owner_id,owner,life,opens FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const count = async (sql, params = []) => Number((await db.get(sql, params)).n);
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
    ctx,
    run,
    makeBox,
    boxRow,
    taskRow,
    count,
    people,
    teardown,
  };
}

/** 提交一张划拨单（2→3），返回响应 data。 */
async function submit(s, boxIds, extra = {}, actor = null) {
  const res = await s.run(
    s.controller.createTransfer.bind(s.controller),
    actor || s.ctx(s.people.a, ["2", "3"]),
    {
      body: { name: "华南区开工补给", toOrgId: "3", boxIds, ...extra },
    }
  );
  assert.ok(res.ok, `${res.code} ${res.message}`);
  return res.data;
}

test("划拨提交即生效：单据+快照+归属同一事务，AL- 前缀，不写占用、不改 life、审计齐备", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const b2 = await s.makeBox("2", { ownerId: "101", owner: "陈默" });
    const d = await submit(s, [b1, b2], { note: "2 台给广州现场用", clientToken: "tok-1" });
    assert.match(d.id, /^AL-\d+-[0-9a-f]{6}$/);
    assert.equal(d.kind, "划拨");
    assert.equal(d.status, "已划拨");
    assert.deepEqual(d.toOrg, { id: "3", name: "广州分公司" });
    assert.deepEqual(d.from, [{ orgId: "2", orgName: "深圳分公司", count: 2 }]);
    assert.equal(d.boxCount, 2);
    assert.deepEqual(d.steps, []);
    assert.equal(d.idempotent, false);
    assert.deepEqual(d.abilities, { revoke: true, cancel: false });
    assert.equal(d.boxes.find((b) => b.boxId === b2).fromOwner, "陈默");
    // 单据行：kind/status/to_org_id；from_org_id 单值列表达不了批量来源，存 NULL（D-12）
    const task = await s.taskRow(d.id);
    assert.equal(task.kind, "划拨");
    assert.equal(task.status, "已划拨");
    assert.equal(task.to_org_id, "3");
    assert.equal(task.from_org_id, null);
    assert.equal(Number(task.is_inspect), 0);
    // 快照 = 撤销回滚目标 + 开箱基线
    const links = await s.db.all("SELECT * FROM sample_task_box WHERE task_id=? ORDER BY box_id", [
      d.id,
    ]);
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.org_id, "2");
      assert.equal(Number(link.opens_start), 0);
    }
    assert.equal(links.find((l) => l.box_id === b2).owner_id, "101");
    assert.equal(links.find((l) => l.box_id === b1).owner_id, "");
    // 归属即时转移、保管人清空、life 不改
    for (const id of [b1, b2]) {
      const row = await s.boxRow(id);
      assert.equal(row.org_id, "3");
      assert.equal(row.org, "广州分公司");
      assert.equal(row.owner_id, "");
      assert.equal(row.life, "未使用");
    }
    // 划拨不是任务：不写 box_active_task（已划拨 ∈ ENDED，不占用）
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM box_active_task"), 0);
    // 幂等行 + 审计（谁/何时/哪些箱子/从哪到哪）
    assert.equal(
      (await s.db.get("SELECT task_id FROM transfer_request WHERE client_token='tok-1'")).task_id,
      d.id
    );
    const log = await s.db.get(
      "SELECT * FROM sample_task_log WHERE task_id=? AND action='提交划拨'",
      [d.id]
    );
    assert.equal(log.actor_id, "101");
    assert.equal(log.actor_name, "陈默");
    assert.equal(log.status, "已划拨");
    assert.equal(log.note, "2 台给广州现场用");
    const detail = JSON.parse(log.detail);
    assert.equal(detail.count, 2);
    assert.equal(detail.toOrgId, "3");
    assert.equal(detail.toOrgName, "广州分公司");
    assert.equal(detail.from.length, 2);
  } finally {
    await s.teardown();
  }
});

test("P8 划拨目标类型闸门（B1c）：检测站拒绝、总部允许（收回未分配）、分公司允许、非公司类型拒绝；拒绝不落单不占幂等 token", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const actor = s.ctx(s.people.a, ["1", "2", "3", "4", "5"]);
    const transfer = (toOrgId, extra = {}) =>
      s.run(s.controller.createTransfer.bind(s.controller), actor, {
        body: { name: "P8 类型闸门", toOrgId, boxIds: [b1], ...extra },
      });
    // 检测站：友好拒绝——单据/归属/幂等行都不落
    const toStation = await transfer("4", { clientToken: "tok-p8" });
    assert.equal(toStation.ok, false);
    assert.match(toStation.message, /检测站不参与归属划拨/);
    assert.equal((await s.boxRow(b1)).org_id, "2", "拒绝不转移归属");
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 0);
    assert.equal(
      await s.count("SELECT COUNT(*) AS n FROM transfer_request"),
      0,
      "拒绝不占幂等 token"
    );
    // 总部（type=公司）：允许＝收回未分配语义；同一 token 可正常提交（上次拒绝未落幂等行）
    const toHq = await transfer("1", { clientToken: "tok-p8" });
    assert.ok(toHq.ok, `${toHq.code} ${toHq.message}`);
    assert.equal(toHq.data.idempotent, false);
    assert.match(toHq.data.id, /^AL-/);
    assert.deepEqual(toHq.data.toOrg, { id: "1", name: "总公司" });
    assert.equal((await s.boxRow(b1)).org_id, "1");
    assert.equal((await s.boxRow(b1)).org, "总公司");
    // 分公司：允许（总部收回后再分配 1→3）
    const toBranch = await transfer("3");
    assert.ok(toBranch.ok, `${toBranch.code} ${toBranch.message}`);
    assert.equal((await s.boxRow(b1)).org_id, "3");
    // 非公司类型（056 归一前的旧采样机构残留）：通用友好报错
    await s.db.run("UPDATE sys_dept SET type='采样机构' WHERE id='5'");
    const toLegacy = await transfer("5");
    assert.equal(toLegacy.ok, false);
    assert.match(toLegacy.message, /划拨目标必须是公司类型/);
    assert.equal((await s.boxRow(b1)).org_id, "3", "拒绝不转移归属");
    // 停用目标：仍先报不存在/停用（类型闸门不改变既有前置校验顺序）
    await s.db.run("UPDATE sys_dept SET status=0 WHERE id='3'");
    const disabled = await transfer("3");
    assert.equal(disabled.ok, false);
    assert.match(disabled.message, /不存在或已停用/);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 2);
  } finally {
    await s.teardown();
  }
});

test("划拨守卫拒绝全回滚：第二台被未结束任务占用，第一台归属不得残留", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const b2 = await s.makeBox("2");
    const occ = await s.run(s.controller.createTask.bind(s.controller), s.ctx(s.people.a, ["2"]), {
      body: {
        name: "南山管网水样采集",
        kind: "采样",
        boxIds: [b2],
        fromOrgId: "2",
        sender: "x",
        signer: "y",
      },
    });
    assert.ok(occ.ok, occ.message);
    const before1 = await s.boxRow(b1);
    const res = await s.run(
      s.controller.createTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { body: { name: "批量划拨", toOrgId: "3", boxIds: [b1, b2], clientToken: "tok-guard" } }
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "A0409");
    assert.equal(res.status, 409);
    assert.equal(res.data.totalCount, 2);
    assert.equal(res.data.blockedCount, 1);
    assert.equal(res.data.blocked[0].boxId, b2);
    assert.equal(res.data.blocked[0].reasonCode, "IN_ACTIVE_TASK");
    assert.match(res.data.blocked[0].reason, /南山管网水样采集/);
    // 全回滚：无划拨单、无快照、b1 归属原样、幂等行不写
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 0);
    assert.equal(
      await s.count("SELECT COUNT(*) AS n FROM sample_task_box WHERE box_id=?", [b1]),
      0
    );
    assert.deepEqual(await s.boxRow(b1), before1);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM transfer_request"), 0);
  } finally {
    await s.teardown();
  }
});

/** 故障注入执行器：事务内第 failAt 条「归属迁移 UPDATE」抛错，其余委托真库。 */
class FaultyDb {
  constructor(db, failAt) {
    this.db = db;
    this.dialect = db.dialect;
    this.failAt = failAt;
    this.updates = 0;
  }
  all(sql, params) {
    return this.db.all(sql, params);
  }
  get(sql, params) {
    return this.db.get(sql, params);
  }
  run(sql, params) {
    return this.db.run(sql, params);
  }
  transaction(fn) {
    return this.db.transaction((tx) =>
      fn({
        dialect: tx.dialect,
        all: (sql, params) => tx.all(sql, params),
        get: (sql, params) => tx.get(sql, params),
        run: (sql, params) => {
          if (/^UPDATE sample_box SET org_id/.test(sql)) {
            this.updates += 1;
            if (this.updates === this.failAt) throw new Error("注入：归属写入失败");
          }
          return tx.run(sql, params);
        },
      })
    );
  }
}

test("划拨失败注入全回滚：第二台归属写入中途抛错，单据/快照/归属/幂等行都不残留", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const b2 = await s.makeBox("2", { ownerId: "101", owner: "陈默" });
    const faulty = new FaultyDb(s.db, 2);
    const policies = new ReportPolicy(faulty);
    const controller = new ReportPolicyController(s.boxes, policies);
    const before1 = await s.boxRow(b1);
    const before2 = await s.boxRow(b2);
    const res = await s.run(
      controller.createTransfer.bind(controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        body: { name: "注入测试", toOrgId: "3", boxIds: [b1, b2], clientToken: "tok-fault" },
      }
    );
    assert.equal(res.ok, false);
    assert.match(res.message, /注入：归属写入失败/);
    assert.equal(faulty.updates, 2, "确实走到了第二台归属写入");
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 0);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task_box"), 0);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task_log"), 0);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM transfer_request"), 0);
    assert.deepEqual(await s.boxRow(b1), before1, "第一台已写过的归属必须回滚");
    assert.deepEqual(await s.boxRow(b2), before2);
  } finally {
    await s.teardown();
  }
});

test("划拨 client_token 幂等：重复提交返回原单不重复转移；无 token 时已属于目标公司被拦", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const first = await submit(s, [b1], { clientToken: "tok-idem" });
    const again = await s.run(
      s.controller.createTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { body: { name: "华南区开工补给", toOrgId: "3", boxIds: [b1], clientToken: "tok-idem" } }
    );
    assert.ok(again.ok, again.message);
    assert.equal(again.data.id, first.id);
    assert.equal(again.data.idempotent, true);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 1);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM transfer_request"), 1);
    assert.equal((await s.boxRow(b1)).org_id, "3");
    // 不带 token 再提交同一批：G-C 天然幂等护栏
    const dup = await s.run(
      s.controller.createTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { body: { name: "再来一张", toOrgId: "3", boxIds: [b1] } }
    );
    assert.equal(dup.code, "A0409");
    assert.equal(dup.data.blocked[0].reasonCode, "ALREADY_TARGET");
    assert.match(dup.data.blocked[0].reason, /已属于 广州分公司/);
    assert.equal(await s.count("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'"), 1);
  } finally {
    await s.teardown();
  }
});

test("划拨撤销全合格：归属精确退回快照（含空保管人）、审计留痕、已撤销不可再撤", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2", { ownerId: "101", owner: "陈默" });
    const b2 = await s.makeBox("2");
    const d = await submit(s, [b1, b2]);
    const res = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "误划拨" } }
    );
    assert.ok(res.ok, `${res.code} ${res.message}`);
    assert.equal(res.data.status, "已撤销");
    assert.equal(res.data.restoredCount, 2);
    assert.ok(res.data.revokedAt);
    assert.equal(res.data.log.action, "撤销划拨");
    const r1 = res.data.restored.find((r) => r.boxId === b1);
    assert.equal(r1.toOrgId, "2");
    assert.equal(r1.toOrg, "深圳分公司");
    assert.equal(r1.ownerId, "101");
    assert.equal(r1.owner, "陈默");
    // 归属退回：原公司名、原保管人；空保管人按空处理（显示层「—」）
    const row1 = await s.boxRow(b1);
    assert.equal(row1.org_id, "2");
    assert.equal(row1.org, "深圳分公司");
    assert.equal(row1.owner_id, "101");
    assert.equal(row1.owner, "陈默");
    const row2 = await s.boxRow(b2);
    assert.equal(row2.org_id, "2");
    assert.equal(row2.owner_id, "");
    assert.equal(row2.life, "未使用", "撤销不改生命周期");
    assert.equal((await s.taskRow(d.id)).status, "已撤销");
    // 不删行：快照与两条审计都保留
    assert.equal(
      await s.count("SELECT COUNT(*) AS n FROM sample_task_box WHERE task_id=?", [d.id]),
      2
    );
    const logs = await s.db.all(
      "SELECT action,note FROM sample_task_log WHERE task_id=? ORDER BY created_at",
      [d.id]
    );
    assert.deepEqual(
      logs.map((l) => l.action),
      ["提交划拨", "撤销划拨"]
    );
    assert.equal(logs[1].note, "误划拨");
    // 已撤销不可再撤，也没有撤销撤销
    const twice = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "再撤一次" } }
    );
    assert.equal(twice.code, "A0409");
    assert.match(twice.message, /已撤销/);
    assert.equal((await s.boxRow(b1)).org_id, "2");
  } finally {
    await s.teardown();
  }
});

test("划拨撤销守卫 IN_ACTIVE_TASK：已进入未结束任务，整单禁撤、状态与归属不变", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const d = await submit(s, [b1]);
    const occ = await s.run(s.controller.createTask.bind(s.controller), s.ctx(s.people.b, ["3"]), {
      body: {
        name: "南山管网水样采集",
        kind: "采样",
        boxIds: [b1],
        fromOrgId: "3",
        sender: "x",
        signer: "y",
      },
    });
    assert.ok(occ.ok, occ.message);
    const res = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "误划拨" } }
    );
    assert.equal(res.code, "A0409");
    assert.match(res.message, /存在 1 台不可撤销箱子，整单禁止撤销。/);
    assert.equal(res.data.canRevoke, false);
    assert.equal(res.data.banner, "整单禁止撤销");
    assert.equal(res.data.confirmLabel, "整单不可撤销");
    assert.equal(res.data.totalCount, 1);
    assert.equal(res.data.blockedCount, 1);
    assert.equal(res.data.okCount, 0);
    const hit = res.data.boxes[0];
    assert.equal(hit.ok, false);
    assert.equal(hit.reasonCode, "IN_ACTIVE_TASK");
    assert.match(hit.reason, /已进入未结束任务「南山管网水样采集」（待采样）/);
    assert.equal((await s.taskRow(d.id)).status, "已划拨");
    assert.equal((await s.boxRow(b1)).org_id, "3");
  } finally {
    await s.teardown();
  }
});

test("划拨撤销守卫 OPENED_AFTER：opens 增量判定（D-7），整单禁撤", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const d = await submit(s, [b1]);
    await s.db.run("UPDATE sample_box SET opens=opens+3 WHERE id=?", [b1]);
    const res = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "误划拨" } }
    );
    assert.equal(res.code, "A0409");
    const hit = res.data.boxes[0];
    assert.equal(hit.reasonCode, "OPENED_AFTER");
    assert.equal(hit.opensDelta, 3);
    assert.match(hit.reason, /划拨后已开箱（箱盖异常开启 ×3），不满足未开箱条件/);
    assert.equal((await s.taskRow(d.id)).status, "已划拨");
    assert.equal((await s.boxRow(b1)).org_id, "3");
  } finally {
    await s.teardown();
  }
});

test("划拨撤销守卫 INSPECTED：划拨后送检并完成开箱检测，整单禁撤（走真实检测站流程）", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const d = await submit(s, [b1]);
    // 划拨后这台箱子被送检：广州 → 花都检测站（合并采样单），签收后逐台开始检测
    const created = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.b, ["3"]),
      {
        body: {
          name: "花都水样送检",
          kind: "采样",
          boxIds: [b1],
          fromOrgId: "3",
          senderId: "201",
          signerId: "401",
        },
      }
    );
    assert.ok(created.ok, created.message);
    const inspId = created.data.id;
    for (const status of ["采样中", "已封箱", "在途", "待签收"]) {
      const step = await s.run(
        s.controller.transition.bind(s.controller),
        s.ctx(s.people.b, ["3"]),
        {
          params: { id: inspId },
          body: { status },
        }
      );
      assert.ok(step.ok, `${status}: ${step.code} ${step.message}`);
    }
    const sign = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.station, ["1", "4"]),
      { params: { id: inspId }, body: { status: "待检测" } }
    );
    assert.ok(sign.ok, `${sign.code} ${sign.message}`);
    const inspect = await s.run(
      s.controller.inspect.bind(s.controller),
      s.ctx(s.people.station, ["1", "4"]),
      { params: { id: inspId, boxId: b1 } }
    );
    assert.ok(inspect.ok, `${inspect.code} ${inspect.message}`);
    assert.equal((await s.taskRow(inspId)).status, "已检测");
    // 撤销：检测守卫命中（判定顺序里 INSPECTED 先于 ORG_MOVED，签收已把箱子改挂检测站）
    const res = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "误划拨" } }
    );
    assert.equal(res.code, "A0409");
    const hit = res.data.boxes[0];
    assert.equal(hit.reasonCode, "INSPECTED");
    assert.match(hit.reason, /已完成开箱检测（花都水样送检 · 已检测），不满足未检测条件/);
    assert.equal((await s.taskRow(d.id)).status, "已划拨");
    assert.equal((await s.boxRow(b1)).org_id, "4", "禁撤时归属不动");
  } finally {
    await s.teardown();
  }
});

test("划拨撤销守卫 ORG_MOVED：箱子被第三方改挂，整单禁撤（D-6）", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const d = await submit(s, [b1]);
    await s.boxes.updateBox(b1, (item) => {
      item.orgId = "5";
      item.org = "第三方公司";
    });
    const res = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: d.id }, body: { reason: "误划拨" } }
    );
    assert.equal(res.code, "A0409");
    const hit = res.data.boxes[0];
    assert.equal(hit.reasonCode, "ORG_MOVED");
    assert.match(hit.reason, /归属已改挂到第三方公司/);
    assert.equal((await s.taskRow(d.id)).status, "已划拨");
    assert.equal((await s.boxRow(b1)).org_id, "5", "不能把第三方改挂的箱子抢回来");
  } finally {
    await s.teardown();
  }
});

test("candidate-boxes：服务端下发可选箱集，与提交守卫同一结论（替换前端 POOL）", async () => {
  const s = await setup();
  try {
    const free = await s.makeBox("2");
    const busy = await s.makeBox("2");
    const disabled = await s.makeBox("2", { life: "停用" });
    const atTarget = await s.makeBox("3");
    const occ = await s.run(s.controller.createTask.bind(s.controller), s.ctx(s.people.a, ["2"]), {
      body: {
        name: "南山管网水样采集",
        kind: "采样",
        boxIds: [busy],
        fromOrgId: "2",
        sender: "x",
        signer: "y",
      },
    });
    assert.ok(occ.ok, occ.message);
    const res = await s.run(
      s.controller.transferCandidates.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { query: { toOrgId: "3" } }
    );
    assert.ok(res.ok, `${res.code} ${res.message}`);
    assert.equal(res.data.total, 4);
    assert.equal(res.data.selectableCount, 1);
    assert.equal(res.data.blockedCount, 3);
    const byId = new Map(res.data.list.map((b) => [b.boxId, b]));
    assert.equal(byId.get(free).selectable, true);
    assert.equal(byId.get(free).boundTask, null);
    assert.equal(byId.get(busy).selectable, false);
    assert.equal(byId.get(busy).reasonCode, "IN_ACTIVE_TASK");
    assert.equal(byId.get(busy).boundTask.name, "南山管网水样采集");
    assert.equal(byId.get(busy).boundTask.kind, "采样");
    assert.equal(byId.get(disabled).reasonCode, "BOX_DISABLED");
    assert.equal(byId.get(atTarget).reasonCode, "ALREADY_TARGET");
    // 同一结论：向导标不可选的箱子，提交也被同一守卫拒绝
    const rejected = await s.run(
      s.controller.createTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { body: { name: "试提交", toOrgId: "3", boxIds: [busy] } }
    );
    assert.equal(rejected.code, "A0409");
    assert.equal(rejected.data.blocked[0].reasonCode, "IN_ACTIVE_TASK");
    // 不传 toOrgId 时不评 ALREADY_TARGET；life 筛选可用
    const noTarget = await s.run(
      s.controller.transferCandidates.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { query: {} }
    );
    assert.equal(noTarget.data.list.find((b) => b.boxId === atTarget).selectable, true);
    const lifeOnly = await s.run(
      s.controller.transferCandidates.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { query: { life: "停用" } }
    );
    assert.equal(lifeOnly.data.total, 1);
    assert.equal(lifeOnly.data.list[0].boxId, disabled);
    // 历史上开过盖不拦（D-9）：建单侧不评开箱/检测
    await s.db.run("UPDATE sample_box SET opens=9 WHERE id=?", [free]);
    const opened = await s.run(
      s.controller.transferCandidates.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { query: { toOrgId: "3" } }
    );
    assert.equal(opened.data.list.find((b) => b.boxId === free).selectable, true);
  } finally {
    await s.teardown();
  }
});

test("常开：旧 off 配置写入被忽略/读取恒 true，划拨新端点恒可用；合并采样单不受影响，调拨不再新建、送检恢复（R23）", async () => {
  const s = await setup({ enabled: false });
  try {
    // 常开契约：off 配置不改读取/守卫；旧客户端写 off 被 merge 忽略；两边都没设过仍不写键、读取恒 true
    assert.equal(transferInspectEnabled(), true, "off 配置下守卫仍恒通过");
    assert.equal(publicBox({ box: { enableTransferInspect: false } }).enableTransferInspect, true);
    const merged = mergeBoxSettings(
      { box: { enableTransferInspect: false } },
      { reportPeriodSec: 60, batteryReserve: 20, enableTransferInspect: false }
    );
    assert.equal(merged.box.enableTransferInspect, true, "旧 off 配置＋旧客户端写 off 都被忽略");
    const omitted = mergeBoxSettings({}, { reportPeriodSec: 60, batteryReserve: 20 });
    assert.equal(omitted.box.enableTransferInspect, undefined, "两边都没设过仍不写键");
    assert.equal(publicBox(omitted).enableTransferInspect, true, "无键读取恒 true");
    const b1 = await s.makeBox("2");
    const b2 = await s.makeBox("2");
    const b3 = await s.makeBox("2");
    // 合并采样单：主流程，与划拨/送检常开契约无关
    const sample = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: {
          name: "采样单",
          kind: "采样",
          boxIds: [b1],
          fromOrgId: "2",
          sender: "x",
          signer: "y",
        },
      }
    );
    assert.ok(sample.ok, sample.message);
    // 调拨不再新建（只读保留）
    const legacyReject = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: {
          name: "旧调拨单",
          kind: "调拨",
          boxIds: [b2],
          fromOrgId: "2",
          toOrgId: "3",
          senderId: "101",
          signerId: "201",
        },
      }
    );
    assert.match(legacyReject.message, /调拨单已停用/);
    // 存量旧调拨单：policy 层建单模拟迁移前数据，仍发 TK-
    const legacyId = await s.policies.createTask({
      name: "旧调拨单",
      kind: "调拨",
      boxIds: [b2],
      fromOrgId: "2",
      fromOrg: "深圳分公司",
      toOrgId: "3",
      toOrg: "广州分公司",
      senderId: "101",
      signerId: "201",
    });
    assert.match(legacyId, /^TK-/);
    // 不传 kind：默认采样（合并单主口径）
    const def = await s.run(
      s.controller.tasks.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {}
    );
    assert.ok(def.ok, def.message);
    assert.equal(def.data.total, 1);
    assert.equal(def.data.list[0].kind, "采样");
    // allKinds=1 兜底回全部
    const all = await s.run(s.controller.tasks.bind(s.controller), s.ctx(s.people.a, ["2", "3"]), {
      query: { allKinds: "1" },
    });
    assert.equal(all.data.total, 2);
    assert.deepEqual(new Set(all.data.list.map((t) => t.kind)), new Set(["采样", "调拨"]));
    // R23：送检恢复新建（类型闸门不再拒「送检已并入」）；b1 已在未结束采样单里 → 占用拒绝
    const inspect = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: {
          name: "送检",
          kind: "送检",
          boxIds: [b1],
          fromOrgId: "2",
          toOrgId: "4",
          senderId: "101",
          signerId: "401",
        },
      }
    );
    assert.equal(inspect.code, "A0409");
    assert.match(inspect.message, /已在任务单/);
    // 新端点恒可用（off 配置不再报未开通）：提交/列表/候选/详情/撤销走一张真实划拨单
    const created = await s.run(
      s.controller.createTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { body: { name: "常开划拨", toOrgId: "3", boxIds: [b3] } }
    );
    assert.ok(created.ok, `${created.code} ${created.message}`);
    assert.match(created.data.id, /^AL-/);
    assert.equal((await s.boxRow(b3)).org_id, "3", "提交即生效");
    const list = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {}
    );
    assert.ok(list.ok, list.message);
    assert.equal(list.data.total, 1);
    const cand = await s.run(
      s.controller.transferCandidates.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { query: { toOrgId: "3" } }
    );
    assert.ok(cand.ok, cand.message);
    const detail = await s.run(
      s.controller.transferDetail.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: created.data.id } }
    );
    assert.ok(detail.ok, detail.message);
    assert.equal(detail.data.boxes[0].revocable, true);
    const revoke = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: created.data.id }, body: { reason: "误划拨" } }
    );
    assert.ok(revoke.ok, `${revoke.code} ${revoke.message}`);
    assert.equal((await s.boxRow(b3)).org_id, "2", "撤销归属退回快照");
    // 旧调拨单不走新端点：详情 404、撤销 kind 闸门（不再是「未开通」）
    const legacyDetail = await s.run(
      s.controller.transferDetail.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: legacyId } }
    );
    assert.equal(legacyDetail.code, "A0404");
    const legacyRevoke = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      { params: { id: legacyId }, body: { reason: "误划拨" } }
    );
    assert.equal(legacyRevoke.code, "A0409");
    assert.match(legacyRevoke.message, /只有划拨单可以撤销/);
    // 存量旧调拨流程照常推进（常开不改变旧流程）
    const step = await s.run(s.controller.transition.bind(s.controller), s.ctx(s.people.a, ["2"]), {
      params: { id: legacyId },
      body: { status: "运送中" },
    });
    assert.ok(step.ok, `${step.code} ${step.message}`);
  } finally {
    await s.teardown();
  }
});

test("常开（默认配置）：tasks 默认采样/allKinds 兜底，合并单 TK-+is_inspect，划拨列表/详情/走错端点", async () => {
  const s = await setup();
  try {
    const b1 = await s.makeBox("2");
    const b2 = await s.makeBox("2");
    const b3 = await s.makeBox("2");
    const b4 = await s.makeBox("2");
    const sample = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: {
          name: "采样单",
          kind: "采样",
          boxIds: [b1],
          fromOrgId: "2",
          sender: "x",
          signer: "y",
        },
      }
    );
    assert.ok(sample.ok, sample.message);
    const legacyId = await s.policies.createTask({
      name: "旧调拨单",
      kind: "调拨",
      boxIds: [b2],
      fromOrgId: "2",
      fromOrg: "深圳分公司",
      toOrgId: "3",
      toOrg: "广州分公司",
      senderId: "101",
      signerId: "201",
    });
    assert.ok(legacyId);
    // 默认只回采样；allKinds=1 兜底回全部
    const def = await s.run(
      s.controller.tasks.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {}
    );
    assert.equal(def.data.total, 1);
    assert.equal(def.data.list[0].kind, "采样");
    const allKinds = await s.run(
      s.controller.tasks.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        query: { allKinds: "1" },
      }
    );
    assert.equal(allKinds.data.total, 2);
    // 合并采样单：TK- 前缀 + is_inspect=1 + 待采样 + 7 步
    const inspect = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: {
          name: "花都水样送检",
          kind: "采样",
          boxIds: [b3],
          fromOrgId: "2",
          senderId: "101",
          signerId: "401",
        },
      }
    );
    assert.ok(inspect.ok, `${inspect.code} ${inspect.message}`);
    assert.match(inspect.data.id, /^TK-\d+-[0-9a-f]{6}$/);
    const inspRow = await s.taskRow(inspect.data.id);
    assert.equal(inspRow.kind, "采样");
    assert.equal(inspRow.status, "待采样");
    assert.equal(inspRow.to_org_id, "4", "接收方固定检测站");
    assert.equal(Number(inspRow.is_inspect), 1);
    assert.equal(JSON.parse(inspRow.body).inspect, true);
    const inspList = await s.run(
      s.controller.tasks.bind(s.controller),
      s.ctx(s.people.a, ["2", "4"]),
      {
        query: { kind: "采样", q: "花都" },
      }
    );
    assert.equal(inspList.data.total, 1);
    assert.deepEqual(inspList.data.list[0].steps, [
      "待采样",
      "采样中",
      "已封箱",
      "在途",
      "待签收",
      "待检测",
      "已检测",
    ]);
    // 划拨走错端点：POST /tasks 与 PUT /tasks/:id/status 都拒
    const wrongCreate = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: { name: "划拨", kind: "划拨", boxIds: [b1], toOrgId: "3" },
      }
    );
    assert.equal(wrongCreate.code, "A0409");
    const d = await submit(s, [b4]);
    const wrongStatus = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        params: { id: d.id },
        body: { status: "待签收" },
      }
    );
    assert.equal(wrongStatus.code, "A0409");
    assert.match(wrongStatus.message, /划拨单没有物流步骤/);
    // 列表：counts 与列表同口径 + 箱次累计；行带 by/byId/from/toOrg
    const list = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {}
    );
    assert.ok(list.ok, list.message);
    assert.equal(list.data.total, 1);
    assert.deepEqual(list.data.counts, { 全部: 1, 已划拨: 1, 已撤销: 0, boxCountTotal: 1 });
    assert.equal(list.data.list[0].by, "陈默");
    assert.equal(list.data.list[0].byId, "101");
    assert.deepEqual(list.data.list[0].from, [{ orgId: "2", orgName: "深圳分公司", count: 1 }]);
    assert.ok(list.data.kpiHints.boxCountTotal);
    // orgId 匹配 from 快照或 to；q 搜箱码
    const byFrom = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        query: { orgId: "2" },
      }
    );
    assert.equal(byFrom.data.total, 1);
    const byOther = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        query: { orgId: "5" },
      }
    );
    assert.equal(byOther.data.total, 0);
    const byQ = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        query: { q: b4 },
      }
    );
    assert.equal(byQ.data.total, 1);
    // 详情：逐台快照 + revocable + 审计线
    const detail = await s.run(
      s.controller.transferDetail.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        params: { id: d.id },
      }
    );
    assert.ok(detail.ok, detail.message);
    assert.equal(detail.data.boxes[0].revocable, true);
    assert.equal(detail.data.boxes[0].fromOrgId, "2");
    assert.equal(detail.data.logs.length, 1);
    assert.equal(detail.data.logs[0].action, "提交划拨");
    assert.deepEqual(detail.data.abilities, { revoke: true, cancel: false });
    // 撤销后列表/详情回 revokedAt/revokeReason，counts 同步
    const revoke = await s.run(
      s.controller.revokeTransfer.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        params: { id: d.id },
        body: { reason: "误划拨" },
      }
    );
    assert.ok(revoke.ok, revoke.message);
    const after = await s.run(
      s.controller.transfers.bind(s.controller),
      s.ctx(s.people.a, ["2", "3"]),
      {
        query: { status: "已撤销" },
      }
    );
    assert.equal(after.data.total, 1);
    assert.deepEqual(after.data.counts, { 全部: 1, 已划拨: 0, 已撤销: 1, boxCountTotal: 1 });
    assert.ok(after.data.list[0].revokedAt);
    assert.equal(after.data.list[0].revokeReason, "误划拨");
    const detailAfter = await s.run(
      s.controller.transferDetail.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        params: { id: d.id },
      }
    );
    assert.equal(detailAfter.data.boxes[0].revocable, false);
    assert.equal(detailAfter.data.abilities.revoke, false);
    assert.equal(detailAfter.data.logs.length, 2);
  } finally {
    await s.teardown();
  }
});

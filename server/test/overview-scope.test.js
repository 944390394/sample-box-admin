import test from "node:test";
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
import { ALL_PERMS, upgradeCodes } from "../src/auth/permCatalog.js";
import { packet } from "./fixture.js";

/**
 * R4 角色权限匹配：
 * - #units 把 scope 覆盖到的最近公司/检测站祖先纳入单位（范围只给科室也落得到单位页）；
 * - group 的 myUnitId：非全量范围且只有一个单位时给编号，仅本人/全量给 null；
 * - 任务可见性认采样单位参与方（body.orgId），总览里可见的单任务列表/详情不再 404。
 */

const PERMS = [
  "device:box:task",
  "device:box:list",
  "device:box:location",
  "task:sample-start",
  "task:seal",
  "task:sign",
];
const ctxOf = (scope, perms = PERMS, user = { id: "9", nickname: "测试员" }) => ({
  user,
  access: { perms: new Set(upgradeCodes(perms)), scope },
});
const scoped = (orgIds, ownerIds = []) => ({ all: false, orgIds, ownerIds });
const admin = () => ({
  user: { id: "2", nickname: "系统管理员" },
  access: {
    perms: new Set(ALL_PERMS.map((p) => p.code)),
    scope: { all: true, orgIds: [], ownerIds: [] },
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

async function setup() {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "overview-scope-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db);
  const policies = new ReportPolicy(db);
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["6", "1", "总部检测站", "采样机构"],
    ["2", "0", "华南分公司", "公司"],
    ["21", "2", "调度室", "公司"],
    ["3", "0", "华东分公司", "公司"],
    ["5", "0", "合作采样机构", "公司"],
    ["51", "5", "采样机构甲", "公司"],
    ["511", "51", "甲现场组", "公司"],
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
  const { box: a } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.16,seq=1" }));
  const { box: b } = await ingest.accept(
    packet({ imei: "864317080992518", uart: "why=boot,opens=0,fw=1.0.16,seq=1" })
  );
  // A 挂调度室（科室），B 挂分公司本部：验证单位统计只算范围覆盖的部门
  await boxes.updateBox(a.id, (x) => {
    x.life = "未使用";
    x.org = "调度室";
    x.orgId = "21";
  });
  await boxes.updateBox(b.id, (x) => {
    x.life = "未使用";
    x.org = "华南分公司";
    x.orgId = "2";
  });
  return {
    dir,
    db,
    boxes,
    policies,
    a,
    b,
    c: new ReportPolicyController(boxes, policies),
    o: new OverviewController(boxes, db),
  };
}

test("范围只给科室：沿 parent 链纳入最近公司祖先，单位页可达且统计只算范围部门；myUnitId 指向唯一单位", async () => {
  const { dir, db, o } = await setup();
  try {
    const dispatchRoom = ctxOf(scoped(["21"]));
    const group = await call(o.group.bind(o), dispatchRoom);
    assert.deepEqual(
      group.units.map((u) => u.id),
      ["2"]
    );
    assert.equal(group.myUnitId, "2");
    assert.equal(group.unitTotal, 1);
    // 统计只算范围覆盖的科室：A 在 21，B 在 2 本部不算
    assert.equal(group.units[0].stats.total, 1);
    const unit = await call(o.unit.bind(o), { ...dispatchRoom, params: { orgId: "2" } });
    assert.equal(unit.unit.name, "华南分公司");
    assert.equal(unit.stats.total, 1);
    // 科室本身不是单位；范围外的公司照旧 404
    await assert.rejects(
      call(o.unit.bind(o), { ...dispatchRoom, params: { orgId: "21" } }),
      /不在你的数据范围/
    );
    await assert.rejects(
      call(o.unit.bind(o), { ...dispatchRoom, params: { orgId: "3" } }),
      /不在你的数据范围/
    );
    // 机构下级科室：锚到顶级公司（51/511 都是公司类型，不是检测站）
    const agency = ctxOf(scoped(["5", "51", "511"]));
    const ag = await call(o.group.bind(o), agency);
    assert.deepEqual(
      ag.units.map((u) => u.id),
      ["5"]
    );
    assert.equal(ag.myUnitId, "5");
    assert.equal(
      (await call(o.unit.bind(o), { ...agency, params: { orgId: "5" } })).unit.name,
      "合作采样机构"
    );
    // 采样机构类型不管在哪一级都单列：范围只给检测站科室时锚到检测站本身
    await db.run("UPDATE sys_dept SET type='采样机构' WHERE id='51'");
    const stationLead = ctxOf(scoped(["51", "511"]));
    const sg = await call(o.group.bind(o), stationLead);
    assert.deepEqual(
      sg.units.map((u) => [u.id, u.type]),
      [["51", "采样机构"]]
    );
    assert.equal(sg.myUnitId, "51");
    await db.run("UPDATE sys_dept SET type='公司' WHERE id='51'");
    // 全量口径不变：管理员看到全部单位，myUnitId=null
    const full = await call(o.group.bind(o), admin());
    assert.deepEqual(
      full.units.map((u) => u.id),
      ["1", "6", "2", "3", "5"]
    );
    assert.equal(full.myUnitId, null);
    assert.equal(full.units.find((u) => u.id === "2").stats.total, 2);
    // 仅本人：没有单位范围 → units 空、myUnitId=null（前端渲染带引导的空态而不是报错）
    const selfOnly = ctxOf(scoped([], ["7"]));
    const sg2 = await call(o.group.bind(o), selfOnly);
    assert.deepEqual(sg2.units, []);
    assert.equal(sg2.unitTotal, 0);
    assert.equal(sg2.myUnitId, null);
    assert.equal(sg2.total, null);
    // 顶级公司被停用：不把它纳入单位（停用单位不该出现在总览）
    await db.run("UPDATE sys_dept SET status=0 WHERE id='2'");
    const disabled = await call(o.group.bind(o), ctxOf(scoped(["21"])));
    assert.deepEqual(disabled.units, []);
    assert.equal(disabled.myUnitId, null);
    await db.run("UPDATE sys_dept SET status=1 WHERE id='2'");
    // 范围内多个单位：myUnitId=null，留在集团板
    const two = await call(o.group.bind(o), ctxOf(scoped(["2", "21", "3"])));
    assert.deepEqual(
      two.units.map((u) => u.id),
      ["2", "3"]
    );
    assert.equal(two.myUnitId, null);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("采样单位参与方：body.orgId 在范围内就能看到单（列表/详情/总览同口径），范围外照旧 404，采样单位能推进", async () => {
  const { dir, db, c, o, a, b } = await setup();
  try {
    // 单向采样单：采样单位只记在 body.orgId，from/to 列为空，箱子快照属寄出单位
    const { id } = await call(c.createTask.bind(c), {
      ...admin(),
      body: {
        name: "机构甲采样",
        kind: "采样",
        boxIds: [b.id],
        orgId: "51",
        place: "验收大道 5 号",
      },
    });
    // 一张跨区调拨：机构甲不是参与方，不该因为新口径被放出去
    const { id: transferId } = await call(c.createTask.bind(c), {
      ...admin(),
      body: {
        name: "跨区调拨",
        kind: "调拨",
        boxIds: [a.id],
        fromOrgId: "2",
        toOrgId: "3",
        sender: "x",
        signer: "y",
      },
    });
    const agency = ctxOf(scoped(["5", "51", "511"]), PERMS, { id: "9102", nickname: "机构负责人" });
    const list = await call(c.tasks.bind(c), { ...agency, query: {} });
    assert.deepEqual(
      list.list.map((t) => t.id),
      [id]
    );
    assert.equal(list.list[0].kind, "采样");
    const detail = await call(c.taskDetail.bind(c), { ...agency, params: { id } });
    assert.equal(detail.task.orgId, "51");
    // 总览单位页的当日任务与任务列表同口径（修复前：总览可见、详情 404）
    const unit = await call(o.unit.bind(o), { ...agency, params: { orgId: "5" } });
    assert.deepEqual(
      unit.tasks.map((t) => t.id),
      [id]
    );
    // 采样单位能推进自己的单（#abilities 早就承认参与方，可见性跟上后链路才通）
    assert.equal(detail.can["采样中"], true);
    await call(c.transition.bind(c), { ...agency, params: { id }, body: { status: "采样中" } });
    assert.equal(
      (await call(c.taskDetail.bind(c), { ...agency, params: { id } })).task.status,
      "采样中"
    );
    // 范围外角色：看不到采样单（列表只有它作为接收方的调拨）、详情 404、推进 404（L-P0-1 口径不回退）
    const east = ctxOf(scoped(["3"]), PERMS, { id: "6", nickname: "华东调度" });
    assert.deepEqual(
      (await call(c.tasks.bind(c), { ...east, query: {} })).list.map((t) => t.id),
      [transferId]
    );
    await assert.rejects(
      call(c.taskDetail.bind(c), { ...east, params: { id } }),
      /不在你的管理范围/
    );
    await assert.rejects(
      call(c.transition.bind(c), { ...east, params: { id }, body: { status: "已封箱" } }),
      /不在你的管理范围/
    );
    // 仅本人范围（采样员）：箱子不在自己名下时这张单依旧不可见
    const selfOnly = ctxOf(scoped([], ["7"]));
    assert.deepEqual((await call(c.tasks.bind(c), { ...selfOnly, query: {} })).list, []);
    // 调拨单对机构甲依旧不可见（新口径只认采样单位，不是放开口子）
    assert.ok(transferId);
    await assert.rejects(
      call(c.taskDetail.bind(c), { ...agency, params: { id: transferId } }),
      /不在你的管理范围/
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrate, openDatabase } from "../db.js";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { SampleController } from "../src/http/SampleController.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { nextOf, stepsOf } from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const PERMS = [
  "device:box:list",
  "device:box:task",
  "device:box:location",
  "task:create:transfer",
  "task:sign",
  "task:reject",
  "task:cancel",
];

function ctxOf(orgIds, user = { id: "9", nickname: "测试员" }) {
  return {
    user,
    access: {
      perms: new Set(upgradeCodes(PERMS)),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
    },
  };
}

async function call(fn, ctx) {
  let out;
  await fn({ ...ctx, ok: (data) => (out = data), fail: (message) => (out = { error: message }) });
  return out;
}

test("流程：直接调拨从待签收开始，旧的发货调拨不变", () => {
  assert.deepEqual(stepsOf({ kind: "调拨", direct: true }), ["待签收", "已签收"]);
  assert.deepEqual(stepsOf({ kind: "调拨", direct: true, inspect: true }), [
    "待签收",
    "待检测",
    "已检测",
  ]);
  assert.deepEqual(stepsOf({ kind: "调拨", direct: true, status: "退回中" }), [
    "待签收",
    "退回中",
    "已退回",
  ]);
  assert.deepEqual(nextOf({ kind: "调拨", direct: true }, "待签收"), [
    "已签收",
    "已拒收",
    "退回中",
    "已取消",
  ]);
  assert.deepEqual(stepsOf({ kind: "调拨" }), ["待寄出", "运送中", "待签收", "已签收"]);
  assert.deepEqual(nextOf({ kind: "调拨" }, "运送中"), ["待签收", "已取消"]);
});

test("直接调拨：不需要地址和寄出人，签收后归属变更；导入箱号按编号和名称匹配", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-direct-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, name] of [
      ["2", "华南分公司"],
      ["3", "华东分公司"],
      ["4", "华北分公司"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,0,?,?,1,1)",
        [id, name, `C${id}`]
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
    const born = [];
    for (const [imei, orgId, org, name, life] of [
      ["864317080992517", "2", "华南分公司", "华南甲", "未使用"],
      ["864317080992518", "2", "华南分公司", "华南乙", "未使用"],
      ["864317080992519", "4", "华北分公司", "华北甲", "未使用"],
      ["864317080992520", "2", "华南分公司", "停用箱", "停用"],
      ["864317080992521", "3", "华东分公司", "华东甲", "未使用"],
    ]) {
      const { box } = await ingest.accept(packet({ imei, uart: "why=boot,opens=0,seq=1" }));
      await boxes.updateBox(box.id, (item) => {
        item.life = life;
        item.org = org;
        item.orgId = orgId;
        item.name = name;
      });
      born.push(box.id);
    }
    const [southA, southB, north, stopped, eastBox] = born;
    const c = new ReportPolicyController(boxes, policies);
    const south = ctxOf(["2"]);
    const wide = ctxOf(["2", "4"]);
    const east = ctxOf(["3"], { id: "30", nickname: "华东签收员" });

    await assert.rejects(
      call(c.createTask.bind(c), {
        ...south,
        body: { name: "缺单位", kind: "调拨", direct: true, boxIds: [southA] },
      }),
      /调出单位|调入单位|寄出/
    );
    await assert.rejects(
      call(c.createTask.bind(c), {
        ...wide,
        body: {
          name: "混单位",
          kind: "调拨",
          direct: true,
          boxIds: [southA, north],
          fromOrgId: "2",
          toOrgId: "3",
        },
      }),
      /分开建单/
    );
    await assert.rejects(
      call(c.createTask.bind(c), {
        ...south,
        body: {
          name: "旧发货",
          kind: "调拨",
          boxIds: [southA],
          fromOrgId: "2",
          toOrgId: "3",
        },
      }),
      /寄出人|签收人/
    );

    const sample = new SampleController(boxes, policies);
    const looked = await call(sample.lookup.bind(sample), {
      ...south,
      body: {
        ids: [southB, "没有这台", "华南乙", stopped, eastBox, "  ", southB],
      },
    });
    assert.deepEqual(
      looked.list.map((box) => box.id),
      [southB]
    );
    assert.deepEqual(looked.missing.sort(), ["没有这台", eastBox].sort());
    assert.equal(looked.skipped.length, 1);
    assert.equal(looked.skipped[0].id, stopped);
    assert.equal(looked.skipped[0].reason, "已停用");
    assert.equal(looked.truncated, false);
    const busy = await call(sample.lookup.bind(sample), { ...south, body: { ids: "x" } });
    assert.match(busy.error, /箱子编号/);

    const created = await call(c.createTask.bind(c), {
      ...south,
      body: {
        name: "华南调华东",
        kind: "调拨",
        direct: true,
        boxIds: [southA],
        fromOrgId: "2",
        toOrgId: "3",
        fromPlace: { address: "不该保存", lng: 114.1, lat: 22.6 },
        sender: "不该保存",
        signer: "不该保存",
      },
    });
    const detail = await call(c.taskDetail.bind(c), { ...east, params: { id: created.id } });
    assert.equal(detail.task.status, "待签收");
    assert.equal(detail.task.direct, true);
    assert.equal(detail.task.fromPlace, null);
    assert.equal(detail.task.toPlace, null);
    assert.equal(detail.task.sender, "");
    assert.equal(detail.target ?? null, null);
    assert.deepEqual(detail.task.steps, ["待签收", "已签收"]);
    assert.equal(detail.can["运送中"], undefined);
    assert.equal(detail.can["已签收"], true);
    const senderView = await call(c.taskDetail.bind(c), { ...south, params: { id: created.id } });
    assert.equal(senderView.can["已签收"], false);
    const during = await call(sample.lookup.bind(sample), { ...south, body: { ids: [southA] } });
    assert.equal(during.skipped[0].reason, "已在其他任务中");

    await call(c.transition.bind(c), {
      ...east,
      params: { id: created.id },
      body: { status: "已签收" },
    });
    const moved = await boxes.findById(southA);
    assert.equal(moved.orgId, "3");
    assert.equal(moved.org, "华东分公司");
    const after = await call(sample.lookup.bind(sample), { ...east, body: { ids: [southA] } });
    assert.deepEqual(
      after.list.map((box) => box.id),
      [southA]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

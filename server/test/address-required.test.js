/**
 * 任务 #88 寄出地址必填（服务端 createTask 同口径）契约测试。
 * 一次性临时库，不碰开发/线上库、不占服务端口。守住：
 * 1. 寄送类（送检/采样后送检，含旧合并别名）新口径请求显式带 fromPlace 却空 → 400；
 * 2. 公司地址已设置：前端把公司地址作为最终 fromPlace（custom:false）下发 → 200（服务端仅校验非空）；
 * 3. 自定义地址（custom:true）→ 200；
 * 4. 本地采样（localOnly）无寄送腿 → 空/缺 fromPlace 均 200（豁免）；
 * 5. 兼容门：旧客户端/小程序省略 fromPlace 字段＝旧口径 → 200（保 451 基线与生产 mp，
 *    与 localOnly 显式标记同源；若后续要对全客户端强制需 mp 升级＋基线迁移，另批拍板）。
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
  "task:create:sample",
  "task:create:inspect",
  "task:policy",
]);
const ORG_NAMES = { 1: "总公司", 2: "华南分公司", 6: "总部检测站", 21: "调度室" };
const COMPANY_ADDR = { address: "华南分公司仓库", lng: 114.1175, lat: 22.6795 };

async function setup({ companyAddress = false } = {}) {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "address-required-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name, type] of [
    ["1", "0", "总公司", "公司"],
    ["6", "1", "总部检测站", "检测站"],
    ["2", "0", "华南分公司", "公司"],
    ["21", "2", "调度室", "公司"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  if (companyAddress)
    await db.run("UPDATE sys_dept SET address=?, lng=?, lat=?, contact=?, phone=? WHERE id='2'", [
      COMPANY_ADDR.address,
      COMPANY_ADDR.lng,
      COMPANY_ADDR.lat,
      "华南联系人",
      "0755-000",
    ]);
  await db.run("UPDATE sys_dept SET leader_user_id='60' WHERE id='6'");
  for (const p of [
    { id: "60", nickname: "检测站长", deptId: "6" },
    { id: "20", nickname: "华南寄件人", deptId: "2" },
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
  const ctx = (id, nickname, deptId, orgIds) => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: {
      perms: new Set(PERMS),
      scope: orgIds
        ? { all: false, orgIds, ownerIds: [] }
        : { all: true, orgIds: [], ownerIds: [] },
      roles: [],
    },
    ip: "127.0.0.1",
  });
  const admin = ctx("20", "华南寄件人", "2", null);
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
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const create = (body, actor = admin) =>
    run(controller.createTask.bind(controller), actor, { body });
  const teardown = async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, makeBox, taskRow, create, teardown };
}

/** 寄送类完整 payload（寄出人/签收人/检测站齐全），fromPlace 由调用方覆盖。 */
const shipBody = (boxId, kind, fromPlace) => {
  const body = {
    name: "地址必填探针",
    kind,
    boxIds: [boxId],
    senderId: "20",
    signerId: "60",
  };
  if (kind === "采样后送检" || kind === "采样") {
    body.fromOrgId = "2";
    body.orgId = "2";
    body.placeAt = { address: "华南采样点", lng: 114.1, lat: 22.6 };
  }
  if (fromPlace !== undefined) body.fromPlace = fromPlace;
  return body;
};

test("#88 寄送类显式空 fromPlace → 400（送检/采样后送检/旧合并别名）", async () => {
  const s = await setup();
  try {
    for (const kind of ["送检", "采样后送检", "采样"]) {
      const box = await s.makeBox("2");
      const nullRes = await s.create(shipBody(box.id, kind, null));
      assert.equal(nullRes.ok, false, `${kind} fromPlace:null 应拒`);
      assert.equal(nullRes.status, 400);
      assert.match(nullRes.message, /请设置寄出地址：选用公司地址或自定义/);
      const box2 = await s.makeBox("2");
      const emptyRes = await s.create(
        shipBody(box2.id, kind, { address: "", lng: null, lat: null })
      );
      assert.equal(emptyRes.ok, false, `${kind} 空地址对象应拒`);
      assert.equal(emptyRes.status, 400);
      assert.match(emptyRes.message, /请设置寄出地址/);
    }
    // 不落库：拒绝后任务表为空
    assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM sample_task")).n, 0);
  } finally {
    await s.teardown();
  }
});

test("#88 公司地址已设置：公司地址作最终 fromPlace（custom:false）→ 200；自定义地址 → 200", async () => {
  const s = await setup({ companyAddress: true });
  try {
    // 公司模式：前端把 effectiveDeptLocation 的公司地址原样下发（不传自定义）
    const box = await s.makeBox("2");
    const company = await s.create(
      shipBody(box.id, "采样后送检", { ...COMPANY_ADDR, orgId: "2", custom: false })
    );
    assert.ok(company.ok, company.message);
    assert.match(company.data.id, /^TK-/);
    const cb = JSON.parse((await s.taskRow(company.data.id)).body);
    assert.equal(cb.fromPlace.address, COMPANY_ADDR.address);
    assert.equal(cb.fromPlace.custom, false, "公司模式 custom=false");
    assert.equal(cb.fromPlace.orgId, "2");
    // 送检种同样放行
    const box2 = await s.makeBox("2");
    const inspect = await s.create(
      shipBody(box2.id, "送检", { ...COMPANY_ADDR, orgId: "2", custom: false })
    );
    assert.ok(inspect.ok, inspect.message);
    assert.match(inspect.data.id, /^IN-/);
    // 自定义地址（custom:true）
    const box3 = await s.makeBox("2");
    const custom = await s.create(
      shipBody(box3.id, "采样后送检", {
        address: "自定义收发室",
        lng: 114.2,
        lat: 22.7,
        custom: true,
      })
    );
    assert.ok(custom.ok, custom.message);
    const ub = JSON.parse((await s.taskRow(custom.data.id)).body);
    assert.equal(ub.fromPlace.custom, true);
    assert.equal(ub.fromPlace.address, "自定义收发室");
  } finally {
    await s.teardown();
  }
});

test("#88 本地采样（localOnly）豁免：空/缺 fromPlace 均 200", async () => {
  const s = await setup();
  try {
    const box = await s.makeBox("2");
    const omitted = await s.create({
      name: "本地采样",
      kind: "采样",
      localOnly: true,
      boxIds: [box.id],
      placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
    });
    assert.ok(omitted.ok, omitted.message);
    const box2 = await s.makeBox("2");
    const nullRes = await s.create({
      name: "本地采样2",
      kind: "采样",
      localOnly: true,
      boxIds: [box2.id],
      fromPlace: null,
    });
    assert.ok(nullRes.ok, nullRes.message);
    const box3 = await s.makeBox("2");
    const emptyRes = await s.create({
      name: "本地采样3",
      kind: "采样",
      localOnly: true,
      boxIds: [box3.id],
      fromPlace: { address: "", lng: null, lat: null },
    });
    assert.ok(emptyRes.ok, emptyRes.message);
  } finally {
    await s.teardown();
  }
});

test("#88 兼容门：寄送类省略 fromPlace 字段（旧客户端/小程序）→ 200 保留旧口径", async () => {
  const s = await setup();
  try {
    for (const kind of ["送检", "采样后送检", "采样"]) {
      const box = await s.makeBox("2");
      const res = await s.create(shipBody(box.id, kind, undefined));
      assert.ok(res.ok, `${kind} 省略 fromPlace 应兼容放行：${res.message}`);
      const body = JSON.parse((await s.taskRow(res.data.id)).body);
      assert.equal(body.fromPlace ?? null, null, "旧口径无寄出地址快照");
    }
  } finally {
    await s.teardown();
  }
});

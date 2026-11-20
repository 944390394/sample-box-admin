import test from "node:test";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrate, openDatabase } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { nextOf, signTargetOf, stepsOf } from "../src/settings/taskFlow.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

async function call(fn, ctx) {
  let out;
  await fn({ ...ctx, ok: (data) => (out = data), fail: (message) => (out = { error: message }) });
  return out;
}

test("流程：trip 作废——合并采样单按新流，旧 trip 单只读渲染（读兼容）", () => {
  // 新建合并流（不带 trip；body 恒 inspect=true，M2 判别按 inspect）
  assert.deepEqual(stepsOf({ kind: "采样", inspect: true }), [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待签收",
    "待检测",
    "已检测",
  ]);
  assert.deepEqual(nextOf({ kind: "采样", inspect: true }, "已封箱"), ["在途", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", inspect: true }, "在途"), ["待签收", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", inspect: true }, "已检测"), ["退回中"]);
  // M2：旧无 trip 采样单（inspect falsy）停「在途」仍按旧流 在途→待核验，不误判合并单
  assert.deepEqual(nextOf({ kind: "采样" }, "在途"), ["待核验", "已取消"]);
  assert.deepEqual(signTargetOf({ kind: "采样" }), "已签收");
  // 旧 trip 单仍按旧流渲染（历史进度条）
  assert.deepEqual(stepsOf({ kind: "采样", trip: "单向" }), [
    "待寄出",
    "运送中",
    "待采样",
    "采样中",
    "已封箱",
    "已完成",
  ]);
  assert.deepEqual(stepsOf({ kind: "采样", trip: "双向" }), [
    "待寄出",
    "运送中",
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待核验",
    "已签收",
  ]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "单向" }, "已封箱"), ["已完成", "已取消"]);
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向" }, "待核验"), [
    "已签收",
    "已拒收",
    "已取消",
  ]);
  // 旧通用任务三步
  assert.deepEqual(nextOf({ kind: "采样" }, "待执行"), ["执行中", "已取消"]);
  // 旧调拨不变
  assert.deepEqual(nextOf({ kind: "调拨" }, "待签收"), ["已签收", "已拒收", "退回中", "已取消"]);
});

test("合并单：建单忽略 trip（即使旧客户端传双向），接收方固定检测站、采样单位＝寄出分公司", async () => {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "6" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-trip-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    for (const [id, parent, name, type] of [
      ["1", "0", "总公司", "公司"],
      ["6", "1", "总部检测站", "检测站"],
      ["2", "0", "华南分公司", "公司"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, parent, name, `C${id}`, type]
      );
    }
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('60','s1','检测员','x','6',1)"
    );
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('20','s2','华南寄件人','x','2',1)"
    );
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(
      packet({ uart: "why=boot,opens=0,seq=1", gpsfix: 1, lng: 114.1, lat: 22.6 })
    );
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
      b.orgId = "2";
      b.org = "华南分公司";
    });
    const c = new ReportPolicyController(boxes, policies);
    const perms = new Set(
      upgradeCodes([
        "device:box:task",
        "device:box:policyTask",
        "device:box:location",
        "task:sample-start",
        "task:seal",
        "task:send-back",
        "task:arrive",
        "task:sign",
        "task:inspect",
        "task:cancel",
      ])
    );
    const admin = {
      user: { id: "1", nickname: "管理员" },
      access: { roles: ["ADMIN"], perms, scope: { all: true, orgIds: [], ownerIds: [] } },
    };
    // 旧客户端仍传 trip=双向 + orgId：服务端忽略 trip，采样单位取寄出分公司，接收方固定检测站
    const { id } = await call(c.createTask.bind(c), {
      ...admin,
      body: {
        name: "合并采样",
        kind: "采样",
        boxIds: [box.id],
        trip: "双向",
        orgId: "6",
        fromOrgId: "2",
        senderId: "20",
        signer: "检测员",
        placeAt: { address: "华南采样点", lng: 114.1, lat: 22.6 },
      },
    });
    const detail = await call(c.taskDetail.bind(c), { ...admin, params: { id } });
    assert.equal(detail.task.status, "待采样", "trip 被忽略，不从待寄出起步");
    assert.equal(detail.task.trip, undefined);
    assert.equal(detail.task.orgId, "2", "采样单位＝寄出分公司，不是旧 orgId");
    assert.equal(detail.task.toOrgId, "6", "接收方固定检测站");
    assert.equal(detail.task.inspect, true);
    assert.deepEqual(detail.task.steps, [
      "待采样",
      "采样中",
      "已封箱",
      "在途",
      "待签收",
      "待检测",
      "已检测",
    ]);
    assert.equal(detail.target.role, "计划地点");
    // 推进合并主路径到待检测（签收），箱子交检测站
    for (const status of ["采样中", "已封箱", "在途", "待签收"])
      await call(c.transition.bind(c), { ...admin, params: { id }, body: { status } });
    await boxes.updateBox(box.id, (b) => {
      b.gpsLng = 114.3;
      b.gpsLat = 22.8;
    });
    await call(c.transition.bind(c), { ...admin, params: { id }, body: { status: "待检测" } });
    assert.equal((await boxes.findById(box.id)).orgId, "6");
    await call(c.transition.bind(c), { ...admin, params: { id }, body: { status: "已检测" } });
    assert.equal(
      (await db.get("SELECT status FROM sample_task WHERE id=?", [id])).status,
      "已检测"
    );
    assert.equal((await boxes.findById(box.id)).life, "未使用");
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

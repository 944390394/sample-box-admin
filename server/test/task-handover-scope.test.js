/**
 * 任务流转的数据范围守卫（体检编号 L-P0-1 / signerId 越权链）。
 *
 * 修复前的行为：createTask 只校验签收人「账号存在且未停用」，transition 用裸 SELECT 取单，
 * #handOver 无条件把单上的箱子改挂到接收单位。串起来就是：A 单位能把签收人写成 B 单位用户，
 * B 单位用户 GET 任务是 404，PUT status 却能签收成功，并把 A 的箱子 org_id/owner_id 改成自己。
 *
 * 这里守住四条不变量：
 * 1. 建单时寄出人、签收人必须挂在那一方单位（含下级科室）名下；
 * 2. 范围外账号读写同一张单一律 404 A0404，不再出现 500 B0001，也不改数据；
 * 3. 签收人以旧数据里的外来 signerId、或建单后被调走时，不能正常签收；
 *    接收单位他人强制签收后，外来用户不会被写成这批箱子的保管人（保管人会带出读取范围）；
 * 4. 交接只带走还挂在寄出单位名下的箱子，建单后被改挂他单位的箱子跳过并回给页面。
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
import { packet } from "./fixture.js";

const PERMS = upgradeCodes([
  "device:box:list",
  "device:box:detail",
  "device:box:task",
  "device:box:location",
  "device:box:event",
  "task:create:transfer",
  "task:create:sample",
  "task:send",
  "task:arrive",
  "task:sign",
  "task:reject",
  "task:force-sign",
  "task:inspect",
  "task:cancel",
]);

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-scope-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  for (const [id, parent, name] of [
    ["2", "0", "A单位"],
    ["3", "0", "B单位"],
    ["4", "0", "C单位"],
    ["41", "4", "C单位收发室"],
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,?,?, ?,1,1)",
      [id, parent, name, `C${id}`]
    );
  const people = {
    a: { id: "101", nickname: "A单位员工", deptId: "2" },
    b: { id: "201", nickname: "B单位员工", deptId: "3" },
    c: { id: "401", nickname: "C单位员工", deptId: "4" },
    desk: { id: "402", nickname: "收发室员工", deptId: "41" },
  };
  for (const p of Object.values(people))
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,'x','x',?,1)",
      [p.id, `u${p.id}`, p.deptId]
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
  const run = async (fn, ctx, extra = {}) => {
    let out;
    try {
      await fn({
        ...ctx,
        ...extra,
        ok: (data) => (out = { ok: true, data }),
        fail: () => (out = { ok: false }),
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
  /** 建一台挂在某个单位名下的箱子 */
  const makeBox = async (imei, orgId) => {
    const { box } = await ingest.accept(packet({ imei, uart: "why=boot,opens=0,seq=1" }));
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
    });
    return box.id;
  };
  const boxRow = (id) => db.get("SELECT org_id,owner_id,life FROM sample_box WHERE id=?", [id]);
  const taskRow = (id) => db.get("SELECT status,body FROM sample_task WHERE id=?", [id]);
  return {
    db,
    dir,
    boxes,
    controller,
    ctx,
    run,
    makeBox,
    boxRow,
    taskRow,
    people,
    /** 依次推进状态，任何一步失败就把实际结果抛出来，方便定位 */
    advance: async (id, steps) => {
      for (const [actor, status] of steps) {
        const res = await run(controller.transition.bind(controller), actor, {
          params: { id },
          body: { status },
        });
        assert.ok(res.ok, `${status} 失败：${res.code} ${res.message}`);
      }
    },
  };
}

const transfer = (boxIds, extra) => ({
  name: "调拨到C",
  kind: "调拨",
  fromOrgId: "2",
  toOrgId: "4",
  boxIds,
  ...extra,
});

test("建单：寄出人、签收人必须挂在自己那一方的单位（含下级科室）名下", async () => {
  const s = await setup();
  try {
    const box = await s.makeBox("864317080900001", "2");
    // 签收人是 B 单位的人：A 不能把他写成 C 单位的签收人
    const foreignSigner = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: transfer([box], { senderId: "101", signerId: "201" }),
      }
    );
    assert.equal(foreignSigner.ok, false);
    assert.equal(foreignSigner.code, "A0400");
    assert.match(foreignSigner.message, /签收人/);
    // 寄出人同理
    const foreignSender = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: transfer([box], { senderId: "201", signerId: "401" }),
      }
    );
    assert.equal(foreignSender.code, "A0400");
    assert.match(foreignSender.message, /寄出人/);
    // 非法建单不能留下任何单：否则箱子被绑进一张没人能收尾的单
    assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM sample_task")).n, 0);
    assert.equal((await s.boxRow(box)).life, "未使用");
    // 挂在接收单位下级科室的人算接收单位的人
    const desk = await s.run(s.controller.createTask.bind(s.controller), s.ctx(s.people.a, ["2"]), {
      body: transfer([box], { senderId: "101", signerId: "402" }),
    });
    assert.ok(desk.ok, desk.message);
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("范围外账号读写同一张单一律 404 A0404，箱子归属不动", async () => {
  const s = await setup();
  try {
    const box = await s.makeBox("864317080900002", "2");
    const created = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: transfer([box], { senderId: "101", signerId: "401" }),
      }
    );
    const id = created.data.id;
    await s.advance(id, [
      [s.ctx(s.people.a, ["2"]), "运送中"],
      [s.ctx(s.people.a, ["2"]), "待签收"],
    ]);
    const outsider = s.ctx(s.people.b, ["3"]);
    const before = await s.boxRow(box);
    for (const status of ["已签收", "已拒收", "已检测", "已取消"]) {
      const res = await s.run(s.controller.transition.bind(s.controller), outsider, {
        params: { id },
        body: { status },
      });
      assert.equal(res.ok, false, `${status} 竟然越权成功`);
      // 修复前这里是 500 B0001（把内部文案回给客户端）或 403；现在与读同一口径
      assert.equal(res.code, "A0404", `${status} 实际 ${res.code} ${res.message}`);
      assert.equal(res.status, 404);
    }
    const read = await s.run(s.controller.taskDetail.bind(s.controller), outsider, {
      params: { id },
    });
    assert.equal(read.code, "A0404");
    assert.deepEqual(await s.boxRow(box), before);
    assert.equal((await s.taskRow(id)).status, "待签收");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("外来 signerId 的旧数据：本人不能签收，他人强制签收也不会把他变成保管人", async () => {
  const s = await setup();
  try {
    const box = await s.makeBox("864317080900003", "2");
    const created = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: transfer([box], { senderId: "101", signerId: "401" }),
      }
    );
    const id = created.data.id;
    await s.advance(id, [
      [s.ctx(s.people.a, ["2"]), "运送中"],
      [s.ctx(s.people.a, ["2"]), "待签收"],
    ]);
    // 模拟改造前的遗留数据：单上的签收人被写成 B 单位用户
    const row = await s.taskRow(id);
    const body = { ...JSON.parse(row.body), signerId: "201", signer: "B单位员工" };
    await s.db.run("UPDATE sample_task SET body=? WHERE id=?", [JSON.stringify(body), id]);
    const sign = await s.run(s.controller.transition.bind(s.controller), s.ctx(s.people.b, ["3"]), {
      params: { id },
      body: { status: "已签收" },
    });
    assert.equal(sign.code, "A0404");
    const untouched = await s.boxRow(box);
    assert.equal(untouched.org_id, "2");
    assert.equal(untouched.owner_id, "");
    assert.equal(untouched.life, "在途");
    assert.equal(untouched.owner_id, "", "范围外账号不该改动箱子归属");
    // 接收单位里其他人强制签收：能收，但外来用户不被写成保管人（保管人会带出读取范围）
    const forced = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "强制签收", note: "签收人账号异常，代收" },
      }
    );
    assert.ok(forced.ok, forced.message);
    const after = await s.boxRow(box);
    assert.equal(after.org_id, "4");
    assert.equal(after.owner_id, "", "外来签收人不能成为接收单位箱子的保管人");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("签收人建单后被调走：正常签收拦住，交接只带走还挂在寄出单位名下的箱子", async () => {
  const s = await setup();
  try {
    const staying = await s.makeBox("864317080900004", "2");
    const movedAway = await s.makeBox("864317080900005", "2");
    const created = await s.run(
      s.controller.createTask.bind(s.controller),
      s.ctx(s.people.a, ["2"]),
      {
        body: transfer([staying, movedAway], { senderId: "101", signerId: "401" }),
      }
    );
    const id = created.data.id;
    await s.advance(id, [
      [s.ctx(s.people.a, ["2"]), "运送中"],
      [s.ctx(s.people.a, ["2"]), "待签收"],
    ]);
    // 建单后这台箱子被 B 单位资产纠错改挂走
    await s.boxes.updateBox(movedAway, (item) => {
      item.orgId = "3";
    });
    // 签收人被调到 B 单位：以签收人身份正常签收要拦住
    await s.db.run("UPDATE sys_user SET dept_id='3' WHERE id='401'", []);
    const denied = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.c, ["4"]),
      {
        params: { id },
        body: { status: "已签收" },
      }
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    assert.match(denied.message, /强制签收/);
    assert.equal((await s.boxRow(staying)).org_id, "2");
    // 账号调回接收单位，改由接收单位里的另一个人强制签收（指定的签收人本人不能强制签收）：
    // 已改挂的那台跳过，不被拉到接收单位
    await s.db.run("UPDATE sys_user SET dept_id='4' WHERE id='401'", []);
    const forced = await s.run(
      s.controller.transition.bind(s.controller),
      s.ctx(s.people.desk, ["4", "41"]),
      { params: { id }, body: { status: "强制签收", note: "两台一起代收" } }
    );
    assert.ok(forced.ok, forced.message);
    assert.deepEqual(
      (forced.data.handOverSkipped || []).map((item) => item.id),
      [movedAway]
    );
    assert.equal((await s.boxRow(staying)).org_id, "4");
    assert.equal((await s.boxRow(movedAway)).org_id, "3", "已改挂他单位的箱子不能被签收方带走");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

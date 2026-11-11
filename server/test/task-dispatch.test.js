import test from "node:test";
import { upgradeCodes } from "../src/auth/permCatalog.js";
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
import { applyBoxSettings, currentBoxSettings } from "../src/settings/boxConfig.js";
import { radiusOf } from "../src/settings/taskPlaces.js";
import { distanceM, effectiveDeptLocation, readPlace } from "../src/geo/place.js";
import * as org from "../org-api.js";
import { packet } from "./fixture.js";

const ALL = [
  "device:box:task",
  "device:box:policyTask",
  "device:box:location",
  "device:box:event",
  "device:box:policyRead",
  "task:sign",
  "task:cancel",
];
const ctxOf = (orgIds, perms = ALL, user = { id: "9", nickname: "测试员" }) => ({
  user,
  access: {
    perms: new Set(upgradeCodes(perms)),
    scope: orgIds ? { all: false, orgIds, ownerIds: [] } : { all: true, orgIds: [], ownerIds: [] },
  },
});
async function call(fn, ctx) {
  let out;
  await fn({ ...ctx, ok: (d) => (out = d), fail: (m) => (out = { error: m }) });
  return out;
}

test("地址工具：坐标校验、距离、单位位置向上继承", () => {
  assert.equal(readPlace(null), null);
  assert.equal(readPlace({ address: "", lng: 0, lat: 0 }), null);
  assert.throws(() => readPlace({ address: "x", lng: 200, lat: 10 }), /坐标/);
  assert.equal(readPlace({ address: "x", lng: 114, lat: 22, radiusM: 300 }).radiusM, 300);
  assert.throws(() => readPlace({ address: "x", lng: 114, lat: 22, radiusM: 10 }), /误差范围/);
  assert.equal(radiusOf({ radiusM: 300 }), 300);
  assert.equal(radiusOf(null), currentBoxSettings().arriveRadiusM);
  assert.deepEqual(
    readPlace({ address: " 3号楼 ", lng: "114.1", lat: "22.6", orgId: 5, custom: 1 }),
    { address: "3号楼", lng: 114.1, lat: 22.6, orgId: "5", custom: true }
  );
  // 深圳平湖到深圳福田约 20 公里
  const d = distanceM({ lng: 114.1175, lat: 22.6795 }, { lng: 114.0579, lat: 22.5431 });
  assert.ok(d > 15000 && d < 20000, String(d));
  const rows = [
    {
      id: "2",
      parent_id: "0",
      name: "华南分公司",
      address: "深圳某路 1 号",
      lng: 114.1,
      lat: 22.6,
    },
    { id: "21", parent_id: "2", name: "调度室", address: null, lng: null, lat: null },
  ];
  const loc = effectiveDeptLocation(rows, "21");
  assert.equal(loc.fromName, "华南分公司");
  assert.equal(loc.inherited, true);
  assert.equal(effectiveDeptLocation(rows, "2").inherited, false);
});

test("调拨：选单位带出地址，寄出方寄出，接收方看得到并签收，箱子改归接收单位，流转记录带距离", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-dispatch-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    for (const [id, parent, name, code] of [
      ["2", "0", "华南分公司", "S"],
      ["21", "2", "调度室", "S1"],
      ["3", "0", "华东分公司", "E"],
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,?,?,?,1,1)",
        [id, parent, name, code]
      );
    }
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('30','e1','华东签收员','x','3',1)"
    );
    // 部门接口保存位置；不带位置字段的旧表单不清掉原值
    const admin = { db, user: { id: "1", nickname: "admin" } };
    await call(org.updateDept, {
      ...admin,
      params: { id: "2" },
      body: {
        name: "华南分公司",
        address: "深圳平湖",
        lng: 114.1175,
        lat: 22.6795,
        contact: "张三",
        phone: "123",
      },
    });
    await call(org.updateDept, {
      ...admin,
      params: { id: "3" },
      body: { name: "华东分公司", address: "深圳福田收发室", lng: 114.0579, lat: 22.5431 },
    });
    await call(org.updateDept, { ...admin, params: { id: "3" }, body: { name: "华东分公司" } });
    const form = await call(org.deptForm, { ...admin, params: { id: "3" } });
    assert.equal(form.address, "深圳福田收发室");
    assert.match(
      (await call(org.updateDept, { ...admin, params: { id: "3" }, body: { lng: 500, lat: 1 } }))
        .error,
      /坐标/
    );

    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.10,seq=1" }));
    // 箱子在华南、坐标就在寄出地址附近
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
      b.org = "华南分公司";
      b.orgId = "2";
      b.lbsLng = 114.118;
      b.lbsLat = 22.68;
    });

    const c = new ReportPolicyController(boxes, policies);
    const south = ctxOf(["2", "21"]),
      east = ctxOf(["3"], ["device:box:task", "device:box:location", "task:sign"], {
        id: "30",
        nickname: "华东签收员",
      });
    const options = await call(c.taskOptions.bind(c), { ...south, query: {} });
    const desk = options.orgs.find((o) => o.id === "21");
    assert.equal(desk.location.fromName, "华南分公司");
    assert.equal(options.orgs.find((o) => o.id === "3").inScope, false);
    const people = await call(c.taskOptions.bind(c), { ...south, query: { orgId: "3" } });
    assert.deepEqual(
      people.users.map((u) => u.name),
      ["华东签收员"]
    );

    // 寄出单位必须在自己范围内
    const base = {
      name: "调拨测试",
      kind: "调拨",
      boxIds: [box.id],
      sender: "华南寄件人",
      signerId: "30",
    };
    await assert.rejects(
      call(c.createTask.bind(c), {
        ...ctxOf(["2", "21"]),
        body: { ...base, fromOrgId: "3", toOrgId: "2" },
      }),
      /寄出单位/
    );
    const created = await call(c.createTask.bind(c), {
      ...south,
      body: {
        ...base,
        fromOrgId: "2",
        toOrgId: "3",
        fromPlace: { ...desk.location, orgId: "2" },
        toPlace: {
          address: "华东 3 号楼收发室",
          lng: 114.0579,
          lat: 22.5431,
          orgId: "3",
          custom: true,
        },
      },
    });
    const id = created.id;

    // 接收方在列表和详情里都看得到，但还不能寄出
    const eastList = await call(c.tasks.bind(c), { ...east, query: {} });
    assert.deepEqual(
      eastList.list.map((t) => t.id),
      [id]
    );
    let detail = await call(c.taskDetail.bind(c), { ...east, params: { id } });
    assert.equal(detail.task.signer, "华东签收员");
    assert.equal(detail.target.role, "寄出地址");
    assert.equal(detail.boxes[0].near, true);
    assert.equal(detail.can["运送中"], false);
    await assert.rejects(
      call(c.transition.bind(c), { ...east, params: { id }, body: { status: "运送中" } }),
      /权限/
    );

    // 寄出方寄出：流转记录带寄出地址距离
    await call(c.transition.bind(c), {
      ...south,
      params: { id },
      body: { status: "运送中", note: "顺丰" },
    });
    // 运送途中两个 GPS 点、一次开箱：进轨迹和时间线
    await ingest.accept(
      packet({ uart: "why=timer,opens=0,seq=2", gpsfix: 1, lng: 114.1, lat: 22.6 })
    );
    await ingest.accept(
      packet({ uart: "why=pad,opens=1,seq=3", gpsfix: 1, lng: 114.09, lat: 22.59 })
    );
    detail = await call(c.taskDetail.bind(c), { ...south, params: { id } });
    const track = detail.tracks[0];
    assert.equal(track.boxId, box.id);
    assert.equal(track.gpsCount, 2);
    assert.ok(track.distanceM > 1000 && track.distanceM < 2000, String(track.distanceM));
    assert.deepEqual(
      detail.events.map((e) => e.label),
      ["开箱"]
    );
    assert.deepEqual(detail.videos, []);
    // 采样箱详情按任务看轨迹：能看这个任务、有当前位置就行，不需要历史轨迹；只给这台箱子
    const byTask = await call(c.taskTrack.bind(c), {
      ...east,
      params: { id },
      query: { boxId: box.id },
    });
    assert.equal(byTask.task.id, id);
    assert.equal(byTask.task.kind, "调拨");
    assert.equal(byTask.tracks.length, 1);
    assert.equal(byTask.tracks[0].gpsCount, 2);
    assert.deepEqual(
      byTask.places.map((p) => p.role),
      ["寄出地址", "收货地址"]
    );
    // 接收方没有「查看开关箱记录」：轨迹照给，开箱事件不给；寄出方有，就给
    assert.deepEqual(
      byTask.events.map((e) => e.label),
      []
    );
    assert.deepEqual(
      (
        await call(c.taskTrack.bind(c), { ...south, params: { id }, query: { boxId: box.id } })
      ).events.map((e) => e.label),
      ["开箱"]
    );
    assert.equal(byTask.window.from, detail.window.from);
    await assert.rejects(
      call(c.taskTrack.bind(c), { ...east, params: { id }, query: { boxId: "OTHER" } }),
      /不在这个任务/
    );
    await assert.rejects(
      call(c.taskTrack.bind(c), {
        ...ctxOf(["3"], ["device:box:task"]),
        params: { id },
        query: {},
      }),
      /权限/
    );
    await assert.rejects(
      call(c.taskTrack.bind(c), { ...ctxOf(["99"]), params: { id }, query: {} }),
      /不存在/
    );
    await boxes.updateBox(box.id, (b) => {
      b.gpsLng = null;
      b.gpsLat = null;
    });
    assert.equal(detail.target.role, "收货地址");
    assert.equal(detail.boxes[0].near, false);
    const sent = detail.logs.find((l) => l.action === "确认寄出");
    assert.equal(sent.note, "顺丰");
    assert.equal(sent.by, "测试员");
    assert.equal(sent.detail.target.role, "寄出地址");
    assert.ok(sent.detail.boxes[0].distanceM < 2000);
    const listing = await call(c.tasks.bind(c), {
      ...south,
      query: { status: "进行中", kind: "调拨", q: "调拨" },
    });
    assert.deepEqual(listing.list[0].arrival, { role: "收货地址", near: 0, total: 1 });

    // 寄出方不能替接收方签收；接收方确认到达后签收
    await call(c.transition.bind(c), { ...east, params: { id }, body: { status: "待签收" } });
    await assert.rejects(
      call(c.transition.bind(c), { ...south, params: { id }, body: { status: "已签收" } }),
      /接收单位/
    );
    // 接收单位里不是签收人的同事：不能正常签收，只能强制签收
    const colleague = ctxOf(["3"], ["device:box:task", "task:sign"], {
      id: "31",
      nickname: "华东值班员",
    });
    const peer = await call(c.taskDetail.bind(c), { ...colleague, params: { id } });
    assert.equal(peer.can["已签收"], false);
    assert.equal(peer.can["强制签收"], true);
    assert.equal(peer.can["已拒收"], true);
    await assert.rejects(
      call(c.transition.bind(c), { ...colleague, params: { id }, body: { status: "已签收" } }),
      /强制签收/
    );
    // 箱子还在 15 公里外：签收核验有问题，签收人也不能直接签收，只能拒收或强制签收
    detail = await call(c.taskDetail.bind(c), { ...east, params: { id } });
    assert.equal(detail.can["已签收"], false);
    assert.equal(detail.can["强制签收"], true);
    assert.match(detail.check.problems[0].text, /不在附近/);
    await assert.rejects(
      call(c.transition.bind(c), { ...east, params: { id }, body: { status: "已签收" } }),
      /有异常/
    );
    // 到了收货地址附近：签收人正常签收
    await boxes.updateBox(box.id, (b) => {
      b.lbsLng = 114.0581;
      b.lbsLat = 22.5433;
    });
    detail = await call(c.taskDetail.bind(c), { ...east, params: { id } });
    assert.equal(detail.can["已签收"], true);
    assert.equal(detail.can["强制签收"], false);
    assert.deepEqual(detail.check.problems, []);
    await call(c.transition.bind(c), {
      ...east,
      params: { id },
      body: { status: "已签收", note: "外箱完好" },
    });
    const moved = await boxes.findByImei(box.imei);
    assert.equal(moved.orgId, "3");
    assert.equal(moved.org, "华东分公司");
    assert.equal(moved.ownerId, "30");
    detail = await call(c.taskDetail.bind(c), { ...east, params: { id } });
    assert.deepEqual(
      detail.logs.map((l) => l.action),
      ["创建", "确认寄出", "确认到达", "签收"]
    );
    const signed = detail.logs.at(-1);
    assert.equal(signed.detail.target.role, "收货地址");
    assert.ok(signed.detail.boxes[0].distanceM < 2000);

    // 没有位置权限时详情里不给坐标和距离
    const blind = await call(c.taskDetail.bind(c), {
      ...ctxOf(["3"], ["device:box:task"]),
      params: { id },
    });
    assert.equal(blind.boxes[0].position, null);
    assert.equal(blind.logs[1].detail, null);
    assert.deepEqual(blind.tracks, []);
    assert.equal(blind.boxes[0].status, null);
    // 不相关单位看不到
    await assert.rejects(
      call(c.taskDetail.bind(c), { ...ctxOf(["99"]), params: { id } }),
      /不存在/
    );

    // 寄回华南，签收人没来点：管理员强制签收要写原因，流转记成「强制签收」，箱子照样交给签收人
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('20','s1','华南签收员','x','2',1)"
    );
    const admin2 = ctxOf(null);
    const back = await call(c.createTask.bind(c), {
      ...admin2,
      body: {
        name: "寄回",
        kind: "调拨",
        boxIds: [box.id],
        sender: "华东寄件人",
        signerId: "20",
        fromOrgId: "3",
        toOrgId: "2",
      },
    });
    await call(c.transition.bind(c), {
      ...admin2,
      params: { id: back.id },
      body: { status: "运送中" },
    });
    await call(c.transition.bind(c), {
      ...admin2,
      params: { id: back.id },
      body: { status: "待签收" },
    });
    await assert.rejects(
      call(c.transition.bind(c), {
        ...admin2,
        params: { id: back.id },
        body: { status: "强制签收" },
      }),
      /原因/
    );
    await call(c.transition.bind(c), {
      ...admin2,
      params: { id: back.id },
      body: { status: "强制签收", note: "签收人休假" },
    });
    detail = await call(c.taskDetail.bind(c), { ...admin2, params: { id: back.id } });
    assert.equal(detail.task.status, "已签收");
    assert.deepEqual(detail.logs.map((l) => [l.action, l.note]).at(-1), ["强制签收", "签收人休假"]);
    const home = await boxes.findByImei(box.imei);
    assert.equal(home.orgId, "2");
    assert.equal(home.ownerId, "20");
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("部门负责人：新建账号（随机或手填密码）、选已有用户、清空；调拨候选单位带出负责人", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dept-leader-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('14','机构负责人','AGENCY_LEAD',2,1,1)"
    );
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status,mobile) VALUES ('7','old','老员工','x','1',1,'139')"
    );
    const admin = { db, user: { id: "1", nickname: "admin" } };
    const { verifyPassword } = await import("../auth.js");
    // 随机密码：只在这次返回一次
    const made = await call(org.createDept, {
      ...admin,
      body: {
        parentId: "0",
        name: "机构丙",
        code: "C",
        leader: {
          create: { nickname: "丙负责人", username: "lead.c", mobile: "138", roleIds: ["14"] },
        },
      },
    });
    assert.equal(made.leader.username, "lead.c");
    assert.equal(made.leader.password.length, 10);
    const lead = await db.get("SELECT * FROM sys_user WHERE username='lead.c'");
    assert.ok(verifyPassword(made.leader.password, lead.password_hash));
    const dept = await db.get("SELECT * FROM sys_dept WHERE code='C'");
    assert.equal(lead.dept_id, dept.id);
    assert.equal(dept.leader_user_id, lead.id);
    assert.deepEqual(
      (await db.all("SELECT role_id FROM sys_user_role WHERE user_id=?", [lead.id])).map(
        (r) => r.role_id
      ),
      ["14"]
    );
    const form = await call(org.deptForm, { ...admin, params: { id: dept.id } });
    assert.equal(form.leaderName, "丙负责人");
    // 用户名重复、密码太短都整单失败，不留下部门
    assert.match(
      (
        await call(org.createDept, {
          ...admin,
          body: {
            parentId: "0",
            name: "重复",
            code: "D",
            leader: { create: { nickname: "x", username: "lead.c" } },
          },
        })
      ).error,
      /已存在/
    );
    assert.match(
      (
        await call(org.createDept, {
          ...admin,
          body: {
            parentId: "0",
            name: "短密码",
            code: "D",
            leader: { create: { nickname: "x", username: "x.y", password: "123" } },
          },
        })
      ).error,
      /至少 8 位/
    );
    assert.equal(await db.get("SELECT id FROM sys_dept WHERE code='D'"), undefined);
    // 手填密码不回传
    const manual = await call(org.updateDept, {
      ...admin,
      params: { id: dept.id },
      body: {
        name: "机构丙",
        leader: { create: { nickname: "新负责人", username: "lead.c2", password: "Strong#2026" } },
      },
    });
    assert.equal(manual.leader.password, "");
    assert.ok(
      verifyPassword(
        "Strong#2026",
        (await db.get("SELECT password_hash FROM sys_user WHERE username='lead.c2'")).password_hash
      )
    );
    // 不带 leader 不改；选已有用户；清空
    await call(org.updateDept, { ...admin, params: { id: dept.id }, body: { name: "机构丙" } });
    assert.equal(
      (await call(org.deptForm, { ...admin, params: { id: dept.id } })).leaderName,
      "新负责人"
    );
    await call(org.updateDept, {
      ...admin,
      params: { id: dept.id },
      body: { name: "机构丙", leader: { userId: "7" } },
    });
    const c = new ReportPolicyController({}, new ReportPolicy(db));
    const options = await call(c.taskOptions.bind(c), { ...ctxOf(null), query: {} });
    assert.deepEqual(options.orgs.find((o) => o.id === dept.id).leader, {
      id: "7",
      name: "老员工",
    });
    await call(org.updateDept, {
      ...admin,
      params: { id: dept.id },
      body: { name: "机构丙", leader: null },
    });
    assert.equal(
      (await call(org.deptForm, { ...admin, params: { id: dept.id } })).leaderUserId,
      ""
    );
    assert.match(
      (
        await call(org.updateDept, {
          ...admin,
          params: { id: dept.id },
          body: { leader: { userId: "404" } },
        })
      ).error,
      /负责人/
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("采样任务：选采样单位和计划地点，旧接口不带新字段照常创建", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-sample-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES ('5','0','采样机构甲','A',1,1)"
    );
    const ingest = new IngestService({
      boxes,
      policies,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(packet({ uart: "why=boot,opens=0,fw=1.0.10,seq=1" }));
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
      b.lbsLng = 114.1;
      b.lbsLat = 22.6;
    });
    const c = new ReportPolicyController(boxes, policies);
    const ctx = ctxOf(null);
    const { id } = await call(c.createTask.bind(c), {
      ...ctx,
      body: {
        name: "采样",
        kind: "采样",
        boxIds: [box.id],
        orgId: "5",
        placeAt: { address: "某河段 2 号点", lng: 114.1, lat: 22.6 },
      },
    });
    const detail = await call(c.taskDetail.bind(c), { ...ctx, params: { id } });
    assert.equal(detail.task.org, "采样机构甲");
    assert.equal(detail.task.place, "某河段 2 号点");
    assert.equal(detail.target.role, "计划地点");
    assert.equal(detail.boxes[0].near, true);
    assert.equal(detail.can["采样中"], true);
    // 建单即占用：箱子显示「在途」，没结束前不能再绑到别的单；取消后回到「未使用」
    assert.equal((await boxes.findById(box.id)).life, "在途");
    await assert.rejects(
      call(c.createTask.bind(c), {
        ...ctx,
        body: { name: "又一单", kind: "采样", boxIds: [box.id] },
      }),
      /已在任务单「采样」里/
    );
    await call(c.transition.bind(c), { ...ctx, params: { id }, body: { status: "已取消" } });
    assert.equal((await boxes.findById(box.id)).life, "未使用");
    // 开箱次数上限：开始时记下次数，任务期间超过就标出来
    await assert.rejects(
      call(c.createTask.bind(c), {
        ...ctx,
        body: { name: "x", kind: "采样", boxIds: [box.id], maxOpens: -1 },
      }),
      /开箱次数/
    );
    await boxes.updateBox(box.id, (b) => {
      b.opens = 5;
    });
    const limited = await call(c.createTask.bind(c), {
      ...ctx,
      body: { name: "限开", kind: "采样", boxIds: [box.id], maxOpens: 1 },
    });
    assert.equal(
      (await call(c.taskDetail.bind(c), { ...ctx, params: { id: limited.id } })).boxes[0]
        .opensDuring,
      null
    );
    await call(c.transition.bind(c), {
      ...ctx,
      params: { id: limited.id },
      body: { status: "采样中" },
    });
    await boxes.updateBox(box.id, (b) => {
      b.opens = 8;
    });
    const during = await call(c.taskDetail.bind(c), { ...ctx, params: { id: limited.id } });
    assert.equal(during.task.maxOpens, 1);
    assert.equal(during.boxes[0].opensDuring, 3);
    assert.equal(
      (await call(c.tasks.bind(c), { ...ctx, query: { q: "限开" } })).list[0].openOver,
      1
    );
    await call(c.transition.bind(c), {
      ...ctx,
      params: { id: limited.id },
      body: { status: "已取消" },
    });
    await boxes.updateBox(box.id, (b) => {
      b.opens = 20;
    });
    assert.equal(
      (await call(c.taskDetail.bind(c), { ...ctx, params: { id: limited.id } })).boxes[0]
        .opensDuring,
      3
    );
    const old = await call(c.createTask.bind(c), {
      ...ctx,
      body: {
        name: "旧",
        kind: "调拨",
        boxIds: [box.id],
        fromOrg: "甲",
        toOrg: "乙",
        sender: "a",
        signer: "b",
      },
    });
    const oldDetail = await call(c.taskDetail.bind(c), { ...ctx, params: { id: old.id } });
    assert.equal(oldDetail.target, null);
    assert.equal(oldDetail.can["运送中"], true);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

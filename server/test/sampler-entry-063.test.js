/**
 * R23 现场采样员最小任务入口＋063 存量补码（任务 #66，D5 已拍板）服务端契约：
 * - 063 幂等/存量补码：legacy SAMPLER 角色补 device:box:task＋task:sample-start＋task:seal＋读码隐含卡片码，
 *   _bak_063 留底、ADMIN 短路、grantable=0（SAMPLER 无转授码）、sys_dept_perm 同补防交集裁掉；重跑不变。
 * - SAMPLER 三码后 tasks 读 200 且仅本人保管箱的单（scope4 读可见性走 historicalScopeSql ownerIds）。
 * - sampleStart/seal 参与方门：参与方(manageOrgIds)＋本人保管(ownerIds)＋三码齐备 200；
 *   纯 scope4（manageOrgIds=[]）本人保管箱采样段经 #69 窄放宽也 200（用户拍板「窄放宽本人保管」，
 *   仅采样中/已封箱认 ownerIds；他角色步不放宽，矩阵见 sampler-gate-relax.test.js）；
 *   他人保管箱/无 device:box:task 的角色仍 403。
 *   注：#66 曾以负例锁定 R22 严格门 403（当时门在本批禁改）；#69 获授权放宽采样段，断言随契约翻转并注明理由。
 * - 菜单可见性：menusFor/menuPreviewFor 持 device:box:task 才见任务单（单源自动随）。
 * 一次性临时库，不碰开发/线上库、不占服务端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROLE_PERMS, SAMPLER_ENTRY_063, cardsFor } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { menusFor, menuPreviewFor } from "../menus.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";
import { up as up063 } from "../migrations/063_sampler_task_entry.js";

const permsOf = (code) => new Set(DEFAULT_ROLE_PERMS[code]);
const SAMPLER_CODES = permsOf("SAMPLER");
//  legacy（R23 前）SAMPLER 码集：去掉三码（读码缺失 → 任务单读/写 403）
const LEGACY_SAMPLER = new Set([...SAMPLER_CODES].filter((c) => !SAMPLER_ENTRY_063.includes(c)));

async function setup() {
  applyBoxSettings({
    box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000, stationDeptId: "13" },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "sampler-entry-"));
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
  for (const p of [
    { id: "7", nickname: "林夏", deptId: "2" },
    { id: "6", nickname: "陈可", deptId: "21" },
    { id: "1", nickname: "管理员", deptId: "1" },
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
  const ctx = (id, nickname, deptId, perms, scope) => ({
    user: { id, username: `u${id}`, nickname, dept_id: deptId },
    access: { perms, scope, roles: ["SAMPLER"] },
    ip: "127.0.0.1",
  });
  const all = { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const admin = ctx("1", "管理员", "1", permsOf("ADMIN"), all);
  // 纯 scope4（仅本人）：manageOrgIds=[]、ownerIds=[7]——#69 后采样段认本人保管，他角色步仍严格门
  const samplerSelf = ctx("7", "林夏", "2", SAMPLER_CODES, {
    all: false,
    orgIds: [],
    ownerIds: ["7"],
    manageOrgIds: [],
  });
  // 参与方＋本人：manageOrgIds 含采样单位且 ownerIds 含自己（双门齐备的正例）
  const samplerParty = ctx("7", "林夏", "2", SAMPLER_CODES, {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: ["7"],
    manageOrgIds: ["2", "21"],
  });
  // 参与方但非本人保管（ownerIds 空）：验「本人」门（local sample 走 targets 箱范围）
  const samplerPartyNotOwner = ctx("7", "林夏", "2", SAMPLER_CODES, {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: [],
    manageOrgIds: ["2", "21"],
  });
  // 无读码（legacy SAMPLER）：参与方范围也读/写 403
  const noCode = ctx("7", "林夏", "2", LEGACY_SAMPLER, {
    all: false,
    orgIds: ["2", "21"],
    ownerIds: ["7"],
    manageOrgIds: ["2", "21"],
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
  const makeBox = async (orgId = "21", ownerId = "") => {
    imeiSeq += 1;
    const imei = `8643170809${String(60000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(
      packet({ imei, uart: `why=boot,opens=0,fw=1.0.16,seq=${seq++}` })
    );
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
      if (ownerId) {
        item.ownerId = ownerId;
        item.owner = "林夏";
      }
    });
    return box.id;
  };
  const create = (body) => run(controller.createTask.bind(controller), admin, { body });
  const advance = (id, status, actor = admin, note = "") =>
    run(controller.transition.bind(controller), actor, { params: { id }, body: { status, note } });
  const taskRow = (id) => db.get("SELECT * FROM sample_task WHERE id=?", [id]);
  const localTask = async (ownerId = "7") => {
    const b = await makeBox("21", ownerId);
    const r = await create({
      name: "本地采样单",
      kind: "采样",
      localOnly: true,
      boxIds: [b],
      orgId: "21",
      placeAt: { address: "x", lng: 114.1, lat: 22.6 },
    });
    assert.ok(r.ok, r.message);
    return { id: r.data.id, boxId: b };
  };
  return {
    db,
    controller,
    boxes,
    admin,
    samplerSelf,
    samplerParty,
    samplerPartyNotOwner,
    noCode,
    run,
    makeBox,
    create,
    advance,
    taskRow,
    localTask,
    teardown: async () => {
      await db.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("063：legacy SAMPLER 补三码＋卡片码、_bak_063 留底、grantable=0、ADMIN/他角色不动、部门上限同补；重跑幂等", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sampler-063-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  // 构造 legacy 状态：SAMPLER 角色持 R23 前码集；一个自定义角色；ADMIN；两个受限部门上限
  await db.run(
    "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('15','现场采样员','SAMPLER',4,9,1)"
  );
  await db.run(
    "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('1','系统管理员','ADMIN',1,1,1)"
  );
  await db.run(
    "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('90','自定义','CUSTOM',2,90,1)"
  );
  for (const perm of LEGACY_SAMPLER)
    await db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('15',?,0)", [perm]);
  await db.run(
    "INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('90','device:box:list',0)"
  );
  await db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES ('1','sys:role:view',1)");
  await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('21','device:box:list')");
  await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('13','device:box:detail')");
  // 清掉 migrate 期（空角色）留下的 063 备份，让本次 up 的备份捕获 legacy 现状
  await db.run("DROP TABLE IF EXISTS _bak_063_sampler_entry_sys_role_perm");
  await db.run("DROP TABLE IF EXISTS _bak_063_sampler_entry_sys_dept_perm");

  const snapshot = async () => ({
    role: await db.all("SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"),
    dept: await db.all("SELECT dept_id, perm FROM sys_dept_perm ORDER BY dept_id, perm"),
  });
  await up063(db);
  const after1 = await snapshot();
  // 三码＋读码隐含卡片码都补到 SAMPLER
  const samplerPerms = new Set(after1.role.filter((r) => r.role_id === "15").map((r) => r.perm));
  for (const code of SAMPLER_ENTRY_063) assert.ok(samplerPerms.has(code), `SAMPLER 应补 ${code}`);
  for (const code of cardsFor([...LEGACY_SAMPLER, ...SAMPLER_ENTRY_063]))
    assert.ok(samplerPerms.has(code), `SAMPLER 应补卡片码 ${code}`);
  // grantable=0（SAMPLER 无 sys:role:grant/sys:user:role）
  for (const r of after1.role.filter(
    (r) => r.role_id === "15" && SAMPLER_ENTRY_063.includes(r.perm)
  ))
    assert.equal(Number(r.grantable), 0, "SAMPLER 补码 grantable 应为 0");
  // ADMIN 短路：不新增行；自定义角色不动
  assert.deepEqual(
    after1.role.filter((r) => r.role_id === "1").map((r) => r.perm),
    ["sys:role:view"],
    "ADMIN 不落行"
  );
  assert.deepEqual(
    after1.role.filter((r) => r.role_id === "90").map((r) => r.perm),
    ["device:box:list"],
    "自定义角色不动"
  );
  // 部门上限：含 device:box:list 的 21 同补；不含的 13 不动
  const dept21 = new Set(after1.dept.filter((d) => d.dept_id === "21").map((d) => d.perm));
  for (const code of SAMPLER_ENTRY_063) assert.ok(dept21.has(code), `部门21上限应补 ${code}`);
  assert.deepEqual(
    after1.dept.filter((d) => d.dept_id === "13").map((d) => d.perm),
    ["device:box:detail"],
    "不含基线读码的部门上限不动"
  );
  // 备份留底＝legacy 现状（不含三码）
  const bakRole = await db.all(
    "SELECT perm FROM _bak_063_sampler_entry_sys_role_perm WHERE role_id='15'"
  );
  assert.ok(!bakRole.some((r) => r.perm === "device:box:task"), "备份应为补码前现状");
  const bakDept = await db.all(
    "SELECT perm FROM _bak_063_sampler_entry_sys_dept_perm WHERE dept_id='21'"
  );
  assert.ok(!bakDept.some((r) => r.perm === "device:box:task"), "部门备份应为补码前现状");
  // 重跑幂等：结果完全不变
  await up063(db);
  const after2 = await snapshot();
  assert.deepEqual(after2, after1, "063 重跑结果应不变");
  await db.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("新库 seedRolePerms：SAMPLER 默认含三码（模板单源），且不含 send/sign/create 等越界码", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sampler-seed-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  await db.run(
    "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('15','现场采样员','SAMPLER',4,9,1)"
  );
  await seedRolePerms(db);
  const rows = await db.all("SELECT perm FROM sys_role_perm WHERE role_id='15'");
  const have = new Set(rows.map((r) => r.perm));
  for (const code of SAMPLER_ENTRY_063) assert.ok(have.has(code), `新库 SAMPLER 应含 ${code}`);
  for (const code of [
    "task:send",
    "task:sign",
    "task:inspect",
    "task:cancel",
    "task:create:sample",
    "task:create:transfer",
    "monitor:overview",
  ])
    assert.ok(!have.has(code), `SAMPLER 不应含越界码 ${code}`);
  await db.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("SAMPLER 三码后 tasks 读 200 且仅本人保管箱的单；无读码角色 403", async () => {
  const s = await setup();
  try {
    const mine = await s.localTask("7"); // 本人保管
    const other = await s.localTask(""); // 他人保管（org21 但 owner 空）
    const read = await s.run(s.controller.tasks.bind(s.controller), s.samplerSelf, {
      query: { pageSize: 50 },
    });
    assert.ok(read.ok, read.message);
    assert.equal(read.status ?? 200, 200);
    const ids = read.data.list.map((r) => r.id);
    assert.ok(ids.includes(mine.id), "本人保管箱的单应可见");
    assert.ok(!ids.includes(other.id), "他人保管箱的单不应可见（scope4）");
    // 无读码（legacy）→ 403
    const neg = await s.run(s.controller.tasks.bind(s.controller), s.noCode, { query: {} });
    assert.equal(neg.ok, false);
    assert.equal(neg.status, 403);
  } finally {
    await s.teardown();
  }
});

test("sampleStart/seal 参与方门：参与方+本人 200；纯 scope4 本人保管采样段 #69 窄放宽 200；他人保管/无码 403", async () => {
  const s = await setup();
  try {
    // 正例：参与方(manageOrgIds 含 21)＋本人保管(ownerIds 含 7)＋三码 → 待采样→采样中→已封箱
    const t = await s.localTask("7");
    const d0 = await s.run(s.controller.taskDetail.bind(s.controller), s.samplerParty, {
      params: { id: t.id },
    });
    assert.equal(d0.data.can["采样中"], true, "参与方+本人+三码 应给采样中推进权");
    const a1 = await s.advance(t.id, "采样中", s.samplerParty);
    assert.ok(a1.ok, a1.message);
    assert.equal((await s.taskRow(t.id)).status, "采样中");
    const a2 = await s.advance(t.id, "已封箱", s.samplerParty);
    assert.ok(a2.ok, a2.message);
    assert.equal((await s.taskRow(t.id)).status, "已封箱");
    // #69 窄放宽（用户拍板「窄放宽本人保管」）：纯 scope4（manageOrgIds=[]）本人保管箱，
    // 采样段（采样中/已封箱）参与方门认 box.owner_id∈ownerIds → 200 且状态推进。
    // 理由：#66 §0 根因锁定用例原断言 R22 严格门 403；本批获授权仅放宽采样段，断言随契约翻转。
    // 他角色步（寄出/签收/检测/取消等）不放宽、他人保管箱不放宽，矩阵见 sampler-gate-relax.test.js。
    const t2 = await s.localTask("7");
    const dSelf = await s.run(s.controller.taskDetail.bind(s.controller), s.samplerSelf, {
      params: { id: t2.id },
    });
    assert.equal(dSelf.data.can["采样中"], true, "#69：纯 scope4 本人保管应给采样中推进权");
    const aSelf = await s.advance(t2.id, "采样中", s.samplerSelf);
    assert.ok(aSelf.ok, aSelf.message);
    assert.equal((await s.taskRow(t2.id)).status, "采样中");
    const aSelfSeal = await s.advance(t2.id, "已封箱", s.samplerSelf);
    assert.ok(aSelfSeal.ok, aSelfSeal.message);
    assert.equal(
      (await s.taskRow(t2.id)).status,
      "已封箱",
      "#69：纯 scope4 本人保管可封箱（本地终态）"
    );
    // 他人保管箱（owner 空）：本人分支不命中 → 403 状态不变。
    // 给 org 读可见（orgIds 含 21）以隔离参与方门；纯 scope4（orgIds=[]）他人箱会先 404（fail-closed，矩阵②另证）。
    const t3 = await s.localTask("");
    const otherVisible = {
      ...s.samplerSelf,
      access: {
        ...s.samplerSelf.access,
        scope: { all: false, orgIds: ["21"], ownerIds: ["7"], manageOrgIds: [] },
      },
    };
    const aOther = await s.advance(t3.id, "采样中", otherVisible);
    assert.equal(aOther.ok, false);
    assert.equal(aOther.status, 403);
    assert.equal((await s.taskRow(t3.id)).status, "待采样", "他人保管箱不得借放宽推进");
    // 无读码：写也 403
    const aNo = await s.advance(t2.id, "采样中", s.noCode);
    assert.equal(aNo.ok, false);
    assert.equal(aNo.status, 403);
  } finally {
    await s.teardown();
  }
});

test("菜单可见性：持 device:box:task 才见任务单（menusFor 与 menuPreviewFor 单源同口径）", async () => {
  const withTask = menusFor(SAMPLER_CODES);
  const names = withTask.flatMap((g) => g.children.map((c) => c.name));
  assert.ok(names.includes("SampleTasks"), "补读码后任务单菜单应可见");
  const without = menusFor(LEGACY_SAMPLER);
  const namesWithout = without.flatMap((g) => g.children.map((c) => c.name));
  assert.ok(!namesWithout.includes("SampleTasks"), "无读码任务单菜单不可见");
  const preview = menuPreviewFor(SAMPLER_CODES);
  const taskItem = preview.find((p) => p.title === "任务单");
  assert.ok(taskItem && taskItem.on, "menuPreviewFor 任务单应 on");
  const previewWithout = menuPreviewFor(LEGACY_SAMPLER);
  const taskOff = previewWithout.find((p) => p.title === "任务单");
  assert.ok(taskOff && !taskOff.on, "无读码 menuPreviewFor 任务单应 off");
  // 创建页仍不可见（SAMPLER 无 create:* 码）
  assert.ok(!names.includes("SampleTaskCreate"), "SAMPLER 不应见创建任务单");
});

test("resolveAccess 真实 scope4：SAMPLER manageOrgIds 为空（根因锁定）；#69 后采样段经本人保管可推进", async () => {
  const s = await setup();
  try {
    await s.db.run(
      "INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES ('15','现场采样员','SAMPLER',4,9,1)"
    );
    await seedRolePerms(s.db);
    await s.db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES ('7','15')");
    const user = await s.db.get("SELECT * FROM sys_user WHERE id='7'");
    const access = await resolveAccess(s.db, user);
    assert.deepEqual(access.scope.ownerIds, ["7"]);
    assert.deepEqual(
      access.scope.manageOrgIds,
      [],
      "scope4 管理范围为空＝R22 严格参与方门挡纯本人采样员的根因（resolveScope 不改，#69 仅在采样段认 ownerIds）"
    );
    assert.ok(access.perms.has("device:box:task"));
    assert.ok(access.perms.has("task:sample-start"));
    assert.ok(access.perms.has("task:seal"));
    // #69 端到端：用真实 resolveAccess（非手工 scope）建本地本人保管单，采样段全链 200——
    // 证明窄放宽在真实 scope4 形状上生效，manageOrgIds=[] 不再阻采样段。
    const t = await s.localTask("7");
    const realCtx = {
      user: { id: "7", username: "u7", nickname: "林夏", dept_id: "2" },
      access: { perms: access.perms, scope: access.scope, roles: access.roles },
      ip: "127.0.0.1",
    };
    const a1 = await s.advance(t.id, "采样中", realCtx);
    assert.ok(a1.ok, a1.message);
    const a2 = await s.advance(t.id, "已封箱", realCtx);
    assert.ok(a2.ok, a2.message);
    assert.equal((await s.taskRow(t.id)).status, "已封箱");
  } finally {
    await s.teardown();
  }
});

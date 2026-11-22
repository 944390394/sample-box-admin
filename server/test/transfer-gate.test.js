/**
 * R12 调拨门禁（R24 #70 收紧）：调拨单页面只有有「新建划拨」权限的人才能看到。
 * gate = task:create:transfer 单码（撤销码随撤销功能下线退出门禁），三层单源同口径：
 * 1) 服务端 transfers/transferDetail handler 开头 require（无建单码 403 A0301，先于可见性 404）；
 * 2) 前端 local-menus 注入（无建单码不注入调拨单组 → 侧栏无、直链落 404）；
 * 3) menus.js menuPreviewFor 镜像（无建单码列出但 off，预览可见项=真实侧栏）。
 * 角色码集按实际模板 DEFAULT_ROLE_PERMS（R24 实测：ADMIN/DISPATCH/BRANCH_ADMIN=有 create 无 revoke；
 * DUTY/VERIFY/LEADER/ASSET=无建单码但有 device:box:task（旧 gate 会放行，R12 收紧）；SAMPLER=无且无 box:task）。
 * createTransfer 保留单码校验；revokeTransfer 方法本体保留（路由已封 410，见 transfer-revoke-retire.test.js），
 * 直调仍按 revoke 单码校验——存量库 inert 授权行（053/057）只在这里还有语义。
 * R24 起 createTransfer 需 body.password 二次确认：夹具用户落真实 scrypt hash（hashPassword），
 * 提交带夹具口令；口令只是测试夹具值，不是任何真实账号凭据。
 * 一次性临时库（mkdtemp，同 transfer-allocation.test.js 写法），不碰开发库/线上库，不占任何服务端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { hashPassword } from "../auth.js";
import { DEFAULT_ROLE_PERMS } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { applyBoxSettings, transferInspectEnabled } from "../src/settings/boxConfig.js";
import { menuRoutes, menusFor, menuPreviewFor } from "../menus.js";
import { packet } from "./fixture.js";

// 前端 local-menus.ts 直导（node type-stripping，同 position-stale.test.js 先例）：
// 它从 "@/router" 取 Layout 组件，node 不认 vite 别名 → 解析到 data: 桩模块（只测菜单结构，不渲染）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/router") {
      return { url: "data:text/javascript,export const Layout = () => {};", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { buildLocalMenus, mergeLocalMenus, TRANSFER_VIEW_PERMS } =
  await import("../../src/router/local-menus.ts");

const CREATE = "task:create:transfer";
const REVOKE = "task:transfer:revoke";
const BOX_TASK = "device:box:task";
/** R24 二次确认夹具口令（仅测试用，非真实凭据）：所有夹具用户共用一个 hash。 */
const CONFIRM_PW = "Gate-Fixture-2026";
const CONFIRM_HASH = hashPassword(CONFIRM_PW);

/** 无建单码的实际模板（DUTY/VERIFY/LEADER/ASSET 有 box:task，SAMPLER 没有）。 */
const NO_TRANSFER_ROLES = ["DUTY", "VERIFY", "LEADER", "ASSET", "SAMPLER"];

async function setup() {
  // 旧 off 配置：常开后写入被忽略、读取恒 true——门禁与开关无关（R11 常开 × R12 权限门）。
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      batteryReserve: 20,
      arriveRadiusM: 2000,
      enableTransferInspect: false,
      stationDeptId: "4",
    },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-gate-"));
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
  ])
    await db.run(
      "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
      [id, parent, name, `C${id}`, type]
    );
  const people = {
    a: { id: "101", nickname: "陈默", deptId: "2" },
    b: { id: "201", nickname: "广州员工", deptId: "3" },
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
  /** 按码集造 ctx：scope 全范围（门禁先于范围判定，范围不是本测试变量）。 */
  const ctx = (codes, person = people.a) => ({
    user: {
      id: person.id,
      username: `u${person.id}`,
      nickname: person.nickname,
      dept_id: person.deptId,
    },
    access: { perms: new Set(codes), scope: { all: true, orgIds: [], ownerIds: [] }, roles: [] },
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
  const makeBox = async (orgId) => {
    imeiSeq += 1;
    const imei = `8643170809${String(20000 + imeiSeq).padStart(5, "0")}`;
    const { box } = await ingest.accept(packet({ imei, uart: "why=boot,opens=0,seq=1" }));
    await boxes.updateBox(box.id, (item) => {
      item.life = "未使用";
      item.orgId = orgId;
      item.org = orgId === "2" ? "深圳分公司" : "广州分公司";
      item.ownerId = "";
      item.owner = "";
    });
    return box.id;
  };
  const list = (actor) => run(controller.transfers.bind(controller), actor);
  const detail = (actor, id) =>
    run(controller.transferDetail.bind(controller), actor, { params: { id } });
  const teardown = async () => {
    applyBoxSettings({});
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, controller, ctx, run, makeBox, list, detail, people, teardown };
}

/** admin 建一张划拨单（2→3），返回单 id。R24：提交带二次确认口令。 */
async function seedTransfer(s) {
  const boxId = await s.makeBox("2");
  const res = await s.run(
    s.controller.createTransfer.bind(s.controller),
    s.ctx(DEFAULT_ROLE_PERMS.ADMIN),
    { body: { name: "门禁夹具划拨", toOrgId: "3", boxIds: [boxId], password: CONFIRM_PW } }
  );
  assert.ok(res.ok, `${res.code} ${res.message}`);
  return res.data.id;
}

/** 预览镜像里调拨单两项的 on/off。 */
function previewTransfer(codes) {
  const perms = new Set(codes);
  const items = menuPreviewFor(perms).filter((m) => m.title.startsWith("调拨单"));
  assert.equal(items.length, 2, "常开：预览恒列出调拨单组两项（列表＋隐藏详情）");
  return items;
}

/** 真实侧栏（menusFor 裁剪 + local-menus 注入 + merge）里的可见一级标题。 */
function sidebarTitles(codes) {
  const perms = new Set(codes);
  const merged = mergeLocalMenus(menusFor(perms), buildLocalMenus({ perms: codes }));
  return merged.filter((g) => g.children?.some((c) => !c.meta?.hidden)).map((g) => g.meta.title);
}

test("R12 无两码角色（实际模板 DUTY/VERIFY/LEADER/ASSET/SAMPLER）：transfers/transferDetail 403 A0301，菜单/预览/本地注入全不含调拨单", async () => {
  const s = await setup();
  try {
    const id = await seedTransfer(s);
    assert.equal(transferInspectEnabled(), true, "常开：off 配置不改守卫");
    for (const role of NO_TRANSFER_ROLES) {
      const codes = DEFAULT_ROLE_PERMS[role];
      assert.ok(!codes.includes(CREATE) && !codes.includes(REVOKE), `${role} 模板应无两码`);
      const actor = s.ctx(codes);
      // 服务端：列表与详情都 403 A0301（门禁先于可见性——详情不是 404）
      const l = await s.list(actor);
      assert.equal(l.ok, false, `${role} 列表应被拒`);
      assert.equal(l.code, "A0301", `${role} 列表码`);
      assert.equal(l.status, 403, `${role} 列表状态`);
      const d = await s.detail(actor, id);
      assert.equal(d.ok, false, `${role} 详情应被拒`);
      assert.equal(d.code, "A0301", `${role} 详情码`);
      assert.equal(d.status, 403, `${role} 详情状态`);
      // 服务端菜单裁剪结果本就不含调拨单组（前端注入）；预览镜像列出但全 off
      assert.ok(!menusFor(new Set(codes)).some((g) => g.path === "/transfer"));
      for (const item of previewTransfer(codes))
        assert.equal(item.on, false, `${role} 预览 ${item.title}`);
      // 前端注入：无调拨单组；侧栏标题不含调拨单；送检旧链接重定向恒在
      const local = buildLocalMenus({ perms: codes });
      assert.ok(!local.some((g) => g.name === "SampleTransferGroup"), `${role} 不应注入调拨单组`);
      assert.ok(local.some((g) => g.name === "SampleInspectionsRedirect"));
      assert.ok(!sidebarTitles(codes).includes("调拨单"), `${role} 侧栏不应含调拨单`);
    }
    // 有 box:task 但无两码（DUTY 等）旧 gate 会放行——钉死收紧不是巧合
    assert.ok(DEFAULT_ROLE_PERMS.DUTY.includes(BOX_TASK));
    const duty = await s.list(s.ctx(DEFAULT_ROLE_PERMS.DUTY));
    assert.equal(duty.code, "A0301");
  } finally {
    await s.teardown();
  }
});

test("R12 LEADER 只读无两码 → 不可见：403＋侧栏/预览/注入全排除（用户意图：仅划拨权限者可见）", async () => {
  const s = await setup();
  try {
    const id = await seedTransfer(s);
    const codes = DEFAULT_ROLE_PERMS.LEADER;
    const actor = s.ctx(codes);
    assert.equal((await s.list(actor)).code, "A0301");
    assert.equal((await s.detail(actor, id)).code, "A0301");
    assert.ok(!sidebarTitles(codes).includes("调拨单"));
    for (const item of previewTransfer(codes)) assert.equal(item.on, false);
    // 只读领导的其他菜单不受影响（任务单/采样箱仍在）
    const titles = sidebarTitles(codes);
    assert.ok(titles.includes("任务单"));
    assert.ok(titles.includes("采样箱"));
  } finally {
    await s.teardown();
  }
});

test("R12/R24 有建单码角色可见可列：ADMIN/BRANCH_ADMIN/DISPATCH —— 200＋预览 on＋注入调拨单组（meta.perm 同口径）；abilities 不再含 revoke", async () => {
  const s = await setup();
  try {
    const id = await seedTransfer(s);
    const cases = [
      { name: "ADMIN", codes: DEFAULT_ROLE_PERMS.ADMIN },
      { name: "DISPATCH", codes: DEFAULT_ROLE_PERMS.DISPATCH },
      { name: "BRANCH_ADMIN", codes: DEFAULT_ROLE_PERMS.BRANCH_ADMIN },
    ];
    for (const c of cases) {
      assert.ok(c.codes.includes(CREATE), `${c.name} 应含建单码`);
      const actor = s.ctx(c.codes);
      const l = await s.list(actor);
      assert.ok(l.ok, `${c.name} 列表 ${l.code} ${l.message}`);
      assert.equal(l.data.total, 1);
      assert.equal(l.data.list[0].id, id);
      assert.equal(l.data.counts.全部, 1);
      const d = await s.detail(actor, id);
      assert.ok(d.ok, `${c.name} 详情 ${d.code} ${d.message}`);
      assert.equal(d.data.id, id);
      // R24（#70）撤销下线：详情不再下发 revoke 旗标（入口已删，cancel 历史占位保留）
      assert.deepEqual(d.data.abilities, { cancel: false }, `${c.name} abilities 无 revoke`);
      // 预览 on；本地注入调拨单组（插在任务单后），meta.perm 与 gate 同口径
      for (const item of previewTransfer(c.codes)) assert.equal(item.on, true, `${c.name} 预览`);
      const local = buildLocalMenus({ perms: c.codes });
      const group = local.find((g) => g.name === "SampleTransferGroup");
      assert.ok(group, `${c.name} 应注入调拨单组`);
      assert.deepEqual(group.meta.perm, TRANSFER_VIEW_PERMS);
      for (const child of group.children) assert.deepEqual(child.meta.perm, TRANSFER_VIEW_PERMS);
      const titles = sidebarTitles(c.codes);
      assert.ok(titles.includes("调拨单"), `${c.name} 侧栏应含调拨单`);
      assert.ok(titles.indexOf("调拨单") === titles.indexOf("任务单") + 1, "调拨单紧跟任务单");
    }
    // R24 裁决后：DISPATCH/BRANCH_ADMIN 模板含 create、不再含 revoke（存量库 057 补的行留库 inert）
    for (const code of ["DISPATCH", "BRANCH_ADMIN"]) {
      assert.ok(DEFAULT_ROLE_PERMS[code].includes(CREATE), code + " 应含 create");
      assert.ok(!DEFAULT_ROLE_PERMS[code].includes(REVOKE), code + " 不应再含 revoke");
    }
    // R24（#70）：仅存量撤销码（无建单码）不再可见——列表/详情 403、预览 off、不注入
    const revokeOnly = s.ctx([BOX_TASK, REVOKE]);
    const rl = await s.list(revokeOnly);
    assert.equal(rl.code, "A0301");
    assert.equal(rl.status, 403);
    assert.equal((await s.detail(revokeOnly, id)).code, "A0301");
    for (const item of previewTransfer([BOX_TASK, REVOKE])) assert.equal(item.on, false);
    assert.ok(!sidebarTitles([BOX_TASK, REVOKE]).includes("调拨单"));
  } finally {
    await s.teardown();
  }
});

test("R12/R24 createTransfer 单码校验＋revokeTransfer 领域直调保留单码：仅 revoke 不能建也不能看、仅 create 不能撤（A0301），存量两码直调可撤", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const createOnly = s.ctx([BOX_TASK, CREATE]);
    const revokeOnly = s.ctx([BOX_TASK, REVOKE]);
    // R24：仅 revoke 列表/详情也被拒（门禁单码化）；建单仍被单码门禁拒
    assert.equal((await s.list(revokeOnly)).code, "A0301");
    const denied = await s.run(s.controller.createTransfer.bind(s.controller), revokeOnly, {
      body: { name: "越权建单", toOrgId: "3", boxIds: [boxId], password: CONFIRM_PW },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "A0301");
    // 仅 create（DISPATCH 同码集）：建单成功（带二次确认口令），撤销被单码门禁拒
    const created = await s.run(s.controller.createTransfer.bind(s.controller), createOnly, {
      body: { name: "调度建单", toOrgId: "3", boxIds: [boxId], password: CONFIRM_PW },
    });
    assert.ok(created.ok, `${created.code} ${created.message}`);
    const revokeDenied = await s.run(s.controller.revokeTransfer.bind(s.controller), createOnly, {
      params: { id: created.data.id },
      body: { reason: "越权撤销" },
    });
    assert.equal(revokeDenied.ok, false);
    assert.equal(revokeDenied.code, "A0301");
    // R24：ADMIN 模板已不含 revoke（ALL_PERMS 派生）。存量库 inert 授权行语义用显式两码模拟：
    // 路由已封 410，这里直调领域方法验证守卫与归属退回仍完整（恢复撤销=接回路由即可用）。
    const legacyBoth = s.ctx([BOX_TASK, CREATE, REVOKE]);
    const revoked = await s.run(s.controller.revokeTransfer.bind(s.controller), legacyBoth, {
      params: { id: created.data.id },
      body: { reason: "划错了" },
    });
    assert.ok(revoked.ok, `${revoked.code} ${revoked.message}`);
    assert.equal(revoked.data.restoredCount, 1);
  } finally {
    await s.teardown();
  }
});

test("R12/R24 local-menus 注入 gate 纯函数：仅建单码（撤销码单独不注入）与开关无关；box:task-only/空码不注入；重定向恒在", async () => {
  // 常开：gate 不再接收 enabled——旧开关字段不存在于接口，perms 唯一变量
  for (const perms of [[CREATE], [CREATE, REVOKE], [BOX_TASK, CREATE]]) {
    const local = buildLocalMenus({ perms });
    assert.ok(
      local.some((g) => g.name === "SampleTransferGroup"),
      perms.join(",")
    );
  }
  // R24：仅撤销码不再注入（撤销下线，码退出门禁）
  for (const perms of [
    [],
    [BOX_TASK],
    [REVOKE],
    ["device:box:list", BOX_TASK],
    ["task:create:sample"],
  ]) {
    const local = buildLocalMenus({ perms });
    assert.ok(!local.some((g) => g.name === "SampleTransferGroup"), perms.join(","));
    assert.ok(
      local.some((g) => g.name === "SampleInspectionsRedirect"),
      "送检重定向恒在"
    );
  }
  // 服务端 menuRoutes 不含调拨单组（注入只在前端）；预览镜像与注入口径一致（同码集合同结论）
  assert.ok(!menuRoutes.some((g) => g.path === "/transfer"));
  for (const codes of [DEFAULT_ROLE_PERMS.DUTY, DEFAULT_ROLE_PERMS.DISPATCH, [REVOKE]]) {
    const injected = buildLocalMenus({ perms: codes }).some(
      (g) => g.name === "SampleTransferGroup"
    );
    const previewOn = previewTransfer(codes).every((m) => m.on);
    assert.equal(injected, previewOn, codes.join(","));
  }
});

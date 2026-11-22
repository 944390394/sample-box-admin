/**
 * R24（#70）划拨撤销下线＋重新划拨＋二次确认密码 的退役契约。
 *
 * 与 transfer-gate.test.js（门禁三层镜像）、transfer-allocation.test.js（领域层四守卫/归属退回，
 * 47 处用例保留不动）分工：本文件只钉「下线后的新契约」——
 * 1. revoke 路由真实进程 410＋友好文案（spawn 临时 SAMPLE_HOME，PORT/SAMPLE_TCP_PORT 双临时口，
 *    绝不落 8000/9000 保护口；主夹具 8010/9010 不碰）；
 * 2. abilities 不再含 revoke；码表（ALL_PERMS/角色模板）不含 revoke；存量码 upgradeCodes 原样放行（inert）；
 * 3. 页门 create-only：TRANSFER_VIEW_PERMS/注入/预览/handler 四处同口径，仅撤销码 403＋off＋不注入；
 * 4. createTransfer 密码：缺 400、错 403、对 200 且归属转移；校验先于 clientToken 幂等命中
 *    （重复提交缺/错口令仍被拒，不被幂等绕过）；
 * 5. 审计：成功 detail 只 {二次确认:true}；失败显式 result:"失败"；任何日志列不落口令明文；
 *    错口令不累计 sys_user.failed_count（不复用改密锁定计数）；
 * 6. 重新划拨预填候选合法：原单箱集对同目标 ALREADY_TARGET、对原公司可选可提交（重放不绕守卫）；
 *    历史已撤销单 revokedAt/revokeReason/页签计数保留。
 * 夹具口令均为测试值（非真实凭据）；一次性临时库（mkdtemp），不碰开发库/线上库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { hashPassword } from "../auth.js";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { seedRolePerms } from "../src/auth/boxAccess.js";
import { ALL_PERMS, DEFAULT_ROLE_PERMS, upgradeCodes } from "../src/auth/permCatalog.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { menuPreviewFor } from "../menus.js";
import { packet } from "./fixture.js";

// 前端 local-menus.ts 直导（node type-stripping，同 transfer-gate.test.js 先例）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/router") {
      return { url: "data:text/javascript,export const Layout = () => {};", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { buildLocalMenus, TRANSFER_VIEW_PERMS } = await import("../../src/router/local-menus.ts");

const CREATE = "task:create:transfer";
const REVOKE = "task:transfer:revoke";
const BOX_TASK = "device:box:task";
/** 夹具口令（仅测试用，非真实凭据）。 */
const CONFIRM_PW = "Retire-Fixture-2026";
const WRONG_PW = "Retire-Wrong-2026";
const CONFIRM_HASH = hashPassword(CONFIRM_PW);

async function setup() {
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      batteryReserve: 20,
      arriveRadiusM: 2000,
      enableTransferInspect: false,
      stationDeptId: "4",
    },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "transfer-retire-"));
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
    const imei = `8643170809${String(30000 + imeiSeq).padStart(5, "0")}`;
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
  const create = (actor, body) => run(controller.createTransfer.bind(controller), actor, { body });
  const teardown = async () => {
    applyBoxSettings({});
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, boxes, controller, ctx, run, makeBox, create, people, teardown };
}

/** 取一个空闲回环端口（listen 0 由系统分配，绝不落保护口）。 */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

test("R24 revoke 路由真实进程 410＋友好文案（临时 SAMPLE_HOME＋双临时口；未登录仍 401）", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "transfer-retire-route-"));
  const sqlitePath = path.join(home, "db");
  const config = { dialect: "sqlite", sqlitePath, secret: "retire-route-test-secret" };
  await writeFile(path.join(home, "db.config.json"), JSON.stringify(config), "utf8");
  await writeFile(path.join(home, "install.lock"), new Date().toISOString(), "utf8");
  const db = await openDatabase(config, process.cwd());
  await migrate(db);
  await seedOrg(db);
  await seedRolePerms(db);
  // 种子 admin 默认公开口令＋首登强制改密：这里解除改密门以便登录拿 token（夹具内操作）。
  await db.run(
    "UPDATE sys_user SET must_change_password=0, password_changed_at=? WHERE username='admin'",
    [formatTimestamp(new Date())]
  );
  await db.close?.();
  const apiPort = await freePort();
  const tcpPort = await freePort();
  const serverEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SAMPLE_HOME: home,
      SAMPLE_ACCEPTANCE: "1",
      PORT: String(apiPort),
      SAMPLE_TCP_PORT: String(tcpPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  child.stdout.on("data", (chunk) => (bootLog += String(chunk)));
  child.stderr.on("data", (chunk) => (bootLog += String(chunk)));
  const base = `http://127.0.0.1:${apiPort}`;
  try {
    // 等启动完成（listen 回调打印「采样箱服务」）；30s 上限，进程早退直接失败并带日志。
    const deadline = Date.now() + 30000;
    while (!/采样箱服务/.test(bootLog)) {
      if (child.exitCode != null) throw new Error(`服务进程早退：${bootLog.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`服务启动超时：${bootLog.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 未登录：auth 链先拦（401），证明 410 不是绕过鉴权的裸路由
    const anon = await fetch(`${base}/api/v1/sample/transfers/AL-0-000000/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "验收" }),
    });
    assert.equal(anon.status, 401);
    // 登录（SAMPLE_ACCEPTANCE=1 免验证码；admin 种子默认公开口令，仅夹具内使用）
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "123456" }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    const token = loginBody.data?.accessToken;
    assert.ok(token, "登录应回 accessToken");
    // 已登录 admin（R24 模板已不含 revoke 码）：路由直接 410＋可执行下一步文案，先于任何权限/守卫判定
    const res = await fetch(`${base}/api/v1/sample/transfers/AL-0-000000/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: "验收" }),
    });
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.code, "A0409");
    assert.match(body.msg, /撤销已下线/);
    assert.match(body.msg, /重新划拨/);
  } finally {
    if (child.exitCode == null) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
      else child.kill("SIGKILL");
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("R24 码表/模板不含 revoke＋abilities 无 revoke＋页门 create-only（仅撤销码 403/off/不注入）", async () => {
  const s = await setup();
  try {
    // 码表：item 与模板持有都移除；存量码经 upgradeCodes 原样放行（inert，领域直调仍认）
    assert.ok(!ALL_PERMS.some((p) => p.code === REVOKE), "ALL_PERMS 不应含 revoke");
    for (const role of ["ADMIN", "DISPATCH", "BRANCH_ADMIN"]) {
      assert.ok(!DEFAULT_ROLE_PERMS[role].includes(REVOKE), `${role} 模板不应含 revoke`);
      assert.ok(DEFAULT_ROLE_PERMS[role].includes(CREATE), `${role} 模板应含 create`);
    }
    assert.ok(upgradeCodes([REVOKE]).includes(REVOKE), "存量授权行 inert 保留");
    // 前端注入口径：单码；仅撤销码不注入；预览镜像 off
    assert.deepEqual(TRANSFER_VIEW_PERMS, [CREATE]);
    assert.ok(
      !buildLocalMenus({ perms: [BOX_TASK, REVOKE] }).some((g) => g.name === "SampleTransferGroup")
    );
    const preview = menuPreviewFor(new Set([BOX_TASK, REVOKE])).filter((m) =>
      m.title.startsWith("调拨单")
    );
    assert.equal(preview.length, 2);
    for (const item of preview) assert.equal(item.on, false);
    // handler：仅撤销码 列表/详情 403 A0301
    const boxId = await s.makeBox("2");
    const actor = s.ctx([CREATE]);
    const created = await s.create(actor, {
      name: "退役契约",
      toOrgId: "3",
      boxIds: [boxId],
      password: CONFIRM_PW,
    });
    assert.ok(created.ok, `${created.code} ${created.message}`);
    // abilities：创建响应与详情都不再含 revoke（cancel 历史占位保留）；逐台 revocable 仍由领域层下发
    assert.deepEqual(created.data.abilities, { cancel: false });
    const detail = await s.run(s.controller.transferDetail.bind(s.controller), actor, {
      params: { id: created.data.id },
    });
    assert.ok(detail.ok, detail.message);
    assert.deepEqual(detail.data.abilities, { cancel: false });
    assert.equal(typeof detail.data.boxes[0].revocable, "boolean");
    const revokeOnly = s.ctx([BOX_TASK, REVOKE]);
    const l = await s.run(s.controller.transfers.bind(s.controller), revokeOnly);
    assert.equal(l.code, "A0301");
    assert.equal(l.status, 403);
    const d = await s.run(s.controller.transferDetail.bind(s.controller), revokeOnly, {
      params: { id: created.data.id },
    });
    assert.equal(d.code, "A0301");
    assert.equal(d.status, 403);
  } finally {
    await s.teardown();
  }
});

test("R24 密码三态：缺 400／错 403（不累计改密锁定）／对 200 且归属转移；格式校验先于口令", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const actor = s.ctx([CREATE]);
    const base = { name: "二次确认", toOrgId: "3", boxIds: [boxId] };
    // 缺口令：400 A0400，不落单、不转归属、不占幂等 token
    const missing = await s.create(actor, { ...base, clientToken: "tok-miss" });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "A0400");
    assert.equal(missing.status, 400);
    assert.match(missing.message, /请输入登录密码/);
    // 空串/非字符串/超长：同属格式错 400
    for (const bad of ["", 12345, "x".repeat(1025)]) {
      const r = await s.create(actor, { ...base, password: bad });
      assert.equal(r.status, 400, `password=${typeof bad} 应 400`);
    }
    // 错口令：403 A0301，不泄露口令信息；不累计 sys_user.failed_count（改密锁定不被牵连）
    const wrong = await s.create(actor, { ...base, password: WRONG_PW, clientToken: "tok-miss" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, "A0301");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.message, "密码不正确");
    const userRow = await s.db.get(
      "SELECT failed_count, locked_until FROM sys_user WHERE id='101'"
    );
    assert.equal(Number(userRow.failed_count || 0), 0, "错口令不累计改密锁定计数");
    assert.ok(!userRow.locked_until);
    // 拒绝不留痕：无单、无快照、归属原样、幂等行不写（同一 token 之后仍可用）
    assert.equal(
      Number((await s.db.get("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'")).n),
      0
    );
    assert.equal((await s.boxes.findById(boxId)).orgId, "2");
    assert.equal(Number((await s.db.get("SELECT COUNT(*) AS n FROM transfer_request")).n), 0);
    // 对口令：200，归属即时转移、保管人清空
    const ok = await s.create(actor, { ...base, password: CONFIRM_PW, clientToken: "tok-miss" });
    assert.ok(ok.ok, `${ok.code} ${ok.message}`);
    assert.equal(ok.data.status, "已划拨");
    const row = await s.boxes.findById(boxId);
    assert.equal(row.orgId, "3");
    assert.equal(row.ownerId, "");
  } finally {
    await s.teardown();
  }
});

test("R24 审计口径：成功 detail 只 {二次确认:true}；失败显式 result=失败；任何日志列不落口令明文", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const actor = s.ctx([CREATE]);
    const base = { name: "审计口径", toOrgId: "3", boxIds: [boxId] };
    await s.create(actor, { ...base, password: WRONG_PW });
    const ok = await s.create(actor, { ...base, password: CONFIRM_PW });
    assert.ok(ok.ok, `${ok.code} ${ok.message}`);
    const logs = await s.db.all(
      "SELECT action, target_id, result, detail FROM sys_operation_log WHERE action LIKE '提交划拨%' ORDER BY created_at"
    );
    assert.equal(logs.length, 2, "一失败一成功各留一条");
    const failed = logs.find((l) => l.result === "失败");
    assert.ok(failed, "失败必须显式 result=失败（operationLog 只认这个值）");
    const failedDetail = JSON.parse(failed.detail);
    assert.equal(failedDetail.二次确认, false);
    assert.equal(typeof failedDetail.原因, "string");
    const succeeded = logs.find((l) => l.result === "成功");
    assert.ok(succeeded);
    assert.equal(succeeded.target_id, ok.data.id);
    assert.deepEqual(JSON.parse(succeeded.detail), { 二次确认: true });
    // 口令明文不入任何日志列：操作日志全表 + 单据日志 detail 都 grep 不到
    const allOp = await s.db.all("SELECT detail FROM sys_operation_log");
    for (const row of allOp) {
      assert.ok(!String(row.detail || "").includes(CONFIRM_PW), "操作日志不得含正确口令");
      assert.ok(!String(row.detail || "").includes(WRONG_PW), "操作日志不得含错误口令");
    }
    const taskLogs = await s.db.all("SELECT detail, note FROM sample_task_log");
    for (const row of taskLogs) {
      assert.ok(!String(row.detail || "").includes(CONFIRM_PW));
      assert.ok(!String(row.note || "").includes(CONFIRM_PW));
    }
  } finally {
    await s.teardown();
  }
});

test("R24 幂等重复提交仍要密码：同 clientToken 缺 400／错 403／对 200 返回原单（校验先于幂等命中）", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const actor = s.ctx([CREATE]);
    const base = { name: "幂等再认证", toOrgId: "3", boxIds: [boxId], clientToken: "tok-re" };
    const first = await s.create(actor, { ...base, password: CONFIRM_PW });
    assert.ok(first.ok, `${first.code} ${first.message}`);
    assert.equal(first.data.idempotent, false);
    // 重复提交缺口令：不被幂等命中绕过，仍 400
    const miss = await s.create(actor, { ...base });
    assert.equal(miss.status, 400);
    // 重复提交错口令：仍 403
    const wrong = await s.create(actor, { ...base, password: WRONG_PW });
    assert.equal(wrong.status, 403);
    // 重复提交对口令：幂等返回原单，不重复转移、不重复建单
    const again = await s.create(actor, { ...base, password: CONFIRM_PW });
    assert.ok(again.ok, `${again.code} ${again.message}`);
    assert.equal(again.data.id, first.data.id);
    assert.equal(again.data.idempotent, true);
    assert.equal(
      Number((await s.db.get("SELECT COUNT(*) AS n FROM sample_task WHERE kind='划拨'")).n),
      1
    );
    assert.equal(Number((await s.db.get("SELECT COUNT(*) AS n FROM transfer_request")).n), 1);
    // 幂等成功审计同样带 {二次确认:true}，action 标注重复提交
    const idemLog = await s.db.get(
      "SELECT action, detail FROM sys_operation_log WHERE action LIKE '提交划拨（重复提交%' ORDER BY created_at DESC"
    );
    assert.ok(idemLog, "幂等命中也要留二次确认审计");
    assert.deepEqual(JSON.parse(idemLog.detail), { 二次确认: true });
  } finally {
    await s.teardown();
  }
});

test("R24 重新划拨预填候选合法：原单箱集对同目标 ALREADY_TARGET、对原公司可选可提交；历史已撤销单字段保留", async () => {
  const s = await setup();
  try {
    const boxId = await s.makeBox("2");
    const actor = s.ctx([CREATE]);
    const first = await s.create(actor, {
      name: "预填源单",
      toOrgId: "3",
      boxIds: [boxId],
      password: CONFIRM_PW,
    });
    assert.ok(first.ok, `${first.code} ${first.message}`);
    // 列表「重新划拨」取详情逐台快照作预填箱集
    const detail = await s.run(s.controller.transferDetail.bind(s.controller), actor, {
      params: { id: first.data.id },
    });
    const prefillIds = detail.data.boxes.map((b) => b.boxId);
    assert.deepEqual(prefillIds, [boxId]);
    // 预填候选合法性：同目标重放被 ALREADY_TARGET 拦（守卫不绕）；改投原公司可选
    const same = await s.run(s.controller.transferCandidates.bind(s.controller), actor, {
      query: { toOrgId: "3" },
    });
    assert.equal(same.data.list.find((b) => b.boxId === boxId).reasonCode, "ALREADY_TARGET");
    assert.equal(same.data.list.find((b) => b.boxId === boxId).selectable, false);
    const back = await s.run(s.controller.transferCandidates.bind(s.controller), actor, {
      query: { toOrgId: "2" },
    });
    assert.equal(back.data.list.find((b) => b.boxId === boxId).selectable, true);
    // 重新划拨提交（预填箱集＋新目标＋二次确认）：归属转回原公司
    const replay = await s.create(actor, {
      name: "预填源单",
      toOrgId: "2",
      boxIds: prefillIds,
      password: CONFIRM_PW,
    });
    assert.ok(replay.ok, `${replay.code} ${replay.message}`);
    assert.equal((await s.boxes.findById(boxId)).orgId, "2");
    // 历史已撤销单：领域直调撤销（存量 inert 码）后，列表/详情保留 revokedAt/revokeReason 与页签计数
    const legacy = s.ctx([CREATE, REVOKE]);
    const revoked = await s.run(s.controller.revokeTransfer.bind(s.controller), legacy, {
      params: { id: replay.data.id },
      body: { reason: "历史撤销" },
    });
    assert.ok(revoked.ok, `${revoked.code} ${revoked.message}`);
    const after = await s.run(s.controller.transfers.bind(s.controller), actor, {
      query: { status: "已撤销" },
    });
    assert.equal(after.data.total, 1);
    assert.equal(after.data.counts.已撤销, 1);
    assert.ok(after.data.list[0].revokedAt);
    assert.equal(after.data.list[0].revokeReason, "历史撤销");
    const histDetail = await s.run(s.controller.transferDetail.bind(s.controller), actor, {
      params: { id: replay.data.id },
    });
    assert.equal(histDetail.data.status, "已撤销");
    assert.ok(histDetail.data.revokedAt);
    assert.equal(histDetail.data.revokeReason, "历史撤销");
    assert.deepEqual(histDetail.data.abilities, { cancel: false });
  } finally {
    await s.teardown();
  }
});

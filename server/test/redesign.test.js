import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrate, openDatabase, seedOrg } from "../db.js";
import { menusFor } from "../menus.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { DEFAULT_ROLE_PERMS, upgradeRolePerms, upgradeCodes } from "../src/auth/permCatalog.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { SampleController } from "../src/http/SampleController.js";
import { VideoPlatform } from "../src/integration/VideoPlatform.js";
import { IngestService } from "../src/service/IngestService.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import {
  mergeSmtpSettings,
  mergeVideoSettings,
  publicSmtp,
  readVideo,
} from "../src/settings/integrationConfig.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import {
  checkPassword,
  lockedMinutes,
  mergeSecuritySettings,
  passwordChangeReason,
  publicSecurity,
} from "../src/settings/securityConfig.js";
import { TaskVideoService } from "../src/settings/TaskVideoService.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

async function call(fn, ctx) {
  let out;
  await fn({
    ...ctx,
    ok: (data) => (out = data),
    fail: (message, code, status) => (out = { error: message, code, status }),
  });
  return out;
}

async function fresh(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  return {
    db,
    dir,
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("密码策略：长度和字符类别、须改密原因、锁定剩余时间", () => {
  const policy = publicSecurity({});
  assert.equal(policy.minLength, 8);
  assert.match(checkPassword("short1", policy), /至少 8 位/);
  assert.match(checkPassword("onlyletters", policy), /数字/);
  assert.equal(checkPassword("letters123", policy), null);
  const strict = publicSecurity(
    mergeSecuritySettings(
      {},
      {
        minLength: 10,
        classes: ["letter", "digit", "symbol"],
        expireDays: 90,
        lockThreshold: 3,
        lockMinutes: 30,
      }
    )
  );
  assert.match(checkPassword("letters1234", strict), /符号/);
  assert.throws(
    () =>
      mergeSecuritySettings(
        {},
        { minLength: 2, classes: [], expireDays: 0, lockThreshold: 5, lockMinutes: 15 }
      ),
    /最短长度/
  );
  assert.equal(passwordChangeReason({ must_change_password: 1 }, policy), "required");
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  assert.equal(
    passwordChangeReason({ must_change_password: 0, password_changed_at: old }, strict),
    "expired"
  );
  assert.equal(
    passwordChangeReason({ must_change_password: 0, password_changed_at: old }, policy),
    null
  );
  assert.equal(
    lockedMinutes({ locked_until: new Date(Date.now() + 5 * 60000 - 1000).toISOString() }),
    5
  );
  assert.equal(lockedMinutes({ locked_until: "" }), 0);
});

test("集成配置：密码和令牌只写不读，留空不改；视频平台未接入时不发请求", async () => {
  let config = mergeSmtpSettings(
    {},
    {
      enabled: true,
      host: "smtp.example.com",
      port: 465,
      secure: "ssl",
      user: "a@example.com",
      password: "secret",
      fromAddress: "a@example.com",
    }
  );
  assert.equal(publicSmtp(config).password, undefined);
  assert.equal(publicSmtp(config).passwordSet, true);
  config = mergeSmtpSettings(config, {
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    secure: "starttls",
    user: "a@example.com",
    password: "",
  });
  assert.equal(config.smtp.password, "secret");
  assert.throws(() => mergeSmtpSettings({}, { enabled: true, host: "", port: 25 }), /SMTP 服务器/);
  assert.throws(
    () => mergeVideoSettings({}, { enabled: true, url: "ftp://x", timeoutMs: 5000 }),
    /http/
  );

  let calls = 0;
  const off = new VideoPlatform(() => readVideo({}), {
    fetchImpl: async () => {
      calls += 1;
    },
  });
  assert.equal((await off.requestRecording({ taskId: "t" })).status, "平台未接入");
  assert.equal(calls, 0);
  const on = new VideoPlatform(
    () =>
      readVideo(
        mergeVideoSettings(
          {},
          { enabled: true, url: "https://video.example/api", token: "tk", timeoutMs: 2000 }
        )
      ),
    {
      fetchImpl: async (url, init) => {
        calls += 1;
        assert.equal(init.headers.Authorization, "Bearer tk");
        assert.equal(JSON.parse(init.body).event, "box.opened");
        return {
          ok: true,
          status: 200,
          text: async () => '{"url":"https://video.example/v/1.mp4"}',
        };
      },
    }
  );
  const done = await on.requestRecording({ taskId: "t" });
  assert.equal(done.status, "已完成");
  assert.equal(done.url, "https://video.example/v/1.mp4");
});

test("权限：默认授权、老角色升级补权限、菜单按权限裁剪", () => {
  // 账号安全拆成五个独立权限，分公司管理员默认都有
  for (const code of [
    "sys:user:reset-password",
    "sys:user:force-password",
    "sys:user:unlock",
    "sys:user:kick",
    "sys:user:unbind-wechat",
  ])
    assert.ok(DEFAULT_ROLE_PERMS.BRANCH_ADMIN.includes(code), code);
  assert.ok(!DEFAULT_ROLE_PERMS.SAMPLER.includes("task:sign"));
  // 原来靠「关联任务」签收的角色，升级后补上 task:sign，行为不变
  const added = upgradeRolePerms("DUTY", ["device:box:task", "device:box:list"]);
  assert.ok(added.includes("task:sign"));
  assert.ok(
    !upgradeRolePerms("DUTY", ["task:sign", "device:box:task", "task:video", "task:log"]).includes(
      "task:sign"
    )
  );
  const sampler = menusFor(new Set(["device:box:list", "device:box:detail"]));
  const titles = sampler.map((group) => group.meta.title);
  assert.deepEqual(titles, ["工作台", "采样箱", "实时地图"]);
  // 「总览」单独授权
  assert.deepEqual(
    menusFor(new Set(["device:box:list", "monitor:overview"])).map((group) => group.meta.title),
    ["工作台", "总览", "采样箱", "实时地图"]
  );
  const admin = menusFor(
    new Set(["device:box:task", "device:box:list", "sys:user:view", "sys:oplog:read"])
  );
  const orgGroup = admin.find((group) => group.path === "/organization");
  assert.deepEqual(
    orgGroup.children.map((item) => item.name),
    ["User"]
  );
});

test("人员：新账号首次登录须改密、随机密码只回传一次；分公司管理员只管自己范围，不能动系统管理员", async () => {
  const env = await fresh("redesign-users-");
  try {
    await seedOrg(env.db);
    await seedRolePerms(env.db);
    const admin = await env.db.get("SELECT * FROM sys_user WHERE username='admin'");
    // 种子账号首次登录必须改密
    assert.equal(Number(admin.must_change_password), 1);
    const ctxAdmin = {
      db: env.db,
      user: admin,
      access: await resolveAccess(env.db, admin),
      security: publicSecurity({}),
    };
    const dept = await env.db.get("SELECT id FROM sys_dept WHERE parent_id != '0' LIMIT 1");
    const created = await call(org.createUser, {
      ...ctxAdmin,
      body: { username: "new.one", nickname: "新人", deptId: dept.id, roleIds: [] },
    });
    assert.equal(created.username, "new.one");
    assert.ok(created.password.length >= 8);
    const row = await env.db.get("SELECT * FROM sys_user WHERE username='new.one'");
    assert.equal(Number(row.must_change_password), 1);
    assert.match(
      (
        await call(org.createUser, {
          ...ctxAdmin,
          body: { username: "weak.one", nickname: "弱", deptId: dept.id, password: "abc" },
        })
      ).error,
      /至少/
    );

    // 分公司管理员：范围外的人看不到，系统管理员动不了
    const scoped = {
      ...ctxAdmin,
      user: row,
      access: {
        roles: ["BRANCH_ADMIN"],
        perms: new Set([
          "sys:user:view",
          "sys:user:create",
          "sys:user:update",
          "sys:user:disable",
          "sys:user:delete",
          "sys:user:reset-password",
          "sys:user:force-password",
          "sys:user:unlock",
          "sys:user:kick",
          "sys:user:unbind-wechat",
        ]),
        scope: { all: false, orgIds: [String(dept.id)], ownerIds: [] },
      },
    };
    const listed = await call(org.listUsers, { ...scoped, query: { pageNum: 1, pageSize: 50 } });
    assert.ok(
      listed.list.every((user) => String(user.deptId) === String(dept.id) || user.id === row.id)
    );
    assert.match(
      (await call(org.resetPassword, { ...scoped, params: { id: admin.id }, query: {}, body: {} }))
        .error,
      /范围|系统管理员/
    );

    // 管理员：解锁、强制改密、强制下线
    await env.db.run("UPDATE sys_user SET locked_until=?, failed_count=3 WHERE id=?", [
      new Date(Date.now() + 600000).toISOString(),
      row.id,
    ]);
    await call(org.unlockUser, { ...ctxAdmin, params: { id: row.id } });
    const unlocked = await env.db.get(
      "SELECT locked_until, failed_count FROM sys_user WHERE id=?",
      [row.id]
    );
    assert.equal(unlocked.locked_until, "");
    let kicked = 0;
    await call(org.kickUser, {
      ...ctxAdmin,
      params: { id: row.id },
      invalidateSessions: () => kicked++,
    });
    assert.equal(kicked, 1);
    assert.equal(
      Number(
        (await env.db.get("SELECT session_version FROM sys_user WHERE id=?", [row.id]))
          .session_version
      ),
      1
    );
    const reset = await call(org.resetPassword, {
      ...ctxAdmin,
      params: { id: row.id },
      query: {},
      body: {},
    });
    assert.ok(reset.password.length >= 8);
  } finally {
    await env.close();
  }
});

test("箱子：编号是 IMEI，激活可起名、重名拒绝、按名称找旧链接；轨迹按时间段返回", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const env = await fresh("redesign-box-");
  const boxes = new SqlBoxStore(env.db);
  try {
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const first = (await ingest.accept(packet({ uart: "why=boot,opens=0,seq=1" }))).box;
    const second = (
      await ingest.accept(packet({ imei: "864317080990009", uart: "why=boot,opens=0,seq=1" }))
    ).box;
    assert.equal(first.id, "864317080992517");
    assert.equal(first.name, "采样箱_00000001");
    assert.equal(second.name, "采样箱_00000002");
    const c = new SampleController(boxes);
    assert.match(
      (
        await call(c.activate.bind(c), {
          params: { id: second.id },
          body: { name: "采样箱_00000001" },
        })
      ).error,
      /同名/
    );
    const activated = await call(c.activate.bind(c), {
      params: { id: second.id },
      body: { name: "一号箱" },
    });
    assert.equal(activated.name, "一号箱");
    assert.equal((await call(c.detail.bind(c), { params: { id: "一号箱" } })).id, second.id);
    assert.match(
      (await call(c.rename.bind(c), { params: { id: first.id }, body: { name: "一号箱" } })).error,
      /同名/
    );
    assert.equal(
      (await call(c.rename.bind(c), { params: { id: first.id }, body: { name: "二号箱" } })).name,
      "二号箱"
    );
    // 搜索按名称
    const found = await call(c.list.bind(c), { query: { q: "二号" } });
    assert.deepEqual(
      found.list.map((item) => item.id),
      [first.id]
    );

    await ingest.accept(
      packet({ uart: "why=timer,opens=0,seq=2", gpsfix: 1, lng: 114.1, lat: 22.6 })
    );
    await ingest.accept(
      packet({ uart: "why=pad,opens=1,seq=3", gpsfix: 1, lng: 114.11, lat: 22.61 })
    );
    const track = await call(c.track.bind(c), { params: { id: first.id }, query: { days: "1" } });
    assert.equal(track.tracks[0].gpsCount, 2);
    assert.deepEqual(
      track.events.map((item) => item.label),
      ["上电", "开箱"]
    );
    assert.deepEqual(track.allow, { track: true, events: true });
    // 历史轨迹单独一项：只有当前位置不给轨迹；只有事件给事件、不给坐标（小程序箱子页只拿事件）
    const scopeAll = { all: true, orgIds: [], ownerIds: [] };
    const only = (perms) => ({
      access: { perms: new Set(upgradeCodes(perms)), scope: scopeAll },
      params: { id: first.id },
      query: { days: "1" },
    });
    assert.equal(
      (await call(c.track.bind(c), only(["device:box:detail", "device:box:location"]))).status,
      403
    );
    const eventsOnly = await call(c.track.bind(c), only(["device:box:detail", "device:box:event"]));
    assert.deepEqual(eventsOnly.tracks, []);
    assert.deepEqual(
      eventsOnly.events.map((item) => item.label),
      ["上电", "开箱"]
    );
    assert.deepEqual(eventsOnly.allow, { track: false, events: true });
    const trackOnly = await call(c.track.bind(c), only(["device:box:track"]));
    assert.equal(trackOnly.tracks[0].gpsCount, 2);
    assert.deepEqual(trackOnly.events, []);
  } finally {
    await boxes.flush();
    await env.close();
  }
});

test("采样任务录像：只有采样机构能勾；采样中在计划地点开箱才请求，平台未接入时记下状态；任务列表计数和待我处理", async () => {
  applyBoxSettings({ box: { reportPeriodSec: 60, batteryReserve: 20, arriveRadiusM: 2000 } });
  const env = await fresh("redesign-video-");
  const boxes = new SqlBoxStore(env.db),
    policies = new ReportPolicy(env.db);
  try {
    for (const [id, name, type] of [
      ["2", "华南分公司", "公司"],
      ["5", "检测机构甲", "采样机构"],
    ]) {
      await env.db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)",
        [id, "0", name, `C${id}`, type]
      );
    }
    const videos = new TaskVideoService(env.db, new VideoPlatform(() => readVideo({})));
    const ingest = new IngestService({
      boxes,
      videos,
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
      b.orgId = "5";
    });
    const c = new ReportPolicyController(boxes, policies);
    c.videos = videos;
    const ctx = {
      user: { id: "1", nickname: "管理员" },
      access: {
        roles: ["ADMIN"],
        perms: new Set(
          upgradeCodes([
            "device:box:task",
            "device:box:policyTask",
            "device:box:location",
            "device:box:event",
            "task:sign",
            "task:cancel",
            "task:video",
            "task:log",
          ])
        ),
        scope: { all: true, orgIds: [], ownerIds: [] },
      },
    };
    const base = {
      name: "录像采样",
      kind: "采样",
      boxIds: [box.id],
      placeAt: { address: "机构甲", lng: 114.1, lat: 22.6 },
    };
    await assert.rejects(
      call(c.createTask.bind(c), { ...ctx, body: { ...base, orgId: "2", recordVideo: true } }),
      /采样机构/
    );
    const { id } = await call(c.createTask.bind(c), {
      ...ctx,
      body: { ...base, orgId: "5", recordVideo: true },
    });

    const counts = await call(c.tasks.bind(c), { ...ctx, query: {} });
    assert.equal(counts.counts.待采样, 1);
    assert.equal(counts.counts.mine, 1);
    assert.deepEqual(counts.list[0].actions.sort(), ["已取消", "采样中"].sort());
    assert.equal((await call(c.tasks.bind(c), { ...ctx, query: { mine: "1" } })).total, 1);

    await call(c.transition.bind(c), { ...ctx, params: { id }, body: { status: "采样中" } });
    await ingest.accept(
      packet({ uart: "why=pad,opens=1,seq=2", gpsfix: 1, lng: 114.1001, lat: 22.6001 })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const detail = await call(c.taskDetail.bind(c), { ...ctx, params: { id } });
    assert.equal(detail.videos.length, 1);
    assert.equal(detail.videos[0].status, "平台未接入");
    assert.ok(detail.videos[0].distanceM < 100);
    assert.equal(detail.allow.video, true);

    // 远离计划地点开箱不录
    await ingest.accept(
      packet({ uart: "why=pad,opens=2,seq=3", gpsfix: 1, lng: 114.3, lat: 22.8 })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await call(c.taskDetail.bind(c), { ...ctx, params: { id } })).videos.length, 1);

    // 任务期间上报记录：按箱子、按类型翻页
    const logs = await call(c.taskLogs.bind(c), { ...ctx, params: { id }, query: { kind: "pad" } });
    assert.equal(logs.list.length, 2);
    // 工作台待办
    const todo = await c.todo(ctx);
    assert.equal(todo.sampling.total, 1);
  } finally {
    await boxes.flush();
    await env.close();
  }
});

test("箱子状态跟随任务；动态里推出离开寄出地址、失联后只补传了一部分（数据不全）", async () => {
  applyBoxSettings({
    box: {
      reportPeriodSec: 60,
      reportOnlyWhenCharging: false,
      batteryReserve: 20,
      arriveRadiusM: 500,
    },
  });
  const env = await fresh("redesign-events-");
  const boxes = new SqlBoxStore(env.db),
    policies = new ReportPolicy(env.db);
  try {
    for (const [id, name] of [
      ["2", "华南分公司"],
      ["3", "华东分公司"],
    ]) {
      await env.db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,?,?,?,1,1)",
        [id, "0", name, `C${id}`]
      );
    }
    const clock = Date.now() - 100 * 60000;
    const at = (minutes) => new Date(clock + minutes * 60000);
    let current = at(0);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      hub: { publish() {} },
      clock: { now: () => current },
      parser: new UplinkParser(),
    });
    const send = async (minutes, lng, lat, deviceMinutes = minutes) => {
      current = at(minutes);
      const d = at(deviceMinutes);
      const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 8)}`;
      return ingest.accept(
        packet({ uart: `why=timer,opens=0,seq=${minutes + 1}`, gpsfix: 1, lng, lat, time })
      );
    };
    const { box } = await send(0, 114.1, 22.6);
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
      b.orgId = "2";
    });
    const c = new ReportPolicyController(boxes, policies);
    const ctx = {
      user: { id: "1", nickname: "管理员" },
      access: {
        roles: ["ADMIN"],
        perms: new Set(
          upgradeCodes([
            "device:box:task",
            "device:box:policyTask",
            "device:box:location",
            "device:box:event",
            "task:sign",
            "task:cancel",
          ])
        ),
        scope: { all: true, orgIds: [], ownerIds: [] },
      },
    };
    const { id } = await call(c.createTask.bind(c), {
      ...ctx,
      body: {
        name: "进出测试",
        kind: "调拨",
        boxIds: [box.id],
        fromOrgId: "2",
        toOrgId: "3",
        sender: "甲",
        signer: "乙",
        fromPlace: { address: "仓库", lng: 114.1, lat: 22.6, radiusM: 500 },
        toPlace: { address: "收货点", lng: 114.3, lat: 22.8 },
      },
    });
    // 任务创建时间挪到这批上报之前
    await env.db.run("UPDATE sample_task SET created_at = ? WHERE id = ?", [
      new Date(clock - 60000).toISOString(),
      id,
    ]);
    await call(c.transition.bind(c), { ...ctx, params: { id }, body: { status: "运送中" } });
    assert.equal((await boxes.findById(box.id)).life, "在途");
    // 上报写库不能把任务改的状态盖回去
    await send(1, 114.1001, 22.6001);
    assert.equal((await boxes.findById(box.id)).life, "在途");
    await send(2, 114.2, 22.7);
    await send(3, 114.21, 22.71);
    // 40 分钟没收到，恢复后补传了空档里的记录
    await send(43, 114.25, 22.75);
    await send(43.1, 114.24, 22.74, 20);
    await send(43.2, 114.24, 22.74, 25);
    const detail = await call(c.taskDetail.bind(c), { ...ctx, params: { id } });
    const kinds = detail.events.map((e) => e.kind);
    assert.ok(kinds.includes("leave"), JSON.stringify(detail.events));
    // 40 分钟按每分钟一条应有约 39 条，只补回 2 条，不能说数据没丢
    const partial = detail.events.find((e) => e.kind === "partial");
    assert.ok(partial && partial.backfilled === 2, JSON.stringify(detail.events));
    assert.match(partial.text, /只补传了 2 条，按上报周期应有约 39 条，缺约 37 条/);
    await call(c.transition.bind(c), { ...ctx, params: { id }, body: { status: "已取消" } });
    assert.equal((await boxes.findById(box.id)).life, "未使用");
  } finally {
    await boxes.flush();
    await env.close();
  }
});

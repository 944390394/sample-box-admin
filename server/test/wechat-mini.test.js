import test from "node:test";
import { upgradeCodes } from "../src/auth/permCatalog.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { verifyPassword } from "../auth.js";
import { WechatMini } from "../src/integration/WechatMini.js";
import { WechatAuth } from "../src/auth/WechatAuth.js";
import { mergeWechatSettings, publicWechat } from "../src/settings/integrationConfig.js";
import {
  BRANDING_DEFAULTS,
  mergeBrandingSettings,
  readBranding,
} from "../src/settings/brandingConfig.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { IngestService } from "../src/service/IngestService.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";
import { unbindWechat } from "../org-api.js";
import { packet } from "./fixture.js";

const SECRET = "0123456789abcdef0123456789abcdef";

test("小程序 code 换 openid：没配置先提示，微信报错原样给出，调试时可固定 openid；AppSecret 只写不读", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes("js_code=union"))
      return { json: async () => ({ openid: "o-2", unionid: "u-2", session_key: "k" }) };
    return {
      json: async () =>
        url.includes("js_code=good")
          ? { openid: "o-1", session_key: "k" }
          : { errcode: 40029, errmsg: "invalid code" },
    };
  };
  let settings = { appId: "", appSecret: "" };
  const mini = new WechatMini({ settings: () => settings, fetch, fakeOpenid: "" });
  await assert.rejects(mini.openid("good"), /AppID/);
  settings = { appId: "wx76dc414b9199c3bf", appSecret: SECRET };
  assert.deepEqual(await mini.openid("good"), {
    openid: "o-1",
    appId: "wx76dc414b9199c3bf",
    unionid: "",
  });
  // 小程序绑了开放平台账号时，code2Session 一并返回 UnionID
  assert.equal((await mini.openid("union")).unionid, "u-2");
  assert.match(
    calls[0],
    /appid=wx76dc414b9199c3bf&secret=0123.*&js_code=good&grant_type=authorization_code/
  );
  await assert.rejects(mini.openid("bad"), /invalid code/);
  await assert.rejects(mini.openid(""), /凭证无效/);
  assert.deepEqual(
    await new WechatMini({ settings: () => ({}), fakeOpenid: "dev-1" }).openid("x"),
    { openid: "dev-1", appId: "dev", unionid: "" }
  );

  assert.throws(() => mergeWechatSettings({}, { appId: "abc" }), /AppID/);
  const saved = mergeWechatSettings(
    { secret: "keep" },
    { appId: "wx76dc414b9199c3bf", appSecret: SECRET }
  );
  assert.equal(saved.secret, "keep");
  assert.equal(
    mergeWechatSettings(saved, { appId: "wx76dc414b9199c3bf", appSecret: "" }).wechat.appSecret,
    SECRET
  );
  assert.deepEqual(publicWechat(saved), { appId: "wx76dc414b9199c3bf", appSecretSet: true });
});

test("小程序绑定：没绑先要账号密码，绑定后静默登录；换微信会顶掉旧绑定；停用、锁定不发令牌；本人或管理员可解绑", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-auth-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    const admin = await db.get("SELECT * FROM sys_user WHERE username='admin'");
    const credentials = async (_ctx, username, password) => {
      const user = await db.get("SELECT * FROM sys_user WHERE username=?", [username]);
      return user && verifyPassword(password, user.password_hash)
        ? { user }
        : { fail: ["用户名或密码错误"] };
    };
    let openid = "o-a",
      unionid = "";
    const auth = new WechatAuth({
      wechat: { openid: async () => ({ openid, appId: "wx1", unionid }) },
      credentials,
      tokens: (user) => ({ accessToken: `t-${user.id}` }),
    });
    const call = async (method, extra = {}) => {
      let out;
      await auth[method]({
        db,
        ip: "",
        body: { code: "c" },
        ...extra,
        ok: (data) => (out = { ok: true, data }),
        fail: (message, code, status) => (out = { message, code, status }),
      });
      return out;
    };

    assert.deepEqual((await call("login")).data, { bound: false });
    assert.match(
      (await call("bind", { body: { code: "c", username: "admin", password: "wrong" } })).message,
      /密码错误/
    );
    const bound = await call("bind", {
      body: { code: "c", username: "admin", password: "123456" },
    });
    assert.deepEqual(bound.data, { bound: true, accessToken: `t-${admin.id}` });
    assert.equal((await call("login")).data.bound, true);
    assert.equal(
      (await db.get("SELECT action FROM sys_operation_log WHERE action='绑定微信'"))?.action,
      "绑定微信"
    );
    // 小程序后来绑了开放平台：下次登录补上 UnionID；之后某次没返回也不清掉
    assert.equal(
      (await db.get("SELECT unionid FROM sys_user_wechat WHERE openid='o-a'")).unionid,
      ""
    );
    unionid = "u-a";
    await call("login");
    assert.equal(
      (await db.get("SELECT unionid FROM sys_user_wechat WHERE openid='o-a'")).unionid,
      "u-a"
    );
    unionid = "";
    await call("login");
    assert.equal(
      (await db.get("SELECT unionid FROM sys_user_wechat WHERE openid='o-a'")).unionid,
      "u-a"
    );

    // 同一账号在另一台手机上绑定：旧微信失效，一个账号只留一个微信；绑定时带上 UnionID
    openid = "o-b";
    unionid = "u-b";
    await call("bind", { body: { code: "c", username: "admin", password: "123456" } });
    assert.equal(
      (await db.get("SELECT unionid FROM sys_user_wechat WHERE openid='o-b'")).unionid,
      "u-b"
    );
    unionid = "";
    assert.equal((await call("login")).data.bound, true);
    openid = "o-a";
    assert.deepEqual((await call("login")).data, { bound: false });
    openid = "o-b";

    await db.run("UPDATE sys_user SET locked_until=? WHERE id=?", [
      new Date(Date.now() + 600000).toISOString(),
      admin.id,
    ]);
    assert.equal((await call("login")).code, "A0233");
    await db.run("UPDATE sys_user SET locked_until='', status=0 WHERE id=?", [admin.id]);
    assert.equal((await call("login")).code, "A0232");
    await db.run("UPDATE sys_user SET status=1 WHERE id=?", [admin.id]);

    assert.ok((await call("unbind", { user: admin })).ok);
    assert.deepEqual((await call("login")).data, { bound: false });

    // 管理员在人员管理里解绑
    await call("bind", { body: { code: "c", username: "admin", password: "123456" } });
    let out;
    await unbindWechat({
      db,
      user: admin,
      params: { id: String(admin.id) },
      access: null,
      ok: (_d, m) => (out = m),
      fail: (m) => (out = m),
    });
    assert.equal(out, "已解绑微信");
    assert.equal(await db.get("SELECT openid FROM sys_user_wechat"), undefined);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("扫网页绑定二维码：票据 5 分钟、只能用一次、账号下线后作废；带上昵称头像；网页能看到我绑的微信", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-ticket-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    let admin = await db.get("SELECT * FROM sys_user WHERE username='admin'");
    let now = Date.parse("2026-10-30T08:00:00Z");
    let openid = "o-scan";
    const auth = new WechatAuth({
      wechat: { openid: async () => ({ openid, appId: "wx1" }) },
      credentials: async () => ({ fail: ["不该走密码"] }),
      tokens: (user) => ({ accessToken: `t-${user.id}` }),
      now: () => new Date(now),
    });
    const call = async (method, extra = {}) => {
      let out;
      await auth[method]({
        db,
        ip: "",
        body: {},
        ...extra,
        ok: (data) => (out = { ok: true, data }),
        fail: (message, code) => (out = { message, code }),
      });
      return out;
    };
    const avatar = "data:image/png;base64,iVBORw0KGgo=";

    assert.deepEqual((await call("mine", { user: admin })).data, { bound: false });
    const { ticket, ttlSec } = (await call("ticket", { user: admin })).data;
    assert.equal(ttlSec, 300);
    assert.equal(ticket.length, 48);
    // 乱填的票据、正确的票据、再用一次
    assert.match(
      (await call("bindTicket", { body: { code: "c", ticket: "nope" } })).message,
      /过期或已经用过/
    );
    const bound = await call("bindTicket", {
      body: { code: "c", ticket, nickname: "  小王的微信  ", avatar },
    });
    assert.deepEqual(bound.data, { bound: true, accessToken: `t-${admin.id}` });
    assert.match(
      (await call("bindTicket", { body: { code: "c", ticket } })).message,
      /过期或已经用过/
    );
    const mine = (await call("mine", { user: admin })).data;
    assert.equal(mine.nickname, "小王的微信");
    assert.equal(mine.avatar, avatar);
    assert.equal((await call("login")).data.bound, true);

    // 过期：5 分钟后不能用；新生成的会让同账号旧票据作废
    const old = (await call("ticket", { user: admin })).data.ticket;
    const fresh = (await call("ticket", { user: admin })).data.ticket;
    assert.match(
      (await call("bindTicket", { body: { code: "c", ticket: old } })).message,
      /过期或已经用过/
    );
    now += 5 * 60000 + 1;
    assert.match(
      (await call("bindTicket", { body: { code: "c", ticket: fresh } })).message,
      /过期或已经用过/
    );

    // 生成后账号被强制下线（会话版本变了）：票据作废
    const later = (await call("ticket", { user: admin })).data.ticket;
    await db.run("UPDATE sys_user SET session_version = session_version + 1 WHERE id = ?", [
      admin.id,
    ]);
    assert.match(
      (await call("bindTicket", { body: { code: "c", ticket: later } })).message,
      /重新登录网页/
    );
    admin = await db.get("SELECT * FROM sys_user WHERE username='admin'");

    // 换一个微信扫码：顶掉原来的绑定；不合格的头像不存
    openid = "o-other";
    const another = (await call("ticket", { user: admin })).data.ticket;
    await call("bindTicket", {
      body: { code: "c", ticket: another, avatar: "javascript:alert(1)" },
    });
    const row = await db.get(
      "SELECT openid, nickname, avatar FROM sys_user_wechat WHERE user_id = ?",
      [String(admin.id)]
    );
    assert.deepEqual({ ...row }, { openid: "o-other", nickname: "", avatar: "" });
    assert.equal(
      (await db.get("SELECT action FROM sys_operation_log WHERE action='扫码绑定微信'"))?.action,
      "扫码绑定微信"
    );

    // 网页上自己解绑
    assert.ok((await call("unbind", { user: admin })).ok);
    assert.deepEqual((await call("mine", { user: admin })).data, { bound: false });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("手机号快捷登录：凭证缓存、过期重取；按人员手机号找账号，对不上或多个时不绑；登录后可补昵称头像", async () => {
  // 微信接口：稳定版凭证 + 换手机号；第一次换手机号时报凭证过期
  const calls = [];
  let expiredOnce = true;
  const fetch = async (url, options = {}) => {
    calls.push(url.replace(/access_token=[^&]+/, "access_token=*"));
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes("stable_token"))
      return { json: async () => ({ access_token: `tok-${calls.length}`, expires_in: 7200 }) };
    if (url.includes("getuserphonenumber")) {
      if (expiredOnce) {
        expiredOnce = false;
        return { json: async () => ({ errcode: 40001, errmsg: "invalid credential" }) };
      }
      return {
        json: async () => ({
          errcode: 0,
          phone_info: {
            phoneNumber: "+86 138-0000-0001",
            purePhoneNumber: body.code === "p1" ? "13800000001" : "13900000009",
          },
        }),
      };
    }
    return { json: async () => ({}) };
  };
  const mini = new WechatMini({
    settings: () => ({ appId: "wx76dc414b9199c3bf", appSecret: SECRET }),
    fetch,
    fakeOpenid: "",
  });
  assert.equal(await mini.phoneNumber("p1"), "13800000001");
  assert.equal(await mini.phoneNumber("p2"), "13900000009");
  // 凭证：先取一次，过期报错后强制刷新一次，之后用缓存
  assert.equal(calls.filter((u) => u.includes("stable_token")).length, 2);
  await assert.rejects(mini.phoneNumber(""), /手机号授权无效/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-phone-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status,mobile) VALUES ('41','zhang','张三','x','1',1,'+86 138 0000 0001')"
    );
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status,mobile) VALUES ('42','li','李四','x','1',1,'13700000007')"
    );
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status,mobile) VALUES ('43','li2','李四二号','x','1',1,'137-0000-0007')"
    );
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status,mobile) VALUES ('44','wang','王五','x','1',0,'13600000006')"
    );
    let phone = "13800000001";
    const auth = new WechatAuth({
      wechat: {
        openid: async () => ({ openid: "o-phone", appId: "wx1" }),
        phoneNumber: async () => phone,
      },
      credentials: async () => ({ fail: ["x"] }),
      tokens: (user) => ({ accessToken: `t-${user.id}` }),
    });
    const call = async (method, extra = {}) => {
      let out;
      await auth[method]({
        db,
        ip: "",
        body: { code: "c", phoneCode: "p" },
        ...extra,
        ok: (data) => (out = { ok: true, data }),
        fail: (message, code) => (out = { message, code }),
      });
      return out;
    };
    assert.deepEqual((await call("phone")).data, { bound: true, accessToken: "t-41" });
    assert.equal(
      (await db.get("SELECT user_id FROM sys_user_wechat WHERE openid='o-phone'")).user_id,
      "41"
    );
    assert.equal(
      (await db.get("SELECT action FROM sys_operation_log WHERE action='手机号绑定微信'"))?.action,
      "手机号绑定微信"
    );
    phone = "13700000007";
    assert.match((await call("phone")).message, /137\*\*\*\*0007 登记在多个账号/);
    phone = "13600000006";
    assert.match((await call("phone")).message, /136\*\*\*\*0006 没有对应的账号/);
    phone = "";
    assert.match((await call("phone")).message, /没拿到手机号/);

    // 登录后完善资料
    const zhang = await db.get("SELECT * FROM sys_user WHERE id='41'");
    const saved = await call("profile", {
      user: zhang,
      body: { nickname: "老张", avatar: "data:image/jpeg;base64,/9j/4AAQ" },
    });
    assert.equal(saved.data.nickname, "老张");
    assert.equal(saved.data.avatar, "data:image/jpeg;base64,/9j/4AAQ");
    const lee = await db.get("SELECT * FROM sys_user WHERE id='42'");
    assert.match(
      (await call("profile", { user: lee, body: { nickname: "x" } })).message,
      /还没有绑定微信/
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("系统名称和图标：默认值、校验、图标不传不改、传空恢复默认", () => {
  assert.deepEqual(readBranding({}), BRANDING_DEFAULTS);
  assert.throws(() => mergeBrandingSettings({}, { title: "" }), /1–20/);
  assert.throws(
    () => mergeBrandingSettings({}, { title: "名称", logo: "data:image/svg+xml;base64,PHN2Zz4=" }),
    /PNG/
  );
  assert.throws(
    () =>
      mergeBrandingSettings(
        {},
        { title: "名称", logo: `data:image/png;base64,${"A".repeat(300001)}` }
      ),
    /太大/
  );
  const logo = "data:image/png;base64,iVBORw0KGgo=";
  const saved = mergeBrandingSettings(
    { secret: "keep" },
    { title: " 某某检测中心 ", slogan: "采样箱管理", logo }
  );
  assert.equal(saved.secret, "keep");
  assert.deepEqual(readBranding(saved), { title: "某某检测中心", slogan: "采样箱管理", logo });
  assert.equal(readBranding(mergeBrandingSettings(saved, { title: "新名称" })).logo, logo);
  assert.equal(readBranding(mergeBrandingSettings(saved, { logo: "" })).logo, "");
});

test("扫箱码：本单位看状态、空闲时能建单；接收方只看到名称和相关任务、能签收；不相关的人看不到", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-scan-"));
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
    ]) {
      await db.run(
        "INSERT INTO sys_dept (id,parent_id,name,code,sort,status) VALUES (?,?,?,?,1,1)",
        [id, "0", name, `D${id}`]
      );
    }
    await db.run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES ('30','e1','华东签收员','x','3',1)"
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
      b.org = "华南分公司";
      b.orgId = "2";
      b.name = "BOX-009";
    });

    const c = new ReportPolicyController(boxes, policies);
    const ALL = [
      "device:box:list",
      "device:box:detail",
      "device:box:status",
      "device:box:task",
      "device:box:policyTask",
      "task:sign",
      "task:cancel",
    ];
    const ctxOf = (orgIds, perms, user) => ({
      user,
      access: {
        perms: new Set(upgradeCodes(perms)),
        scope: orgIds
          ? { all: false, orgIds, ownerIds: [] }
          : { all: true, orgIds: [], ownerIds: [] },
      },
    });
    const scan = async (ctx, id = box.id) => {
      let out;
      await c.scan({ ...ctx, params: { id }, ok: (data) => (out = data) });
      return out;
    };
    const south = ctxOf(["2"], ALL, { id: "9", nickname: "华南管理员" });
    const signer = ctxOf(["3"], ["device:box:task", "task:sign"], {
      id: "30",
      nickname: "华东签收员",
    });
    const colleague = ctxOf(["3"], ["device:box:task", "task:sign"], {
      id: "31",
      nickname: "华东值班员",
    });

    // 本单位管理员：看得到状态，空闲箱子能建单；按名称也能扫到
    let seen = await scan(south);
    assert.equal(seen.visible, true);
    assert.equal(seen.canCreate, true);
    assert.ok("battery" in seen.box);
    assert.equal((await scan(south, "BOX-009")).box.id, box.id);
    // 接收方：箱子不在范围、也没有相关任务时看不到
    await assert.rejects(scan(signer), /不在你的管理范围/);

    const created = await new Promise((resolve, reject) =>
      c
        .createTask({
          ...south,
          body: {
            name: "寄华东",
            kind: "调拨",
            boxIds: [box.id],
            sender: "华南寄件人",
            signerId: "30",
            fromOrgId: "2",
            toOrgId: "3",
          },
          ok: resolve,
        })
        .catch(reject)
    );
    const run = (ctx, status) =>
      c.transition({
        ...ctx,
        params: { id: created.id },
        body: { status, note: status === "强制签收" ? "签收人不在" : "" },
        ok() {},
      });
    await run(south, "运送中");
    seen = await scan(south);
    assert.equal(seen.canCreate, false);
    assert.equal(seen.tasks[0].can["已取消"], true);

    // 接收方扫到：只有名称，没有电量位置；能确认到达，到达后签收人签收、同事强制签收
    seen = await scan(signer);
    assert.equal(seen.visible, false);
    assert.equal(seen.box.name, "BOX-009");
    assert.ok(!("battery" in seen.box));
    assert.equal(seen.tasks[0].can["待签收"], true);
    await run(signer, "待签收");
    assert.equal((await scan(signer)).tasks[0].can["已签收"], true);
    const peer = (await scan(colleague)).tasks[0].can;
    assert.equal(peer["已签收"], false);
    assert.equal(peer["强制签收"], true);
    await run(colleague, "强制签收");
    seen = await scan(signer);
    assert.equal(seen.visible, false);
    assert.equal(seen.tasks[0].active, false);
    assert.deepEqual(seen.tasks[0].can, {});
    // 签收后箱子归华东：签收人那边看得到箱子了（签收人没有箱子查看权限，所以仍只给名称），华南看不到了
    await assert.rejects(
      scan(ctxOf(["2"], ["device:box:detail"], { id: "9" })),
      /不在你的管理范围/
    );
    await assert.rejects(scan(south, "nope"), /没有这台采样箱/);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("监控通道：最多 8 路、名称必填、地址要 http(s)；坏数据当成没有", async () => {
  const { validateCameras, readCameras } = await import("../src/settings/deptCameras.js");
  assert.deepEqual(validateCameras([{ name: " 门口 ", channel: "34020000001320000001" }]), [
    { name: "门口", channel: "34020000001320000001", liveUrl: "", playbackUrl: "" },
  ]);
  assert.throws(
    () => validateCameras(Array.from({ length: 9 }, (_, i) => ({ name: `通道${i}` }))),
    /最多 8 路/
  );
  assert.throws(() => validateCameras([{ name: "" }]), /要填名称/);
  assert.throws(() => validateCameras([{ name: "门口", liveUrl: "rtsp://x" }]), /http/);
  assert.deepEqual(readCameras("not json"), []);
  assert.equal(readCameras(JSON.stringify([{ name: "a" }, { bad: 1 }])).length, 1);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import { rolePerms, saveRolePerms } from "../org-api.js";
import { BOX, maskBox, resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import { BoxState } from "../src/domain/BoxState.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import { SampleController } from "../src/http/SampleController.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";

async function openFresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-access-"));
  const db = await openDatabase({ dialect: "sqlite", sqlitePath: path.join(dir, "a.db") }, dir);
  await migrate(db);
  await seedOrg(db);
  await seedRolePerms(db);
  return {
    db,
    async close() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function box(id, fields = {}) {
  return new BoxState({
    id,
    imei: `86431708099${id.slice(-4).replace("-", "0")}`,
    iccid: "8986",
    imsi: "",
    firmware: "1.0.1",
    org: "总公司",
    owner: "—",
    life: "未使用",
    alert: "",
    battery: "3.90 V",
    csq: 19,
    last: formatTimestamp(new Date()),
    lbs: "",
    lbsLng: 114.1,
    lbsLat: 22.6,
    gps: "未定位",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    batteryMv: 3900,
    activateStep: "已确认",
    poweredAt: "",
    ...fields,
  });
}

function call(
  handler,
  { access = null, user = null, db = null, params = {}, query = {}, body = {} } = {}
) {
  return new Promise((resolve) => {
    const ctx = {
      access,
      user,
      db,
      params,
      query,
      body,
      ok: (data, msg) => resolve({ ok: true, data, msg }),
      fail: (msg, code, status) => resolve({ ok: false, msg, code, status }),
    };
    Promise.resolve(handler(ctx)).catch((error) => resolve({ ok: false, msg: error.message }));
  });
}

async function userOf(db, username) {
  return db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
}

test("默认授权按角色写入，调度员范围包含本分公司，采样员只看自己保管的", async () => {
  const env = await openFresh();
  try {
    const admin = await resolveAccess(env.db, await userOf(env.db, "admin"));
    assert.equal(admin.scope.all, true);
    assert.ok(admin.perms.has(BOX.export));

    const dispatch = await resolveAccess(env.db, await userOf(env.db, "chen.ke"));
    assert.equal(dispatch.scope.all, false);
    assert.ok(dispatch.scope.orgIds.includes("2"));
    assert.ok(dispatch.scope.orgIds.includes("21"));
    assert.ok(!dispatch.scope.orgIds.includes("1"));
    assert.ok(dispatch.perms.has(BOX.assignOrg) && dispatch.perms.has(BOX.assignOwner));
    assert.ok(!dispatch.perms.has(BOX.iccid) && !dispatch.perms.has(BOX.firmware));

    const sampler = await userOf(env.db, "lin.xia");
    const field = await resolveAccess(env.db, sampler);
    assert.deepEqual(field.scope.orgIds, []);
    assert.deepEqual(field.scope.ownerIds, [String(sampler.id)]);
  } finally {
    await env.close();
  }
});

test("清单按范围、快捷筛选分页，无标识权限时不能按 IMEI 搜", async () => {
  const env = await openFresh();
  try {
    const store = new SqlBoxStore(env.db);
    await store.save(box("BOX-001"));
    await store.save(box("BOX-002", { org: "华南分公司", orgId: "2", alert: "开箱超过 2 次" }));
    await store.save(box("BOX-003", { org: "华南分公司", orgId: "2", batteryMv: 3500 }));
    await store.save(box("BOX-004", { last: "2026-01-01 00:00:00.000" }));
    const controller = new SampleController(store);
    const dispatch = await resolveAccess(env.db, await userOf(env.db, "chen.ke"));

    const scoped = await call((ctx) => controller.list(ctx), {
      access: dispatch,
      query: { page: "1" },
    });
    assert.equal(scoped.ok, true);
    assert.deepEqual(scoped.data.list.map((item) => item.id).sort(), ["BOX-002", "BOX-003"]);
    assert.equal(scoped.data.counts.未使用, 2);
    assert.equal(scoped.data.flags.alert, 1);
    assert.equal(scoped.data.flags.low, 1);
    // IMEI 就是编号，不再隐藏；ICCID 仍按设备标识权限隐藏
    assert.equal(scoped.data.list[0].iccid, undefined);
    assert.ok(scoped.data.list[0].masked.includes("identity"));

    const low = await call((ctx) => controller.list(ctx), {
      access: dispatch,
      query: { flag: "low" },
    });
    assert.deepEqual(
      low.data.list.map((item) => item.id),
      ["BOX-003"]
    );

    const byImei = await call((ctx) => controller.list(ctx), {
      access: dispatch,
      query: { q: "864317080990002" },
    });
    assert.equal(byImei.data.total, 0);

    const admin = await resolveAccess(env.db, await userOf(env.db, "admin"));
    const offline = await call((ctx) => controller.list(ctx), {
      access: admin,
      query: { flag: "offline" },
    });
    assert.deepEqual(
      offline.data.list.map((item) => item.id),
      ["BOX-004"]
    );
    const stats = await call((ctx) => controller.stats(ctx), { access: admin });
    assert.equal(stats.data.total, 4);

    const outside = await call((ctx) => controller.detail(ctx), {
      access: dispatch,
      params: { id: "BOX-001" },
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.status, 404);
  } finally {
    await env.close();
  }
});

test("激活、停用、恢复按生命周期校验，分配只能给范围内的单位和人", async () => {
  const env = await openFresh();
  try {
    const store = new SqlBoxStore(env.db);
    await store.save(box("BOX-001", { life: "待激活", activateStep: "等待激活" }));
    await store.save(box("BOX-002", { org: "华南分公司", orgId: "2" }));
    const controller = new SampleController(store);
    const assetUser = await userOf(env.db, "zhou.ning");
    const asset = await resolveAccess(env.db, assetUser);

    const stop = await call((ctx) => controller.disable(ctx), {
      access: asset,
      params: { id: "BOX-001" },
    });
    assert.equal(stop.ok, false);
    const on = await call((ctx) => controller.activate(ctx), {
      access: asset,
      user: assetUser,
      db: env.db,
      params: { id: "BOX-001" },
    });
    assert.equal(on.ok, true);
    assert.equal(on.data.life, "未使用");
    assert.equal((await store.findById("BOX-001")).life, "未使用");

    const dispatchUser = await userOf(env.db, "chen.ke");
    const dispatch = await resolveAccess(env.db, dispatchUser);
    const noPerm = await call((ctx) => controller.disable(ctx), {
      access: dispatch,
      params: { id: "BOX-002" },
    });
    assert.equal(noPerm.status, 403);

    const away = await call((ctx) => controller.assign(ctx), {
      access: dispatch,
      user: dispatchUser,
      db: env.db,
      params: { id: "BOX-002" },
      body: { orgId: "3" },
    });
    assert.equal(away.ok, false);
    const sampler = await userOf(env.db, "lin.xia");
    const foreign = await call((ctx) => controller.assign(ctx), {
      access: dispatch,
      user: dispatchUser,
      db: env.db,
      params: { id: "BOX-002" },
      body: { ownerId: String(sampler.id) },
    });
    assert.equal(foreign.ok, false);
    const assetAssign = await call((ctx) => controller.assign(ctx), {
      access: asset,
      user: assetUser,
      db: env.db,
      params: { id: "BOX-002" },
      body: { ownerId: String(sampler.id) },
    });
    assert.equal(assetAssign.ok, true);
    assert.equal(assetAssign.data.owner, "林夏");

    const field = await resolveAccess(env.db, sampler);
    const mine = await call((ctx) => controller.list(ctx), { access: field, query: { page: "1" } });
    assert.deepEqual(
      mine.data.list.map((item) => item.id),
      ["BOX-002"]
    );
  } finally {
    await env.close();
  }
});

test("角色页保存的权限覆盖默认值，未知的码丢掉，系统管理员不能改", async () => {
  const env = await openFresh();
  try {
    const role = await env.db.get("SELECT id FROM sys_role WHERE code = ?", ["VERIFY"]);
    const before = await call(rolePerms, { db: env.db, params: { id: String(role.id) } });
    assert.ok(before.data.codes.includes(BOX.detail));
    assert.ok(before.data.codes.includes(BOX.track));
    assert.equal(before.data.assignable, null);

    const saved = await call(saveRolePerms, {
      db: env.db,
      params: { id: String(role.id) },
      body: { codes: [BOX.list, BOX.location, "device:box:nope"] },
    });
    assert.equal(saved.ok, true);
    const verifier = await resolveAccess(env.db, await userOf(env.db, "wu.di"));
    assert.deepEqual([...verifier.perms].sort(), [BOX.list, BOX.location].sort());

    const admin = await env.db.get("SELECT id FROM sys_role WHERE code = ?", ["ADMIN"]);
    const locked = await call(saveRolePerms, {
      db: env.db,
      params: { id: String(admin.id) },
      body: { codes: [] },
    });
    assert.equal(locked.ok, false);
  } finally {
    await env.close();
  }
});

test("无权字段不下发", () => {
  const json = box("BOX-001").toJSON();
  const masked = maskBox(json, new Set([BOX.list, BOX.detail]));
  assert.equal(masked.battery, undefined);
  assert.equal(masked.lbsLng, undefined);
  assert.equal(masked.iccid, undefined);
  // 按字段遮：工况七项、位置、ICCID、IMSI、固件各自一组；全遮时另记 status、identity 给旧页面
  assert.deepEqual(masked.masked, [
    "power",
    "lid",
    "opens",
    "signal",
    "charging",
    "powerLog",
    "storage",
    "location",
    "iccid",
    "imsi",
    "firmware",
    "status",
    "identity",
  ]);
  assert.equal(masked.id, "BOX-001");
  // 只有「查看箱盖状态」：箱盖给，电量不给
  const lidOnly = maskBox(json, new Set([BOX.list, BOX.lid]));
  assert.ok("lid" in lidOnly && lidOnly.battery === undefined);
  assert.ok(
    !lidOnly.masked.includes("lid") &&
      lidOnly.masked.includes("power") &&
      !lidOnly.masked.includes("status")
  );
  // 不看固件版本也知道能不能远程操作
  assert.equal(typeof masked.remote, "boolean");
});

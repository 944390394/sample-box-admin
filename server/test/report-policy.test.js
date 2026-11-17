import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { ReportPolicy, resolvePolicy, validatePolicy } from "../src/settings/ReportPolicy.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { ReportPolicyController } from "../src/http/ReportPolicyController.js";

async function seedBoxes(db) {
  for (const id of ["TEST-1", "TEST-2", "TEST"])
    await db.run("INSERT INTO sample_box (id,imei,life,org,activate_step) VALUES (?,?,?,?,?)", [
      id,
      id,
      "未使用",
      "总公司",
      "已确认",
    ]);
}
const p = (n) => ({ reportPeriodSec: n, reportOnlyWhenCharging: false });
test("整组配置严格校验；优先级为任务单箱、长期单箱、任务统一、批量、默认", () => {
  applyBoxSettings({ box: { ...p(60), batteryReserve: 20 } });
  for (const n of [0, 4, 3601, 5.5, "60", NaN]) assert.throws(() => validatePolicy(p(n)));
  assert.throws(() => validatePolicy({ reportPeriodSec: 60, reportOnlyWhenCharging: "false" }));
  assert.equal(resolvePolicy(null, null, null, "a").reportPeriodSec, 60);
  assert.equal(resolvePolicy(null, p(120), null, "a").reportPeriodSec, 120);
  const task = { policy: p(30), overrides: { a: p(5) } };
  assert.equal(resolvePolicy(p(10), p(120), task, "a").reportPeriodSec, 5);
  assert.equal(resolvePolicy(p(10), p(120), task, "b").reportPeriodSec, 10);
  assert.equal(resolvePolicy(null, p(120), task, "b").reportPeriodSec, 30);
});

test("策略持久化，任务终结恢复最新底层；重复启动和重叠任务被拒绝", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "report-policy-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedBoxes(db);
    let service = new ReportPolicy(db);
    const box = { id: "TEST-1", firmware: "1.0.4" };
    await service.save([box.id], "batch", p(120));
    await service.save([box.id], "single", p(10));
    await service.save([box.id], "batch", p(300));
    assert.equal((await service.get(box)).effective.reportPeriodSec, 10);
    const lifeOf = async (boxId) =>
      (await db.get("SELECT life FROM sample_box WHERE id=?", [boxId])).life;
    const before = await lifeOf(box.id);
    const id = await service.createTask({
      name: "test",
      kind: "采样",
      boxIds: [box.id],
      policy: p(30),
      overrides: { [box.id]: p(5) },
    });
    // 建单就占用箱子，但任务策略要等开始才生效
    if (before === "未使用") assert.equal(await lifeOf(box.id), "在途");
    assert.equal((await service.get(box)).effective.reportPeriodSec, 10);
    await service.transition(id, "采样中");
    assert.equal((await service.get(box)).effective.reportPeriodSec, 5);
    // 箱子已在没结束的单里：再建单直接拒绝，同一单里的其他箱子也不会被占
    const lifeTest2 = await lifeOf("TEST-2");
    await assert.rejects(
      service.createTask({
        name: "test2",
        kind: "采样",
        boxIds: [box.id, "TEST-2"],
        policy: p(40),
        overrides: {},
      }),
      /已在任务单「test」里/
    );
    assert.equal(await lifeOf("TEST-2"), lifeTest2);
    assert.equal(
      await db.get("SELECT * FROM box_active_task WHERE box_id=?", ["TEST-2"]),
      undefined
    );
    await service.save([box.id], "single", p(20));
    await service.transition(id, "已封箱");
    await service.transition(id, "在途");
    await service.transition(id, "待核验");
    await service.transition(id, "已签收");
    if (before === "未使用") assert.equal(await lifeOf(box.id), "未使用");
    service = new ReportPolicy(db);
    assert.equal((await service.get(box)).effective.reportPeriodSec, 20);
    await assert.rejects(service.transition(id, "采样中"));
    await service.save([box.id], "single", null);
    assert.equal((await service.get(box)).effective.reportPeriodSec, 300);
    await service.save([box.id], "batch", null);
    assert.equal((await service.get(box)).effective.source, "系统默认");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("发送不等于生效；需版本、实际周期和模式匹配，旧回执不可确认新策略", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "policy-ack-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedBoxes(db);
    const service = new ReportPolicy(db),
      box = { id: "TEST", firmware: "1.0.4" };
    await service.save([box.id], "single", p(10));
    const packet = await service.packet(box);
    assert.match(packet.text, /^ok p=10 c=0 v=\d+ g=[01]\n$/);
    assert.equal((await service.get(box)).status, "待下发");
    await service.sent(box.id, packet.version);
    assert.equal((await service.get(box)).status, "已发送待确认");
    const parser = new UplinkParser();
    const uplink = parser.parse(
      JSON.stringify({
        imei: "864317080992517",
        uart: `why=timer,pv=${packet.version},rp=10,rc=0,fw=1.0.4`,
      })
    );
    await service.observe(box, uplink);
    assert.equal((await service.get(box)).status, "已生效");
    const missed = parser.parse(
      JSON.stringify({ imei: "864317080992517", uart: "why=timer,pv=0,rp=5,rc=0,fw=1.0.4" })
    );
    await service.sent(box.id, packet.version);
    for (const why of ["boot", "timer"]) {
      await service.observe(box, { ...missed, why, backfill: true });
      assert.equal((await service.get(box)).status, "已生效");
    }
    await service.observe(box, missed);
    const missedState = await service.get(box);
    assert.equal(missedState.status, "未生效");
    assert.equal(missedState.echo.version, "0");
    assert.equal(missedState.echo.periodSec, 5);
    await service.save([box.id], "single", p(60));
    await service.observe(box, uplink);
    assert.equal((await service.get(box)).status, "待下发");
    assert.equal((await service.get({ ...box, firmware: "1.0.1" })).status, "固件不支持");
    assert.equal((await service.packet({ ...box, firmware: "1.0.1" })).text, "ok\n");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("控制器拒绝无权限和跨部门批量目标", async () => {
  const db = { all: async () => [{ id: "a", org_id: "2", owner_id: "3" }] };
  const c = new ReportPolicyController({}, { db });
  const ctx = { access: { perms: new Set(), scope: { all: false, orgIds: ["1"], ownerIds: [] } } };
  assert.throws(() => c.require(ctx, "device:box:policyBatch"));
  await assert.rejects(c.targets(ctx, ["a"]), /管理范围/);
  await assert.rejects(c.targets(ctx, []));
});

test("指示灯模式：只对 1.0.7 及以上下发 l=，不改旧策略的版本号", async () => {
  applyBoxSettings({ box: { ...p(60), batteryReserve: 20 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "report-policy-led-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedBoxes(db);
    const service = new ReportPolicy(db);
    const box = { id: "TEST-1", firmware: "1.0.7" };
    const before = resolvePolicy(p(10), null, null, "TEST-1").version;
    assert.equal(
      resolvePolicy({ ...p(10), indicators: true }, null, null, "TEST-1").version,
      before
    );
    assert.notEqual(
      resolvePolicy({ ...p(10), indicators: false }, null, null, "TEST-1").version,
      before
    );
    assert.throws(() => validatePolicy({ ...p(10), indicators: "no" }));
    assert.match((await service.packet(box)).text, /^ok p=60 c=0 l=1 v=\d+ g=[01]\n$/);
    await service.save(["TEST-1"], "single", { ...p(10), indicators: false });
    assert.match((await service.packet(box)).text, /^ok p=10 c=0 l=0 v=\d+ g=[01]\n$/);
    assert.match(
      (await service.packet({ ...box, firmware: "1.0.6" })).text,
      /^ok p=10 c=0 v=\d+ g=[01]\n$/
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("模块灯：m= 跟在 v= 之后，只有设备改用 net= 链路状态（rn=1）才下发，版本号随之变化", async () => {
  applyBoxSettings({ box: { ...p(60), batteryReserve: 20 } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "report-policy-module-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedBoxes(db);
    const service = new ReportPolicy(db);
    const base = resolvePolicy(p(10), null, null, "TEST-1").version;
    assert.equal(
      resolvePolicy({ ...p(10), moduleLed: undefined }, null, null, "TEST-1").version,
      base
    );
    assert.notEqual(
      resolvePolicy({ ...p(10), moduleLed: false }, null, null, "TEST-1").version,
      base
    );
    assert.throws(() => validatePolicy({ ...p(10), moduleLed: "off" }));
    await service.save(["TEST-1"], "single", { ...p(10), moduleLed: false });
    const box = { id: "TEST-1", firmware: "1.0.8" };
    assert.match(
      (await service.packet(box, { link: 1 })).text,
      /^ok p=10 c=0 l=1 v=\d+ m=0 g=[01]\n$/
    );
    // rn=0（还在看 RDY 引脚）、没有 rn、或固件低于 1.0.8，都不能下发，否则 STM 会把模块当成断网
    assert.doesNotMatch((await service.packet(box, { link: 0 })).text, / m=/);
    assert.doesNotMatch((await service.packet(box)).text, / m=/);
    assert.doesNotMatch(
      (await service.packet({ ...box, firmware: "1.0.7" }, { link: 1 })).text,
      / m=/
    );
    await service.save(["TEST-1"], "single", { ...p(10), moduleLed: true });
    assert.match((await service.packet(box, { link: 1 })).text, / v=\d+ m=1 g=[01]\n$/);
    await service.save(["TEST-1"], "single", p(10));
    assert.doesNotMatch((await service.packet(box, { link: 1 })).text, / m=/);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("定位开关 g=：有进行中的任务或在充电时为 1，空闲没充电时为 0，放在确认行最末", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "report-gnss-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedBoxes(db);
    const service = new ReportPolicy(db);
    const box = { id: "TEST-1", firmware: "1.0.10", charge: 0 };
    assert.match((await service.packet(box)).text, / g=0\n$/);
    assert.match((await service.packet({ ...box, charge: 1 })).text, / g=1\n$/);
    assert.match((await service.packet({ ...box, charge: 2 })).text, / g=1\n$/);
    await db.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", ["TEST-1", "T1"]);
    assert.match((await service.packet(box)).text, / g=1\n$/);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

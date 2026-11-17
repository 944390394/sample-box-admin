import test from "node:test";
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
import { SampleController } from "../src/http/SampleController.js";
import { packet } from "./fixture.js";

test("删除保护、历史任务保留与权限隔离，同 IMEI 重新建档；进行中的上报不能复活旧档案", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-delete-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    cache = new MemoryStateCache(),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache,
      policies,
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const { box } = await ingest.accept(packet({ uart: "why=boot,pv=0,rp=5,rc=0,fw=1.0.5" }));
    const id = box.id;
    assert.equal((await ingest.deleteBox(box, () => true)).status, 409);
    await boxes.updateBox(id, (b) => {
      b.life = "在途";
    });
    assert.equal((await ingest.deleteBox(box, () => true)).status, 409);
    await boxes.updateBox(id, (b) => {
      b.life = "未使用";
      b.orgId = "D1";
    });
    assert.equal((await ingest.deleteBox(box, () => false)).status, 404);
    const task = await policies.createTask({
      name: "历史任务",
      kind: "采样",
      boxIds: [id],
      policy: null,
      overrides: {},
    });
    assert.equal((await ingest.deleteBox(box, () => true)).status, 409); // even before starting
    await policies.transition(task, "已取消");
    await policies.save([id], "single", { reportPeriodSec: 60, reportOnlyWhenCharging: false });
    const out = await policies.packet(box);
    await policies.sent(id, out.version);
    const c = new SampleController(boxes, policies);
    let response;
    await c.remove({
      params: { id },
      access: { perms: new Set() },
      fail: (_m, _c, status) => (response = status),
    });
    assert.equal(response, 403);
    let release, entered;
    const ready = new Promise((r) => (entered = r)),
      wait = new Promise((r) => (release = r));
    ingest.geocoder = {
      fill: async () => {
        entered();
        await wait;
        return true;
      },
    };
    const inflight = ingest.accept(packet());
    await ready;
    const deletion = ingest.deleteBox(box, () => true);
    release();
    await inflight;
    assert.ok((await deletion).deleted);
    assert.equal(await boxes.findById(id), null);
    assert.equal(await cache.get(id), null);
    await policies.sent(id, out.version); // late socket callback cannot recreate delivery
    for (const table of ["sample_uplink", "box_report_policy", "box_report_delivery"])
      assert.equal((await db.get(`SELECT COUNT(*) n FROM ${table} WHERE box_id=?`, [id])).n, 0);
    assert.ok(await db.get("SELECT * FROM sample_task WHERE id=?", [task]));
    assert.equal(
      (await db.get("SELECT * FROM sample_task_box WHERE task_id=?", [task])).box_id,
      id
    );
    const tasks = new ReportPolicyController(boxes, policies);
    const list = async (org) => {
      let r;
      await tasks.tasks({
        access: {
          perms: new Set(["device:box:task"]),
          scope: { all: false, orgIds: [org], ownerIds: [] },
        },
        query: {},
        ok: (x) => (r = x),
      });
      return r;
    };
    assert.equal((await list("D1")).total, 1);
    assert.equal((await list("D2")).total, 0);
    await assert.rejects(
      policies.createTask({
        name: "deleted",
        kind: "采样",
        boxIds: [id],
        policy: null,
        overrides: {},
      }),
      /删除/
    );
    await assert.rejects(policies.save([id], "single", null), /删除/);
    ingest.geocoder = null;
    const next = await ingest.accept(packet());
    // 编号是 IMEI，重新建档还是同一个编号；名称按序号重新起
    assert.equal(next.box.id, id);
    assert.equal(next.box.life, "待激活");
    assert.notEqual(next.box.name, box.name);
    await boxes.updateBox(next.box.id, (b) => {
      b.life = "停用";
    });
    assert.ok((await ingest.deleteBox(next.box, () => true)).deleted);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("内存仓储删除与 SQL 同语义，重建后为待激活", async () => {
  const { MemoryBoxStore } = await import("../src/store/MemoryBoxStore.js");
  const boxes = new MemoryBoxStore(),
    cache = new MemoryStateCache();
  const ingest = new IngestService({
    boxes,
    cache,
    hub: { publish() {} },
    clock: { now: () => new Date() },
    parser: new UplinkParser(),
  });
  const { box } = await ingest.accept(packet());
  assert.equal((await ingest.deleteBox(box, () => true)).status, 409); // 待激活
  await boxes.updateBox(box.id, (b) => {
    b.life = "未使用";
  });
  assert.equal((await ingest.deleteBox(box, () => false)).status, 404);
  assert.ok((await ingest.deleteBox(box, () => true)).deleted);
  assert.equal(await boxes.findById(box.id), null);
  assert.equal(await boxes.findByImei(box.imei), null);
  const next = await ingest.accept(packet());
  assert.equal(next.box.life, "待激活");
  assert.equal(next.box.id, box.id);
  assert.notEqual(next.box.name, box.name);
});

test("固件未知的新档案策略显示待首次上报，不是固件不支持", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-policy-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    const policies = new ReportPolicy(db);
    assert.equal((await policies.get({ id: "BOX-900", firmware: "" })).status, "待首次上报");
    assert.equal((await policies.get({ id: "BOX-900", firmware: "1.0.1" })).status, "固件不支持");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("删除并抹除：档案保留到设备确认，期间上报只收到抹除指令，boot 后删旧档案并重新建档", async () => {
  const { DeviceCommands } = await import("../src/settings/DeviceCommands.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-wipe-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    cache = new MemoryStateCache(),
    commands = new DeviceCommands(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache,
      commands,
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const up = (why, extra = "") =>
      packet({ uart: `why=${why},opens=3,pv=0,rp=5,rc=0,fw=1.0.6,seq=${extra || 7}` });
    const { box } = await ingest.accept(up("boot"));
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
    });
    const requested = await ingest.deleteBox(box, () => true, { wipe: "full", by: "u1" });
    assert.equal(requested.deleted, false);
    assert.equal(requested.wiping, true);
    const pending = await db.get("SELECT * FROM box_wipe_pending WHERE imei=?", [box.imei]);
    assert.equal(pending.mode, "full");
    assert.equal(pending.issued_at, null);
    assert.equal((await boxes.findByImei(box.imei)).id, box.id); // 档案还在
    // 抹除之前的上报不入库，只回抹除指令；s 就是这包的 seq
    const first = await ingest.accept(up("timer", "9"));
    assert.equal(first.box, null);
    assert.equal(first.downlink.text, "wipe m=f s=9\n");
    assert.equal((await boxes.findByImei(box.imei)).id, box.id);
    assert.equal((await commands.wipeStates([box.imei])).get(box.imei).issued, false);
    await first.downlink.onSent();
    assert.equal((await commands.wipeStates([box.imei])).get(box.imei).issued, true);
    // 重复上报继续回指令，档案仍在，直到设备重启后发出 opens=0 的 boot
    assert.equal((await ingest.accept(up("timer", "10"))).downlink.text, "wipe m=f s=10\n");
    assert.equal((await boxes.findByImei(box.imei)).id, box.id);
    const after = await ingest.accept(
      packet({ uart: "why=boot,opens=0,pv=0,rp=5,rc=0,fw=1.0.6,seq=1" })
    );
    assert.equal(after.box.life, "待激活");
    assert.equal(after.box.id, box.id);
    assert.equal((await boxes.list()).filter((item) => item.imei === box.imei).length, 1);
    assert.equal((await db.get("SELECT COUNT(*) n FROM box_wipe_pending")).n, 0);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("固件不支持远程抹除时不下发，直接重建", async () => {
  const { DeviceCommands, queueWipe } = await import("../src/settings/DeviceCommands.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-wipe-old-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    commands = new DeviceCommands(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      commands,
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    await queueWipe(db, { imei: "864317080992517", id: "BOX-001" }, "quick", "u1");
    const next = await ingest.accept(packet({ uart: "why=timer,opens=2,fw=1.0.5,seq=4" }));
    assert.equal(next.box.life, "待激活");
    assert.equal(next.downlink ?? null, null);
    assert.equal((await db.get("SELECT COUNT(*) n FROM box_wipe_pending")).n, 0);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("板子本机日志：查条数、确认范围、分段回传去重、不进上报流水且不回 ok", async () => {
  const { DeviceCommands } = await import("../src/settings/DeviceCommands.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-dump-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    commands = new DeviceCommands(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      commands,
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const line = (s) => packet({ uart: s });
    const { box } = await ingest.accept(line("why=boot,opens=1,fw=1.0.6,seq=1"));
    const req = await commands.createDump(box, "u1");
    assert.equal(req.state, "querying");
    const q = (await ingest.accept(line("why=timer,opens=1,fw=1.0.6,seq=2"))).downlink;
    assert.equal(q.text, "dump q s=2\n");
    await q.onSent();
    assert.equal(
      (await ingest.accept(line("why=timer,opens=1,fw=1.0.6,seq=3"))).downlink ?? null,
      null
    ); // 刚发过，不重复
    const info = await ingest.accept(line("why=dumpinfo,total=14,fw=1.0.6,seq=4"));
    assert.ok(info.silent);
    assert.equal((await commands.latestDump(box.id)).state, "ready");
    assert.equal(
      (await commands.confirmDump(box, req.id, { fromSec: 100, max: 50000 })).max_count,
      20000
    );
    const go = (await ingest.accept(line("why=timer,opens=1,fw=1.0.6,seq=5"))).downlink;
    assert.equal(go.text, `dump f=100 n=20000 s=5 r=${req.id}\n`);
    const part = (i, d) => line(`why=dump,r=${req.id},part=${i}/2,d=${d},fw=1.0.6,seq=${5 + i}`);
    assert.ok((await ingest.accept(part(1, "3:200:1;1:100:1"))).silent);
    await ingest.accept(part(1, "3:200:1;1:100:1")); // 重复的段丢弃
    assert.equal((await commands.view(await commands.latestDump(box.id))).state, "running");
    await ingest.accept(part(2, "4:300:2"));
    const view = await commands.view(await commands.latestDump(box.id));
    assert.equal(view.state, "done");
    assert.equal(view.receivedParts, 2);
    assert.deepEqual(
      (await commands.records(req.id)).map((r) => [r.kind, r.sec, r.opens]),
      [
        ["存活", 100, 1],
        ["上电", 200, 1],
        ["开箱", 300, 2],
      ]
    );
    assert.equal(
      (await db.get("SELECT COUNT(*) n FROM sample_uplink WHERE kind LIKE 'dump%'")).n,
      0
    );
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
    });
    assert.ok((await ingest.deleteBox(box, () => true)).deleted);
    assert.equal((await db.get("SELECT COUNT(*) n FROM box_dump_record")).n, 0);
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("删除接口：固件支持才登记待抹除，旧固件提示数据仍保留", async () => {
  const { DeviceCommands } = await import("../src/settings/DeviceCommands.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-wipe-ctl-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    commands = new DeviceCommands(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      commands,
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    const c = new SampleController(boxes);
    c.commands = commands;
    c.removeBox = (b, a, o) => ingest.deleteBox(b, a, o);
    const del = async (fw, imei) => {
      const { box } = await ingest.accept(
        packet({ imei, uart: `why=boot,opens=1,fw=${fw},seq=1` })
      );
      await boxes.updateBox(box.id, (b) => {
        b.life = "停用";
      });
      let out;
      await c.remove({
        params: { id: box.id },
        body: { wipe: "quick" },
        user: { id: "u1" },
        ok: (d, m) => (out = { d, m }),
        fail: (m) => (out = { error: m }),
      });
      return out;
    };
    const supported = await del("1.0.6", "864317080992517");
    assert.equal(supported.d.wipe, "quick");
    assert.equal(supported.d.wiping, true);
    assert.equal(supported.d.deleted, false);
    assert.equal(
      (await db.get("SELECT mode FROM box_wipe_pending WHERE imei=?", ["864317080992517"])).mode,
      "quick"
    );
    // 列表和详情带 wipe，页面据此显示「抹除中」
    let detail;
    await c.detail({
      params: { id: supported.d.id },
      ok: (d) => (detail = d),
      fail: (m) => (detail = { error: m }),
    });
    assert.equal(detail.wipe.mode, "quick");
    for (const query of [{}, { page: "1" }]) {
      let listed;
      await c.list({ query, ok: (d) => (listed = d), fail: (m) => (listed = { error: m }) });
      const rows = Array.isArray(listed) ? listed : listed.list;
      assert.equal(
        rows.find((item) => item.id === supported.d.id).wipe.mode,
        "quick",
        JSON.stringify(query)
      );
    }
    // 设备一直不上线时，再点一次不抹除的删除就能直接删掉，并撤销抹除请求
    let forced;
    await c.remove({
      params: { id: supported.d.id },
      body: {},
      user: { id: "u1" },
      ok: (d, m) => (forced = { d, m }),
      fail: (m) => (forced = { error: m }),
    });
    assert.equal(forced.d.deleted, true);
    assert.equal(
      await db.get("SELECT 1 FROM box_wipe_pending WHERE imei=?", ["864317080992517"]),
      undefined
    );
    const old = await del("1.0.5", "864317080992518");
    assert.equal(old.d.wipe, null);
    assert.match(old.m, /不支持远程抹除/);
    assert.equal(
      await db.get("SELECT 1 FROM box_wipe_pending WHERE imei=?", ["864317080992518"]),
      undefined
    );
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

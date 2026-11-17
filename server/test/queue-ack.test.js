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
import { QueueAck } from "../src/settings/QueueAck.js";
import { applyBoxSettings } from "../src/settings/boxConfig.js";
import { packet } from "./fixture.js";

async function harness(fn) {
  applyBoxSettings({
    box: { reportPeriodSec: 60, reportOnlyWhenCharging: false, batteryReserve: 20 },
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "queue-ack-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  const boxes = new SqlBoxStore(db),
    policies = new ReportPolicy(db);
  try {
    await migrate(db);
    const ingest = new IngestService({
      boxes,
      cache: new MemoryStateCache(),
      policies,
      queue: new QueueAck(db),
      hub: { publish() {} },
      clock: { now: () => new Date() },
      parser: new UplinkParser(),
    });
    await fn({ db, boxes, policies, ingest });
  } finally {
    await boxes.flush();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const up = (q, qe = 1, fw = "1.0.9") =>
  packet({ uart: `why=timer,opens=3,pv=0,rp=5,rc=0,fw=${fw},seq=${q},q=${q},qe=${qe}` });
const count = (db) => db.get("SELECT COUNT(*) n FROM sample_uplink").then((r) => Number(r.n));

test("事件入库与累计确认原子提交，写确认失败后重传只留下一个事件", async () => {
  await harness(async ({ db, ingest }) => {
    const lid = packet({ uart: "why=pad,opens=1,fw=1.0.17,seq=9,q=9,qe=1" });
    await db.exec(
      "CREATE TRIGGER fail_ack BEFORE INSERT ON box_ack BEGIN SELECT RAISE(ABORT,'injected ack failure'); END"
    );
    await assert.rejects(ingest.accept(lid), /injected ack failure/);
    assert.equal(await count(db), 0);
    await db.exec("DROP TRIGGER fail_ack");
    assert.equal((await ingest.accept(lid)).ack, 9);
    assert.equal(await count(db), 1);
    assert.equal((await ingest.accept(lid)).ack, 9);
    assert.equal(await count(db), 1);
  });
});

test("累计确认：顺序到达推进确认号，重复的不入库也不改状态，只回当前确认号", async () => {
  await harness(async ({ db, boxes, policies, ingest }) => {
    const first = await ingest.accept(up(10));
    assert.equal(first.ack, 10);
    assert.match(
      (await policies.packet(first.box, { ack: first.ack })).text,
      / a=10 v=\d+ g=[01]\n$/
    );
    assert.equal((await ingest.accept(up(11))).ack, 11);
    await boxes.flush();
    const rows = await count(db);
    const dup = await ingest.accept(up(10));
    assert.equal(dup.ack, 11);
    await boxes.flush();
    assert.equal(await count(db), rows);
  });
});

test("空洞：先到的序号先入库，缺的补齐后确认号一次跳过去；新队列代号重新计", async () => {
  await harness(async ({ db, boxes, ingest }) => {
    await ingest.accept(up(1));
    assert.equal((await ingest.accept(up(3))).ack, 1);
    assert.equal((await ingest.accept(up(4))).ack, 1);
    assert.equal((await ingest.accept(up(3))).ack, 1);
    assert.equal((await ingest.accept(up(2))).ack, 4);
    assert.equal((await ingest.accept(up(5))).ack, 5);
    await boxes.flush();
    assert.equal(await count(db), 5);
    // 队列清空后代号加一，序号从头开始，不会被当成重复
    assert.equal((await ingest.accept(up(1, 2))).ack, 1);
    assert.equal((await ingest.accept(up(2, 2))).ack, 2);
    await boxes.flush();
    assert.equal(await count(db), 7);
  });
});

test("旧固件或没有序号的上报不受影响；a= 只给 1.0.9 及以上", async () => {
  await harness(async ({ db, boxes, policies, ingest }) => {
    const old = await ingest.accept(
      packet({ uart: "why=timer,opens=3,pv=0,rp=5,rc=0,fw=1.0.8,seq=4" })
    );
    assert.equal(old.ack, undefined);
    assert.doesNotMatch((await policies.packet(old.box, { ack: 4 })).text, / a=/);
    const fresh = await ingest.accept(up(7));
    assert.match(
      (await policies.packet({ ...fresh.box, firmware: "1.0.8" }, { ack: 7 })).text,
      /^ok p=60 c=0 l=1 v=\d+ g=[01]\n$/
    );
    await boxes.flush();
    assert.equal(await count(db), 2);
  });
});

test("删除档案会清掉确认记录，同一设备再次上报按新队列计", async () => {
  await harness(async ({ db, boxes, ingest }) => {
    const { box } = await ingest.accept(up(50));
    await boxes.updateBox(box.id, (b) => {
      b.life = "未使用";
    });
    assert.ok((await ingest.deleteBox(box, () => true)).deleted);
    assert.equal(Number((await db.get("SELECT COUNT(*) n FROM box_ack")).n), 0);
    assert.equal((await ingest.accept(up(3))).ack, 3);
  });
});

test("空洞超过时限就放弃：设备在线直发后断电丢掉的记录补不回来，确认号不能一直卡住", async () => {
  await harness(async ({ db }) => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const queue = new QueueAck(db, { giveUpMs: 3 * 60 * 1000, now: () => now });
    const u = (q, qe = 1) => ({ imei: "864317080992517", q, qe });
    assert.equal(await queue.record(u(1)), 1);
    assert.equal(await queue.record(u(2)), 2);
    // 3、4 在设备断电时丢了
    assert.equal(await queue.record(u(5)), 2);
    now += 1 * 60 * 1000;
    assert.equal(await queue.record(u(6)), 2);
    assert.equal((await queue.seen(u(5))).dup, true);
    now += 3 * 60 * 1000;
    // 空洞已拖过 3 分钟：确认号跳过 3、4，并接着合并已到的 5、6、7
    assert.equal(await queue.record(u(7)), 7);
    assert.equal((await db.get("SELECT gap_since FROM box_ack")).gap_since, null);
    assert.equal(Number((await db.get("SELECT COUNT(*) n FROM box_ack_gap")).n), 0);
    // 放弃过的 3 后来真的补上来：第一次照常入库，再来一次才算重复
    assert.deepEqual(await queue.seen(u(3)), { dup: false, ack: 7, late: true });
    assert.equal(await queue.record(u(3)), 7);
    assert.equal((await queue.seen(u(3))).dup, true);
    // 4 一直没来，还留在放弃表里；从没放弃过的 5 再来是重复
    assert.equal((await queue.seen(u(4))).late, true);
    assert.equal((await queue.seen(u(5))).dup, true);
    assert.equal(await queue.record(u(8)), 8);
  });
});

test("开机跳号：boot 行带 qz，故意跳过的编号当作已到，确认号不会卡在空洞前面", async () => {
  await harness(async ({ db }) => {
    const queue = new QueueAck(db);
    const u = (q, extra = {}) => ({ imei: "864317080992517", q, qe: 1, ...extra });
    assert.equal(await queue.record(u(1)), 1);
    assert.equal(await queue.record(u(2)), 2);
    // 重启：落盘上限是 128，新编号从 256 起，boot 行带 qz=128
    assert.equal(await queue.record(u(256, { qz: 128 })), 2);
    // 128 之前真正丢的（3…128）还没补齐，确认号不能越过它们
    for (let q = 3; q <= 128; q++) await queue.record(u(q));
    assert.equal(await queue.record(u(257)), 257);
    assert.equal(Number((await db.get("SELECT COUNT(*) n FROM box_ack_gap")).n), 0);
    // 没有 qz 的普通跳号仍然按空洞处理
    assert.equal(await queue.record(u(300)), 257);
  });
});

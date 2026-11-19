/**
 * 派生上报种类（体检编号 L-P1-1）。
 *
 * 修复前的行为：BoxState.kindOf 会按 opens/lid/seq 的变化补判出 pad/shut/boot，
 * 但只有入库的日志种类用了它，其余地方读的是这一包的原始 why。连续上报的固件只发 why=timer，
 * 开箱、关箱、重启全藏在字段变化里，于是这些读 why 的分支对 timer 包永远不成立：
 * 采样任务的开箱录像不请求、重启后 box_report_delivery 不清、最后开箱时间不更新。
 *
 * 现在 BoxState.apply 开头把派生结果写回 uplink.kind，下游统一读它（没派生过时退回原始 why）。
 * 这里守住三条：
 * 1. 日志种类和摘要都按派生种类记，页面和任务轨迹不用再猜；
 * 2. 读事件的下游（开箱录像、重启清投递记录）对纯 timer 包也成立；
 * 3. 手动模式的原始 why 照旧算事件，向后兼容。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { BoxState } from "../src/domain/BoxState.js";
import { Uplink } from "../src/domain/Uplink.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { TaskVideoService } from "../src/settings/TaskVideoService.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const IMEI = "864317080900101";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uplink-kind-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  const boxes = new SqlBoxStore(db);
  const policies = new ReportPolicy(db);
  const platform = {
    calls: [],
    async requestRecording(req) {
      this.calls.push(req);
      return { status: "已请求", detail: "平台已受理", url: "https://video.example/v/1" };
    },
  };
  const videos = new TaskVideoService(db, platform);
  const ingest = new IngestService({
    boxes,
    policies,
    videos,
    cache: new MemoryStateCache(),
    hub: { publish() {} },
    clock: { now: () => new Date("2026-11-19T02:00:00Z") },
    parser: new UplinkParser(),
  });
  /** 采样任务勾了「需要录像」、箱子挂在单上、单子处于「采样中」：开箱就要请求录像。 */
  const startSamplingTask = async (boxId) => {
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at) VALUES (?,?,?,?,?,?)",
      [
        "task-1",
        "河道采样",
        "采样",
        "采样中",
        JSON.stringify({ recordVideo: true, org: "采样机构", orgId: "9" }),
        "2026-11-19 09:00:00",
      ]
    );
    await db.run("INSERT INTO sample_task_box (task_id,box_id) VALUES (?,?)", ["task-1", boxId]);
  };
  const send = async (uart, overrides = {}) =>
    (await ingest.accept(packet({ imei: IMEI, uart, ...overrides }))).record;
  /** 录像请求是异步发出的，轮询等平台回应写回，不靠固定 sleep。 */
  const until = async (check, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const videoRow = () =>
    db.get("SELECT task_id,opened_at,status,detail,url FROM sample_task_video WHERE box_id=?", [
      IMEI,
    ]);
  return { db, dir, boxes, platform, send, startSamplingTask, until, videoRow };
}

test("连续上报的开箱、关箱：日志种类、摘要和最后开箱时间都用派生值", async () => {
  const s = await setup();
  try {
    await s.send("why=timer,seq=10,opens=0,lid=0", { time: "2026-11-19 09:00:00" });
    const opened = await s.send("why=timer,seq=11,opens=1,lid=1", {
      time: "2026-11-19 09:05:00",
    });
    assert.equal(opened.kind, "pad", "opens 跳变要派生成开箱");
    assert.match(opened.summary, /^开箱上报/, "摘要不能还写「定时上报」");
    const box = await s.boxes.findById(IMEI);
    assert.equal(box.lastOpen, "2026-11-19 09:05:00", "派生开箱也要更新最后开箱时间");
    const closed = await s.send("why=timer,seq=12,opens=1,lid=0", { time: "2026-11-19 09:06:00" });
    assert.equal(closed.kind, "shut", "lid 从开到关要派生成关箱");
    assert.match(closed.summary, /^关箱上报/);
    // 没有事件发生的普通定时包仍是定时上报
    const plain = await s.send("why=timer,seq=13,opens=1,lid=0", { time: "2026-11-19 09:07:00" });
    assert.equal(plain.kind, "timer");
    assert.match(plain.summary, /^定时上报/);
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("连续上报的开箱会请求录像，seq 回绕的重启会清掉投递记录", async () => {
  const s = await setup();
  try {
    await s.send("why=timer,seq=10,opens=0,lid=0");
    await s.startSamplingTask(IMEI);
    await s.send("why=timer,seq=11,opens=1,lid=1", { time: "2026-11-19 09:20:00" });
    const row = await s.until(async () => {
      const item = await s.videoRow();
      return item && item.status !== "待请求" ? item : null;
    });
    assert.ok(row, "开箱录像没请求：连续上报的固件仍然不触发");
    assert.equal(row.task_id, "task-1");
    assert.equal(row.opened_at, "2026-11-19 09:20:00");
    assert.equal(row.status, "已请求");
    assert.equal(row.url, "https://video.example/v/1");
    assert.equal(s.platform.calls.length, 1);
    assert.equal(s.platform.calls[0].taskName, "河道采样");
    assert.equal(s.platform.calls[0].imei, IMEI);

    await s.db.run("INSERT INTO box_report_delivery (box_id,version,sent_at) VALUES (?,?,?)", [
      IMEI,
      "v1",
      "2026-11-19 09:20:00",
    ]);
    const reboot = await s.send("why=timer,seq=3,opens=1,lid=0");
    assert.equal(reboot.kind, "boot", "seq 回绕要派生成上电");
    const left = await s.db.get("SELECT COUNT(*) AS n FROM box_report_delivery WHERE box_id=?", [
      IMEI,
    ]);
    assert.equal(left.n, 0, "派生上电没清掉投递记录，策略就等不到重新生效");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("手动模式照旧：原始 why 本身就是事件，opens 没跳也认", async () => {
  const s = await setup();
  try {
    await s.send("why=timer,seq=10,opens=0,lid=0");
    await s.db.run("INSERT INTO box_report_delivery (box_id,version,sent_at) VALUES (?,?,?)", [
      IMEI,
      "v1",
      "2026-11-19 09:00:00",
    ]);
    // opens 不是 0，派生判不出上电，仍按原始 why 记
    const boot = await s.send("why=boot,seq=11,opens=2,lid=0");
    assert.equal(boot.kind, "boot");
    assert.match(boot.summary, /^上电上报/);
    assert.equal(
      (await s.db.get("SELECT COUNT(*) AS n FROM box_report_delivery WHERE box_id=?", [IMEI])).n,
      0,
      "原始 why=boot 仍要清投递记录"
    );
    await s.startSamplingTask(IMEI);
    // opens 没跳（还是 2），但这一包自己声明是开箱
    const open = await s.send("why=pad,seq=12,opens=2,lid=1", { time: "2026-11-19 09:30:00" });
    assert.equal(open.kind, "pad");
    assert.match(open.summary, /^开箱上报/);
    const row = await s.until(async () => {
      const item = await s.videoRow();
      return item && item.status !== "待请求" ? item : null;
    });
    assert.ok(row, "手动模式的开箱录像丢了");
    assert.equal((await s.boxes.findById(IMEI)).lastOpen, "2026-11-19 09:30:00");
  } finally {
    await s.db.close?.();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("R-12：apply 不就地改入参 uplink.kind，派生种类由返回值给出且每次重算", () => {
  const box = new BoxState({ id: IMEI, imei: IMEI, name: "测试箱", life: "未使用", opens: 0 });
  // 第一包建立前态（seq=10, opens=0, lid=0）：无前态可派生，退回原始 why=timer
  const first = new Uplink({ imei: IMEI, why: "timer", seq: 10, opens: 0, lid: 0 });
  const k1 = box.apply(first, new Date("2026-11-19T09:00:00Z"));
  assert.equal(k1, "timer");
  assert.equal(first.kind, undefined, "apply 不应就地写入参 kind");

  // 第二包 opens 跳变：派生为 pad，但入参对象的 kind/why 都不被改
  const second = new Uplink({ imei: IMEI, why: "timer", seq: 11, opens: 1, lid: 1 });
  const kindBefore = second.kind;
  const k2 = box.apply(second, new Date("2026-11-19T09:05:00Z"));
  assert.equal(k2, "pad", "opens 跳变要派生成开箱");
  assert.equal(second.kind, kindBefore, "调用后入参 kind 不变（R-12 核心断言）");
  assert.equal(second.kind, undefined, "入参 kind 始终未被写入");
  assert.equal(second.why, "timer", "原始 why 也不被改");
  assert.equal(box.lastSeq, 11, "apply 仍正常刷新箱子前态");

  // 同一个 uplink 对象复用到第二台无前态的箱子：每次按当前箱子前态重算，不沿用上一台的 pad
  const box2 = new BoxState({
    id: "864317080900102",
    imei: "864317080900102",
    name: "测试箱2",
    life: "未使用",
    opens: 0,
  });
  const k3 = box2.apply(second, new Date("2026-11-19T09:06:00Z"));
  assert.equal(k3, "timer", "复用到无前态箱子应重算为 timer，不带上上一台派生的 pad");
  assert.equal(second.kind, undefined, "复用后入参 kind 仍不被写");
});

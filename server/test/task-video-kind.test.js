/**
 * R27 开箱录像的 kind 口径回归（server/src/settings/TaskVideoService.js:27）。
 *
 * 出问题的地方：R23（迁移 060）把「采样＋送检」合并流的存储 kind 从「采样」改成了「采样后送检」，
 * 但录像这条 SQL 一直只认 `t.kind = '采样'`（这个文件最后一次改动 1c4877f3 早于 R23，没跟上改名）。
 * 结果新建的「采样后送检」单在采样现场开箱，服务器不再请录像——用户勾了「开箱录像」却什么都没发生。
 * 修法是 `t.kind IN ('采样','采样后送检')`，其余判定（recordVideo、计划地点半径、状态集合、per-open）一律不变。
 *
 * 这里钉死六条，全部走真实上报链路（IngestService → BoxState 派生 pad → TaskVideoService.onOpen），
 * 不直接调函数，免得把「派生 kind 才是 pad」这一层测丢了（先例：uplink-kind.test.js）：
 * 1. 采样后送检＋需要录像＋半径内开箱 → 记一条录像请求（回归本体，修前恒 null）；
 * 2. 同一张单第二次开箱 → 再记一条（per-open，不是每单只记首次）；
 * 3. 送检（无采样段）→ 不记；
 * 4. 仅本地采样（kind=采样＋localOnly）→ 照旧记，修的时候没把它一起窄掉；
 * 5. 没勾录像 → 不记；
 * 6. 开箱点不在计划地点误差范围内 → 不记。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDatabase, migrate } from "../db.js";
import { MemoryStateCache } from "../src/cache/MemoryStateCache.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { IngestService } from "../src/service/IngestService.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { TaskVideoService } from "../src/settings/TaskVideoService.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { packet } from "./fixture.js";

const IMEI = "864317080900202";
/** 计划地点（采样现场）：误差范围直接写进 body，绕开公司策略设置，测试不依赖系统默认值。 */
const PLACE = {
  address: "深圳市福田区梅林路 1 号采样点",
  lng: 114.0579,
  lat: 22.5431,
  radiusM: 200,
  orgId: "21",
};
/** 半径外的坐标：同一纬度上偏约 5km，远超 200m 误差范围。 */
const FAR = { lng: 114.1179, lat: 22.5431 };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-video-kind-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  const boxes = new SqlBoxStore(db);
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
    policies: new ReportPolicy(db),
    videos,
    cache: new MemoryStateCache(),
    hub: { publish() {} },
    clock: { now: () => new Date("2026-11-22T02:00:00Z") },
    parser: new UplinkParser(),
  });
  /**
   * 挂一张单在箱子上。kind/status/body 都直写，为的是能单独造出「kind 是唯一变量」的样本：
   * 例如送检那一条，状态故意给「采样中」——送检真实流程里没有这个状态，但录像 SQL 的
   * 状态集合是 IN ('待采样','采样中','已封箱')，只有这样才能证明判掉它的是 kind 而不是 status。
   */
  const task = async ({
    id = "task-1",
    kind,
    status = "采样中",
    body = {},
    createdAt = "2026-11-22 09:00:00",
  }) => {
    await db.run(
      "INSERT INTO sample_task (id,name,kind,status,body,created_at) VALUES (?,?,?,?,?,?)",
      [
        id,
        `${kind}单`,
        kind,
        status,
        JSON.stringify({ org: "华南分公司", orgId: "21", ...body }),
        createdAt,
      ]
    );
    await db.run("INSERT INTO sample_task_box (task_id,box_id) VALUES (?,?)", [id, IMEI]);
  };
  /** 定位包：先把箱子摆到计划地点（或半径外），不产生开箱事件。 */
  const locate = (at = PLACE) =>
    ingest.accept(
      packet({
        imei: IMEI,
        uart: "why=timer,seq=10,opens=0,lid=0",
        gpsfix: 1,
        lng: String(at.lng),
        lat: String(at.lat),
        time: "2026-11-22 09:10:00",
      })
    );
  /**
   * 开箱包：opens 从 0 跳到 1（第二次从 1 跳到 2）才派生成 pad，
   * 连续上报的固件只发 why=timer，这里刻意不带 why=pad，和现场一致。
   */
  const open = (seq, opens, at = PLACE, time = "2026-11-22 09:20:00") =>
    ingest.accept(
      packet({
        imei: IMEI,
        uart: `why=timer,seq=${seq},opens=${opens},lid=1`,
        gpsfix: 1,
        lng: String(at.lng),
        lat: String(at.lat),
        time,
      })
    );
  const rows = async () =>
    db.all(
      "SELECT id, task_id, box_id, opened_at, distance_m, status FROM sample_task_video WHERE box_id=? ORDER BY opened_at, id",
      [IMEI]
    );
  /** 录像的平台请求是 setImmediate 异步发的，轮询等写回，不靠固定 sleep。 */
  const until = async (check, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const clean = async () => {
    await boxes.flush();
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, dir, boxes, platform, task, locate, open, rows, until, clean };
}

test("采样后送检（R23 合并流）勾了录像，半径内开箱要记一条录像请求", async () => {
  const s = await setup();
  try {
    await s.locate();
    await s.task({ kind: "采样后送检", body: { recordVideo: true, placeAt: PLACE } });
    await s.open(11, 1);
    const rows = await s.rows();
    assert.equal(rows.length, 1, "采样后送检的开箱录像丢了：kind 改名后 SQL 还只认「采样」");
    assert.equal(rows[0].task_id, "task-1");
    assert.equal(rows[0].opened_at, "2026-11-22 09:20:00");
    assert.ok(Number(rows[0].distance_m) <= PLACE.radiusM, "半径内也要记距离，详情页要显示");
    const written = await s.until(async () => {
      const row = (await s.rows())[0];
      return row && row.status !== "待请求" ? row : null;
    });
    assert.ok(written, "录像请求没发给平台");
    assert.equal(written.status, "已请求");
    assert.equal(s.platform.calls.length, 1);
    assert.equal(s.platform.calls[0].imei, IMEI);
    assert.equal(s.platform.calls[0].taskName, "采样后送检单");
  } finally {
    await s.clean();
  }
});

test("同一张采样后送检单第二次开箱再记一条（每次开箱一次录像，不是每单一次）", async () => {
  const s = await setup();
  try {
    await s.locate();
    await s.task({ kind: "采样后送检", body: { recordVideo: true, placeAt: PLACE } });
    await s.open(11, 1, PLACE, "2026-11-22 09:20:00");
    // 关箱再开箱：opens 从 1 跳到 2 才算新的一次开箱
    await s.open(12, 1, PLACE, "2026-11-22 09:21:00");
    await s.open(13, 2, PLACE, "2026-11-22 09:30:00");
    // 等平台写回再收尾：不等待的话 setImmediate 的请求会打到已关的库上（只刷日志，不影响判定）
    const written = await s.until(async () => {
      const items = await s.rows();
      return items.length === 2 && items.every((row) => row.status !== "待请求") ? items : null;
    });
    assert.ok(written, "两次开箱的录像请求没都发给平台");
    assert.equal(written.length, 2, "开箱录像要按次记录，第二次开箱不能不录");
    assert.deepEqual(
      written.map((row) => row.opened_at),
      ["2026-11-22 09:20:00", "2026-11-22 09:30:00"]
    );
    assert.equal(written[0].task_id, "task-1");
    assert.equal(written[1].task_id, "task-1");
  } finally {
    await s.clean();
  }
});

test("送检单（仅寄送、没有采样段）开箱不记录像", async () => {
  const s = await setup();
  try {
    await s.locate();
    // status 故意用录像集合里的「采样中」，让 kind 成为唯一变量（见 setup.task 的说明）
    await s.task({ kind: "送检", status: "采样中", body: { recordVideo: true, placeAt: PLACE } });
    await s.open(11, 1);
    assert.equal((await s.rows()).length, 0, "送检没有采样现场开箱，不该触发录像");
    assert.equal(s.platform.calls.length, 0);
  } finally {
    await s.clean();
  }
});

test("仅本地采样（kind=采样＋localOnly）开箱照旧记录像", async () => {
  const s = await setup();
  try {
    await s.locate();
    await s.task({
      kind: "采样",
      body: { recordVideo: true, localOnly: true, placeAt: PLACE },
    });
    await s.open(11, 1);
    const written = await s.until(async () => {
      const items = await s.rows();
      return items.length === 1 && items[0].status !== "待请求" ? items : null;
    });
    assert.ok(written, "修 kind 集合时把本地采样一起窄掉了");
    assert.equal(written[0].task_id, "task-1");
  } finally {
    await s.clean();
  }
});

test("没勾「开箱录像」时不记录像", async () => {
  const s = await setup();
  try {
    await s.locate();
    await s.task({ kind: "采样后送检", body: { recordVideo: false, placeAt: PLACE } });
    await s.open(11, 1);
    assert.equal((await s.rows()).length, 0, "没勾录像也请求平台，等于替用户开摄像头");
  } finally {
    await s.clean();
  }
});

test("开箱点不在计划地点误差范围内时不记录像", async () => {
  const s = await setup();
  try {
    await s.locate(FAR);
    await s.task({ kind: "采样后送检", body: { recordVideo: true, placeAt: PLACE } });
    await s.open(11, 1, FAR);
    assert.equal((await s.rows()).length, 0, "半径外开箱不该录像");
  } finally {
    await s.clean();
  }
});

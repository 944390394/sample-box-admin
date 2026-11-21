/**
 * 上报记录页重构（R19）服务端回归。
 * 钉死：1) listLogs 页码分页边界（page 跳页/OFFSET、越界空页、游标优先、旧无参行为兼容）；
 *       2) 列裁剪不含 raw/raw_gz（列表与概览 SQL 都不取原文列，原文仍按主键单取）；
 *       3) uplinkSummary 一次 GROUP BY kind 聚合计数/MIN/MAX 电压/latest 正确（与 readMillivolts 互证）；
 *       4) 「仅看异常」行级口径＝低电压（阈值与 low flag 同源）或超限开箱行，列表与概览同口径；
 *       5) 导出 5 万行截断（响应头三件＋CSV 注释行）、列与表格一致、kind/anomaly 随筛选、范围错误 HTTP 400；
 *       6) 概览端点权限与列表同口径（事件码组合可查对应种类，全量要 device:box:log）＋路由注册事实。
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { migrate, openDatabase } from "../db.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import { readMillivolts } from "../src/domain/BatterySeries.js";
import { UplinkRecord } from "../src/domain/UplinkRecord.js";
import { SampleController } from "../src/http/SampleController.js";
import { MemoryBoxStore } from "../src/store/MemoryBoxStore.js";
import { SqlBoxStore, uplinkMvSql } from "../src/store/SqlBoxStore.js";
import { usableMv } from "../src/auth/boxAccess.js";
import { currentBoxSettings } from "../src/settings/boxConfig.js";

const BOX_ID = "864317080992517";
const RAW = gzipSync(Buffer.from('{"uart":"why=timer,aa55=0"}'));
const BASE = Date.parse("2026-11-20T10:00:00");
const at = (secOffset) => formatTimestamp(new Date(BASE + secOffset * 1000));
const WINDOW = { from: "2026-11-20 00:00:00", to: "2026-11-21 00:00:00" };

async function fresh() {
  const home = await mkdtemp(path.join(os.tmpdir(), "uplink-records-"));
  const db = await openDatabase({ dialect: "sqlite", sqlitePath: path.join(home, "t.db") }, home);
  await migrate(db);
  const store = new SqlBoxStore(db);
  return {
    db,
    store,
    home,
    async close() {
      await store.flush();
      await db.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 箱子当前行：PRAGMA 驱动补 NOT NULL 默认值（box-online-field.test.js 先例）。 */
async function insertBox(db, id = BOX_ID, extra = {}) {
  const info = await db.all("PRAGMA table_info(sample_box)");
  const vals = {
    id,
    imei: id,
    name: id,
    org: "总公司",
    life: "在途",
    last_report_at: at(0),
    bound_task_id: "",
    bound_task_at: "",
    activate_step: "等待激活",
    ...extra,
  };
  const cols = [];
  const params = [];
  for (const col of info) {
    if (col.name in vals) {
      cols.push(col.name);
      params.push(vals[col.name]);
    } else if (col.notnull === 1 && col.dflt_value == null && col.pk === 0) {
      cols.push(col.name);
      params.push(/int|real|num/i.test(col.type) ? 0 : "");
    }
  }
  await db.run(
    `INSERT INTO sample_box (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    params
  );
}

const summaryOf = (kind, mv, seq = 1, lid = "") => {
  const label =
    {
      timer: "定时上报",
      pad: "开箱上报",
      shut: "关箱上报",
      boot: "上电上报",
      chg: "充电上报",
      chgs: "充电状态",
      unknown: "设备上报",
    }[kind] || "设备上报";
  const parts = [label, `seq ${seq}`];
  if (mv != null) parts.push(`${(mv / 1000).toFixed(2)} V`);
  if (lid) parts.push(lid);
  return parts.join(" · ");
};

async function insertUplink(
  db,
  { box = BOX_ID, sec, kind = "timer", mv = 3800, seq = 1, lid = "", summary }
) {
  await db.run(
    "INSERT INTO sample_uplink (box_id, imei, received_at, device_time, kind, summary, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [box, box, at(sec), at(sec), kind, summary ?? summaryOf(kind, mv, seq, lid), RAW]
  );
}

function makeCtx(query = {}, access = null, params = { id: BOX_ID }) {
  return {
    query,
    params,
    access,
    ok(data) {
      this.data = data;
    },
    fail(msg, code = "A0001", status = 200) {
      this.error = { msg, code, status };
    },
    header(key, value) {
      (this.headers ??= {})[key] = value;
    },
    async download(name, chunks, headers) {
      this.downloadName = name;
      this.downloadHeaders = headers || {};
      let text = "";
      for await (const chunk of chunks) text += chunk;
      this.downloadText = text;
    },
  };
}

test("listLogs 页码分页：边界/越界空页/游标优先/旧无参行为兼容", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    // 120 条，秒级递增（时间互不相同，倒序稳定）
    for (let i = 0; i < 120; i++) await insertUplink(db, { sec: i, seq: i });
    const range = { ...WINDOW, limit: 50 };

    const p1 = await store.listLogs(BOX_ID, { ...range, page: 1 });
    assert.equal(p1.list.length, 50);
    assert.ok(p1.nextCursor, "第一页有下一页游标");
    assert.equal(p1.list[0].receivedAt, at(119), "倒序：最新在前");

    const p2 = await store.listLogs(BOX_ID, { ...range, page: 2 });
    assert.equal(p2.list.length, 50);
    assert.ok(p2.list[0].receivedAt < p1.list.at(-1).receivedAt, "第二页首行时间 < 第一页末行");

    const p3 = await store.listLogs(BOX_ID, { ...range, page: 3 });
    assert.equal(p3.list.length, 20);
    assert.equal(p3.nextCursor, null, "末页无游标");

    const p4 = await store.listLogs(BOX_ID, { ...range, page: 4 });
    assert.equal(p4.list.length, 0, "越界页给空列表");
    assert.equal(p4.nextCursor, null);

    // 非法页码回落第一页
    for (const page of [0, -3, "abc", 1.5]) {
      const got = await store.listLogs(BOX_ID, { ...range, page });
      assert.equal(got.list[0].receivedAt, at(119), `page=${page} 回落第一页`);
    }

    // 游标优先：带着第一页游标即使传 page=3 也走键集（第二页内容）
    const keyed = await store.listLogs(BOX_ID, {
      ...range,
      page: 3,
      cursorTime: p1.nextCursor.time,
      cursorId: p1.nextCursor.id,
    });
    assert.deepEqual(
      keyed.list.map((r) => r.id),
      p2.list.map((r) => r.id),
      "游标优先于页码"
    );

    // 旧无参行为兼容：不带 page/cursor 与第一页一致；limit 上限 100 不变
    const legacy = await store.listLogs(BOX_ID, WINDOW);
    assert.equal(legacy.list.length, 20, "缺省 limit 20");
    const legacy50 = await store.listLogs(BOX_ID, range);
    assert.deepEqual(
      legacy50.list.map((r) => r.id),
      p1.list.map((r) => r.id)
    );
    const clamped = await store.listLogs(BOX_ID, { ...WINDOW, limit: 500 });
    assert.equal(clamped.list.length, 100, "limit 硬顶 100");
  } finally {
    await env.close();
  }
});

test("列裁剪：列表与概览 SQL 都不取 raw/raw_gz，原文仍按主键单取", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    await insertUplink(db, { sec: 1 });
    const calls = [];
    const origAll = db.all.bind(db);
    db.all = async (sql, params) => {
      calls.push(String(sql));
      return origAll(sql, params);
    };
    const page = await store.listLogs(BOX_ID, WINDOW);
    await store.uplinkSummary(BOX_ID, WINDOW);
    await store.listLogs(BOX_ID, { ...WINDOW, anomaly: { lowMv: 3900, overOpen: true } });
    db.all = origAll;
    assert.ok(calls.length >= 3);
    for (const sql of calls) {
      assert.equal(/\braw\b/.test(sql), false, `SQL 不含 raw 列：${sql.slice(0, 120)}`);
      assert.equal(/raw_gz/.test(sql), false, "SQL 不含 raw_gz 列");
    }
    const item = page.list[0];
    assert.equal(Object.hasOwn(item.toListJSON(), "raw"), false, "列表 JSON 无 raw");
    assert.equal(item.raw, "", "行对象不带原文");
    const raw = await store.readRaw(BOX_ID, item.id, item.receivedAt);
    assert.equal(raw, '{"uart":"why=timer,aa55=0"}', "原文点开单取仍在");
  } finally {
    await env.close();
  }
});

test("uplinkSummary：GROUP BY kind 计数/MIN/MAX 电压/latest 正确，kind/时间窗同口径", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    const rows = [
      { sec: 1, kind: "timer", mv: 3700 },
      { sec: 2, kind: "timer", mv: 3800 },
      { sec: 3, kind: "timer", mv: 3900 },
      { sec: 4, kind: "pad", mv: 3600, lid: "开着" },
      { sec: 5, kind: "pad", mv: 4100, lid: "开着" },
      { sec: 6, kind: "shut", mv: 3650, lid: "关着" },
      { sec: 7, kind: "boot", mv: null },
      { sec: 8, kind: "chg", mv: 4150 },
      { sec: 9, kind: "chgs", mv: 4180 },
      { sec: 10, kind: "unknown", mv: null },
      // 有效区间外的电压（9.99 V）计入条数、不进 MIN/MAX（readMillivolts 同口径）
      { sec: 11, kind: "timer", summary: "定时上报 · seq 99 · 9.99 V" },
    ];
    for (const row of rows) await insertUplink(db, row);

    const all = await store.uplinkSummary(BOX_ID, WINDOW);
    assert.equal(all.total, 11);
    assert.deepEqual(all.kinds, {
      timer: 4,
      pad: 2,
      shut: 1,
      boot: 1,
      chg: 1,
      chgs: 1,
      unknown: 1,
    });
    assert.equal(all.minMv, 3600);
    assert.equal(all.maxMv, 4180);
    assert.equal(all.latest, at(11));

    // 与 JS 解析互证（两条实现路径同一口径）
    const listed = await store.listLogs(BOX_ID, { ...WINDOW, limit: 100 });
    const mvs = listed.list.map((r) => readMillivolts(r.summary)).filter((v) => v != null);
    assert.equal(all.minMv, Math.min(...mvs));
    assert.equal(all.maxMv, Math.max(...mvs));
    assert.equal(all.total, listed.list.length);

    const events = await store.uplinkSummary(BOX_ID, { ...WINDOW, kind: "pad,shut" });
    assert.equal(events.total, 3);
    assert.deepEqual(events.kinds, { pad: 2, shut: 1 });
    assert.equal(events.minMv, 3600);
    assert.equal(events.maxMv, 4100);

    const narrow = await store.uplinkSummary(BOX_ID, { from: at(4), to: at(6) });
    assert.equal(narrow.total, 3);
    assert.equal(narrow.latest, at(6));

    const empty = await store.uplinkSummary(BOX_ID, { from: at(100), to: at(200) });
    assert.deepEqual(empty, { total: 0, kinds: {}, minMv: null, maxMv: null, latest: "" });
  } finally {
    await env.close();
  }
});

test("仅看异常：低电压/超限开箱行级过滤，列表与概览同口径；控制器阈值与 low flag 同源", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db, BOX_ID, { opens: 3 });
    await insertUplink(db, { sec: 1, kind: "timer", mv: 3600 });
    await insertUplink(db, { sec: 2, kind: "timer", mv: 3700 });
    await insertUplink(db, { sec: 3, kind: "timer", mv: 3800 });
    await insertUplink(db, { sec: 4, kind: "pad", mv: 4000, lid: "开着" });
    await insertUplink(db, { sec: 5, kind: "shut", mv: 4000, lid: "关着" });

    // 存储层：阈值 3700（严格小于），3600 命中；3700 不命中
    const low = await store.listLogs(BOX_ID, {
      ...WINDOW,
      anomaly: { lowMv: 3700, overOpen: false },
    });
    assert.deepEqual(
      low.list.map((r) => r.receivedAt),
      [at(1)]
    );
    const lowSummary = await store.uplinkSummary(BOX_ID, {
      ...WINDOW,
      anomaly: { lowMv: 3700, overOpen: false },
    });
    assert.equal(lowSummary.total, 1);
    assert.equal(lowSummary.minMv, 3600);

    // overOpen：开箱行不论电压都算异常
    const both = await store.listLogs(BOX_ID, {
      ...WINDOW,
      anomaly: { lowMv: 3700, overOpen: true },
    });
    assert.deepEqual(
      both.list.map((r) => r.receivedAt),
      [at(4), at(1)]
    );
    const bothSummary = await store.uplinkSummary(BOX_ID, {
      ...WINDOW,
      anomaly: { lowMv: 3700, overOpen: true },
    });
    assert.equal(bothSummary.total, 2);

    // 控制器：anomaly=1 阈值＝usableMv(20, 全局预留)（low flag 同源）；
    // 未结束任务 maxOpens=2、opens_start=0、当前 opens=3 → 超限，开箱行并入
    const threshold = usableMv(20, currentBoxSettings().batteryReserve);
    await db.run(
      "INSERT INTO sample_task (id, name, kind, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["T-1", "采样单", "采样", "运送中", JSON.stringify({ maxOpens: 2, boxIds: [BOX_ID] }), at(0)]
    );
    await db.run("INSERT INTO sample_task_box (task_id, box_id, opens_start) VALUES (?, ?, ?)", [
      "T-1",
      BOX_ID,
      0,
    ]);
    const controller = new SampleController(store);
    const ctx = makeCtx({ ...WINDOW, anomaly: "1", limit: "100" });
    await controller.logs(ctx);
    assert.ok(!ctx.error, ctx.error?.msg);
    // 3600/3700/3800 与阈值比较（阈值≈3680：3600 命中、3700 不命中）；开箱行因超限命中
    const lowSecs = [1, 2, 3].filter((sec, i) => [3600, 3700, 3800][i] < threshold);
    const expectedTimes = [...lowSecs.map((sec) => at(sec)), at(4)].sort();
    assert.equal(
      ctx.data.list.length,
      lowSecs.length + 1,
      `低电 ${lowSecs.length} 行＋超限开箱 1 行`
    );
    assert.deepEqual(ctx.data.list.map((r) => r.time).sort(), expectedTimes);
    assert.ok(
      ctx.data.list.some((r) => r.kind === "pad"),
      "超限开箱行在列"
    );

    const sumCtx = makeCtx({ ...WINDOW, anomaly: "1" });
    await controller.uplinkSummary(sumCtx);
    assert.equal(sumCtx.data.total, ctx.data.list.length, "概览与列表同口径");
    assert.match(sumCtx.data.window.from, /^2026-11-20 00:00:00/);

    // 任务结束后不再算超限：只剩低电压行
    await db.run("UPDATE sample_task SET status = '已完成' WHERE id = 'T-1'");
    const after = makeCtx({ ...WINDOW, anomaly: "1", limit: "100" });
    await controller.logs(after);
    assert.equal(after.data.list.length, lowSecs.length);
    assert.equal(
      after.data.list.every((r) => r.kind !== "pad"),
      true
    );
  } finally {
    await env.close();
  }
});

test("概览权限与列表同口径：事件码组合可查对应种类，全量要 device:box:log；路由已注册", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    await insertUplink(db, { sec: 1, kind: "pad", mv: 3800 });
    await insertUplink(db, { sec: 2, kind: "timer", mv: 3800 });
    const controller = new SampleController(store);
    const eventOnly = { perms: new Set(["device:box:event-lid"]), scope: { all: true } };

    const okCtx = makeCtx({ ...WINDOW, kind: "pad" }, eventOnly);
    await controller.uplinkSummary(okCtx);
    assert.ok(!okCtx.error, "只有开箱事件码也能看开箱概览");
    assert.equal(okCtx.data.total, 1);
    assert.deepEqual(okCtx.data.kinds, { pad: 1 });

    const denied = makeCtx({ ...WINDOW }, eventOnly);
    await controller.uplinkSummary(denied);
    assert.equal(denied.error?.code, "A0301", "全量概览要 device:box:log");
    assert.equal(denied.error?.status, 403);

    const deniedLogs = makeCtx({ ...WINDOW }, eventOnly);
    await controller.logs(deniedLogs);
    assert.equal(deniedLogs.error?.code, "A0301", "列表同口径拒绝");

    const admin = makeCtx({ ...WINDOW });
    await controller.uplinkSummary(admin);
    assert.equal(admin.data.total, 2, "无 access（内部调用）不限");

    // 路由注册事实（operation-log-export.test.js 同款源码断言）
    const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
    const block = routes.match(
      /path: "\/api\/v1\/sample\/boxes\/:id\/uplinks\/summary",[\s\S]*?handler: \(ctx\) => useSample\(ctx, \(api\) => api\.uplinkSummary\(ctx\)\),/
    );
    assert.ok(block, "概览路由要注册");
    assert.match(block[0], /auth: true/);
  } finally {
    await env.close();
  }
});

test("导出：列与表格一致、kind/anomaly 随筛选、范围错误 HTTP 400、小表头三件", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    await insertUplink(db, { sec: 1, kind: "timer", mv: 3760, lid: "关着" });
    await insertUplink(db, { sec: 2, kind: "pad", mv: 3600, lid: "开着" });
    await db.run(
      "UPDATE sample_uplink SET lbs_lng = 114.1, lbs_lat = 22.6, gps_lng = 114.2, gps_lat = 22.7 WHERE kind = 'pad'"
    );
    const controller = new SampleController(store);

    const ctx = makeCtx({ ...WINDOW });
    await controller.exportLogs(ctx);
    assert.ok(!ctx.error, ctx.error?.msg);
    assert.equal(ctx.downloadHeaders["X-Export-Row-Count"], "2");
    assert.equal(ctx.downloadHeaders["X-Export-Truncated"], "0");
    assert.equal(ctx.downloadHeaders["X-Export-Max"], "50000");
    const lines = ctx.downloadText.split("\r\n").filter(Boolean);
    assert.equal(lines.length, 3, "表头＋2 行，未截断无注释行");
    assert.equal(
      lines[0].replace(/^\uFEFF/, ""),
      "时间,设备时间,类型,摘要,电压(V),箱盖,基站经度,基站纬度,GPS经度,GPS纬度"
    );
    assert.match(lines[1], /开箱上报/, "类型列用中文短名（与表格 tag 一致）");
    assert.match(lines[1], /3\.60,开,114\.1,22\.6,114\.2,22\.7/, "电压/箱盖/基站/GPS 分列");
    assert.match(
      lines[2],
      /定时上报,定时上报 · seq 1 · 3\.76 V · 关着,3\.76,关,,,,/,
      "无定位给空列"
    );
    assert.match(ctx.downloadName, /-上报日志-\d{4}-\d{2}-\d{2}\.csv$/);

    // kind 筛选随导出
    const kindCtx = makeCtx({ ...WINDOW, kind: "timer" });
    await controller.exportLogs(kindCtx);
    assert.equal(kindCtx.downloadHeaders["X-Export-Row-Count"], "1");
    assert.match(kindCtx.downloadText, /定时上报/);
    assert.equal(/开箱上报/.test(kindCtx.downloadText), false);

    // anomaly 筛选随导出（阈值 3700：3600 命中）
    const anomalyCtx = makeCtx({ ...WINDOW, anomaly: "1" });
    await controller.exportLogs(anomalyCtx);
    const threshold = usableMv(20, currentBoxSettings().batteryReserve);
    const want = [3760, 3600].filter((mv) => mv < threshold).length;
    assert.equal(anomalyCtx.downloadHeaders["X-Export-Row-Count"], String(want));

    // 范围错误：HTTP 400 + A0001（blob 通路按失败处理，#26 M-01 同规约）
    const bad = makeCtx({ from: "2026-01-01", to: "2026-03-01" });
    await controller.exportLogs(bad);
    assert.equal(bad.error?.status, 400);
    assert.equal(bad.error?.code, "A0001");
    assert.equal(bad.downloadText, undefined, "错误不下载");
  } finally {
    await env.close();
  }
});

test("导出截断：50001 行只出最近 50000 行，响应头与 CSV 注释行双标明", async () => {
  const env = await fresh();
  try {
    const { db, store } = env;
    await insertBox(db);
    // 分批多行 INSERT（参数数在 sqlite 变量上限内）：00:00:00 起每秒一条，共 50001
    const batch = 1000;
    const total = 50001;
    for (let start = 0; start < total; start += batch) {
      const count = Math.min(batch, total - start);
      const values = Array.from({ length: count }, () => "(?, ?, ?, ?, 'timer', ?, ?)").join(", ");
      const params = [];
      for (let i = 0; i < count; i++) {
        const sec = start + i;
        params.push(BOX_ID, BOX_ID, at(sec), at(sec), summaryOf("timer", 3800, sec), RAW);
      }
      await db.run(
        `INSERT INTO sample_uplink (box_id, imei, received_at, device_time, kind, summary, raw) VALUES ${values}`,
        params
      );
    }
    const controller = new SampleController(store);
    const ctx = makeCtx({ ...WINDOW });
    await controller.exportLogs(ctx);
    assert.ok(!ctx.error, ctx.error?.msg);
    assert.equal(ctx.downloadHeaders["X-Export-Truncated"], "1");
    assert.equal(ctx.downloadHeaders["X-Export-Row-Count"], "50000");
    assert.equal(ctx.downloadHeaders["X-Export-Max"], "50000");
    const lines = ctx.downloadText.split("\r\n").filter(Boolean);
    assert.equal(lines.length, 50002, "表头＋50000 行＋注释行");
    assert.match(lines.at(-1), /^# 已达单次导出上限 50000 行/);
    // 保留最近（DESC）的 50000 行：首行是最新一条
    assert.match(lines[1], new RegExp(at(total - 1).replace(/[.]/g, "\\.")));
  } finally {
    await env.close();
  }
});

test("MemoryBoxStore 同口径：kind/anomaly 过滤＋概览形状一致", async () => {
  const store = new MemoryBoxStore();
  const record = (sec, kind, mv) =>
    new UplinkRecord({
      boxId: BOX_ID,
      imei: BOX_ID,
      receivedAt: at(sec),
      deviceTime: at(sec),
      kind,
      summary: summaryOf(kind, mv),
      raw: "",
      lbsLng: null,
      lbsLat: null,
      gpsLng: null,
      gpsLat: null,
    });
  await store.appendLog(record(1, "timer", 3600));
  await store.appendLog(record(2, "timer", 3800));
  await store.appendLog(record(3, "pad", 4000));

  const all = await store.uplinkSummary(BOX_ID, WINDOW);
  assert.equal(all.total, 3);
  assert.deepEqual(all.kinds, { timer: 2, pad: 1 });
  assert.equal(all.minMv, 3600);
  assert.equal(all.maxMv, 4000);
  assert.equal(all.latest, at(3));

  const low = await store.listLogs(BOX_ID, { ...WINDOW, anomaly: { lowMv: 3700 } });
  assert.deepEqual(
    low.map((r) => r.receivedAt),
    [at(1)]
  );
  const withPad = await store.listLogs(BOX_ID, {
    ...WINDOW,
    anomaly: { lowMv: 3700, overOpen: true },
  });
  assert.deepEqual(
    withPad.map((r) => r.receivedAt),
    [at(3), at(1)]
  );
  const kindOnly = await store.listLogs(BOX_ID, { ...WINDOW, kind: "pad" });
  assert.deepEqual(
    kindOnly.map((r) => r.receivedAt),
    [at(3)]
  );
  const summaryLow = await store.uplinkSummary(BOX_ID, {
    ...WINDOW,
    anomaly: { lowMv: 3700, overOpen: true },
  });
  assert.equal(summaryLow.total, 2, "概览与列表同口径");
});

test("uplinkMvSql：SQLite 提取与 readMillivolts 互证（含 seq/箱盖/补传/无电压/越界）", async () => {
  const env = await fresh();
  try {
    const { db } = env;
    const samples = [
      "定时上报 · seq 709 · 4.15 V · 开着",
      "开箱上报 · seq 12 · 3.62 V · 开着 · 补传",
      "关箱上报 · 3.90 V · 关着",
      "上电上报 · seq 1",
      "设备上报",
      "定时上报 · seq 5 · 9.99 V",
      "充电状态 · seq 88 · 4.20 V · 关着",
      "3.76 V",
    ];
    const expr = uplinkMvSql("sqlite");
    for (const summary of samples) {
      const row = await db.get(`SELECT ${expr} AS mv FROM (SELECT ? AS summary)`, [summary]);
      const want = readMillivolts(summary);
      const raw = row.mv == null ? null : Math.round(Number(row.mv));
      // 有效区间由调用点判（与聚合/过滤的 BETWEEN 2500 AND 4500 一致）
      const got = raw != null && raw >= 2500 && raw <= 4500 ? raw : null;
      assert.equal(got, want, `「${summary}」提取 ${got} 应为 ${want}`);
    }
    // MySQL 分支形状：REGEXP_SUBSTR 提取、无匹配给 NULL（无 MySQL 实例，仅钉表达式形状）
    assert.match(uplinkMvSql("mysql"), /REGEXP_SUBSTR\(summary/);
  } finally {
    await env.close();
  }
});

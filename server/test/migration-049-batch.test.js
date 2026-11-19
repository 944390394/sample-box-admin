/**
 * 迁移 049 分批回填（R-9）。
 *
 * 049 把连续上报固件（why 全为 timer）里藏在字段变化中的开箱/关箱/上电/插拔充电器改判种类。
 * 修复前整体包在一个事务里全表重放；现在按 box_id 键集分页、每批 ≤500 行各自一个事务。
 * 这里守住三条：
 * 1. 派生规则与 BoxState.kindOf 一致（boot/pad/shut/chg），普通定时包仍是 timer；
 * 2. 超过一批（>500 行）时前态在批与批之间正确延续——跨批边界的事件照样派生；
 * 3. 幂等：只改判当前仍是 timer 的行，重跑不重复改判、不产生新变化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { compressRaw } from "../src/store/rawCodec.js";
import { up } from "../migrations/049_timer_event_kinds.js";
import { packet } from "./fixture.js";

const IMEI = "864317080900101";

/** 递增的接收时间字符串（与 ORDER BY received_at 同序），i 为秒偏移。 */
function stamp(i) {
  const total = 9 * 3600 + i;
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `2026-11-19 ${hh}:${mm}:${ss}.000`;
}

/** 直接写一条 kind=timer 的原文行（raw 压缩，与全新库 UplinkBatch 的 raw 模式同格式）。 */
async function insertTimer(exec, boxId, i, { seq, opens, lid, chg }) {
  const uart = `why=timer,seq=${seq},opens=${opens},lid=${lid},chg=${chg}`;
  const raw = packet({ imei: boxId, uart, time: stamp(i) });
  await exec.run(
    `INSERT INTO sample_uplink
       (box_id, imei, received_at, device_time, kind, summary, raw, lbs_lng, lbs_lat, gps_lng, gps_lat)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [boxId, boxId, stamp(i), "", "timer", "定时上报", compressRaw(raw), null, null, null, null]
  );
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-049-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  return { db, dir };
}

async function teardown(s) {
  await s.db.close?.();
  await rm(s.dir, { recursive: true, force: true });
}

const kindsOf = (db, boxId = IMEI) =>
  db.all("SELECT kind FROM sample_uplink WHERE box_id=? ORDER BY received_at, id", [boxId]);

test("R-9：049 派生 boot/pad/shut/chg，普通定时包仍是 timer，且重跑幂等", async () => {
  const s = await setup();
  try {
    const seq = [
      { seq: 10, opens: 0, lid: 0, chg: 0 }, // 无前态 → timer
      { seq: 11, opens: 1, lid: 1, chg: 0 }, // opens 跳变 → pad
      { seq: 12, opens: 1, lid: 0, chg: 0 }, // lid 开→关 → shut
      { seq: 13, opens: 1, lid: 0, chg: 1 }, // 插上充电器 → chg
      { seq: 3, opens: 1, lid: 0, chg: 1 }, // seq 回绕 → boot
      { seq: 4, opens: 1, lid: 0, chg: 1 }, // 无变化 → timer
    ];
    await s.db.transaction(async (tx) => {
      for (let i = 0; i < seq.length; i++) await insertTimer(tx, IMEI, i, seq[i]);
    });
    await up(s.db);
    assert.deepEqual(
      (await kindsOf(s.db)).map((r) => r.kind),
      ["timer", "pad", "shut", "chg", "boot", "timer"]
    );
    // 幂等：再跑一遍结果不变（事件行已不是 timer，不会被重复改判）
    await up(s.db);
    assert.deepEqual(
      (await kindsOf(s.db)).map((r) => r.kind),
      ["timer", "pad", "shut", "chg", "boot", "timer"]
    );
  } finally {
    await teardown(s);
  }
});

test("R-9：>500 行分多批，前态跨批延续，跨批边界事件照样派生且幂等", async () => {
  const s = await setup();
  try {
    const N = 1200; // 三批：0..499 / 500..999 / 1000..1199
    await s.db.transaction(async (tx) => {
      for (let i = 0; i < N; i++) {
        // opens 每 100 行跳一次 → i=100,200,...,1100 共 11 次开箱；seq 递增不触发 boot
        await insertTimer(tx, IMEI, i, { seq: i + 1, opens: Math.floor(i / 100), lid: 0, chg: 0 });
      }
    });
    await up(s.db);
    const rows = await s.db.all(
      "SELECT id, kind, received_at FROM sample_uplink WHERE box_id=? ORDER BY received_at, id",
      [IMEI]
    );
    assert.equal(rows.length, N);
    const padIdx = rows.map((r, i) => (r.kind === "pad" ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(
      padIdx,
      [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
      "每 100 行的 opens 跳变都要派生成 pad"
    );
    // 第 500 行是第二批首行，其前态（opens=4）来自第一批末行——跨批延续正确才判得出 pad
    assert.equal(rows[500].kind, "pad", "跨批边界的事件丢了说明前态没延续");
    assert.equal(rows[499].kind, "timer");
    // 幂等：重跑不新增/不改判
    await up(s.db);
    const again = await kindsOf(s.db);
    assert.equal(again.filter((r) => r.kind === "pad").length, 11);
    assert.equal(again.filter((r) => r.kind === "timer").length, N - 11);
  } finally {
    await teardown(s);
  }
});
